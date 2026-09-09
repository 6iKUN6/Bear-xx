import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StreamTaskType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { validateFlowDefinition } from '../agent-flow/definition/flow-definition.validator';
import type {
  TestExecutionModelSnapshotDto,
  TestExecutionNodeModelDto,
  TestMessageExecutionDto,
  TestSessionDetailDto,
  TestSessionDto,
} from './dto/agent-test.dto';

interface ModelNodeDeclaration {
  nodeId: string;
  nodeName: string | null;
  nodeType: string;
  source: 'agent-default' | 'explicit';
  presetId: string;
}

interface ModelPresetDisplayMetadata {
  presetId: string;
  name: string;
  model: string;
  connection: { providerKey: string };
}

/**
 * admin 测试会话管理（只操作 isTest=true 的会话）
 * @description 按 userId + isTest 双重隔离：每个 admin 只见自己的测试会话，
 * 端侧列表已过滤 isTest，测试记录不污染任何用户的正常聊天。
 */
@Injectable()
export class AgentTestSessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** 测试会话列表（按更新时间倒序，带最后消息预览与消息数） */
  async list(userId: string): Promise<TestSessionDto[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: { userId, isTest: true },
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true },
        },
        _count: { select: { messages: true } },
      },
    });

    return conversations.map((c) => ({
      id: c.id,
      title: c.title,
      lastMessage:
        c.messages[0]?.content.replace(/\s+/g, ' ').slice(0, 50) ?? '',
      messageCount: c._count.messages,
      updatedAt: c.updatedAt.getTime(),
    }));
  }

  /** 测试会话详情：消息 + 每条消息的执行轨迹（复用 conversation-trace 已落库数据） */
  async detail(userId: string, id: string): Promise<TestSessionDetailDto> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId, isTest: true },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            turnTraceItems: { orderBy: { sequence: 'asc' } },
            streamTasks: {
              where: {
                userId,
                isTest: true,
                type: StreamTaskType.CHAT_COMPLETION,
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                id: true,
                status: true,
                resolvedAgentModelPresetId: true,
                flowDigest: true,
                flowVersion: {
                  select: {
                    id: true,
                    version: true,
                    definition: true,
                    flow: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException('测试会话不存在');
    }

    const declarationsByVersionId = new Map<string, ModelNodeDeclaration[]>();
    const presetIds = new Set<string>();
    for (const message of conversation.messages) {
      const task = message.streamTasks[0];
      if (!task?.flowVersion || !task.flowDigest) continue;
      if (task.resolvedAgentModelPresetId) {
        presetIds.add(task.resolvedAgentModelPresetId);
      }
      const declarations = this.readModelNodeDeclarations(
        task.flowVersion.definition,
      );
      declarationsByVersionId.set(task.flowVersion.id, declarations);
      declarations.forEach((item) => {
        if (item.source === 'explicit') presetIds.add(item.presetId);
      });
    }

    const modelPresets =
      presetIds.size === 0
        ? []
        : await this.prisma.modelPreset.findMany({
            where: { presetId: { in: [...presetIds] } },
            select: {
              presetId: true,
              name: true,
              model: true,
              connection: { select: { providerKey: true } },
            },
          });
    const modelsById = new Map(
      modelPresets.map((preset) => [preset.presetId, preset]),
    );

    return {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt.getTime(),
      messages: conversation.messages.map((m) => ({
        id: m.id,
        role: m.role.toLowerCase(),
        content: m.content,
        agentId: m.agentId,
        status: m.status.toLowerCase(),
        createdAt: m.createdAt.getTime(),
        execution: this.toExecutionSnapshot(
          m.streamTasks[0],
          declarationsByVersionId,
          modelsById,
        ),
        trace: m.turnTraceItems.map((item) => ({
          id: item.id,
          type: item.type,
          status: item.status,
          title: item.title,
          summary: item.summary,
          detail: item.detail,
          toolName: item.toolName,
          parentId: item.parentId,
          depth: item.depth,
          nodeKey: item.nodeKey,
          mcpServer: item.mcpServer,
          mcpTool: item.mcpTool,
          inputSummary: this.readJsonObject(item.inputSummary),
          outputSummary: this.readJsonObject(item.outputSummary),
          error: this.readJsonObject(item.error),
          metrics: this.readJsonObject(item.metrics),
          startedAt: item.startedAt?.getTime() ?? null,
          endedAt: item.endedAt?.getTime() ?? null,
          createdAt: item.createdAt.getTime(),
          durationMs: item.durationMs,
          sequence: item.sequence,
        })),
      })),
    };
  }

  /** 删除测试会话（消息/任务/trace 由 schema 级联清理） */
  async remove(userId: string, id: string): Promise<void> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId, isTest: true },
      select: { id: true },
    });
    if (!conversation) {
      throw new NotFoundException('测试会话不存在');
    }
    await this.prisma.conversation.delete({ where: { id } });
  }

  /**
   * 将测试任务转换为可展示的执行快照
   * @param task assistant 消息关联的最新测试聊天任务
   * @param declarationsByVersionId 已按 FlowVersion 解析的模型节点声明
   * @param modelsById 当前仍存在的模型预设展示元数据
   * @returns 返回任务冻结的 Flow 与模型快照；缺少完整 Flow 快照时返回 null
   * @description Flow 版本、摘要和默认模型来自任务冻结字段，名称等友好信息允许读取当前元数据。
   */
  private toExecutionSnapshot(
    task:
      | {
          id: string;
          status: string;
          resolvedAgentModelPresetId: string | null;
          flowDigest: string | null;
          flowVersion: {
            id: string;
            version: number;
            definition: Prisma.JsonValue;
            flow: { id: string; name: string };
          } | null;
        }
      | undefined,
    declarationsByVersionId: ReadonlyMap<string, ModelNodeDeclaration[]>,
    modelsById: ReadonlyMap<string, ModelPresetDisplayMetadata>,
  ): TestMessageExecutionDto | null {
    if (!task?.flowVersion || !task.flowDigest) return null;

    const toModel = (presetId: string): TestExecutionModelSnapshotDto => {
      const metadata = modelsById.get(presetId);
      return {
        presetId,
        name: metadata?.name ?? null,
        model: metadata?.model ?? null,
        providerKey: metadata?.connection.providerKey ?? null,
      };
    };
    const nodeModels: TestExecutionNodeModelDto[] = (
      declarationsByVersionId.get(task.flowVersion.id) ?? []
    ).map((item) => {
      const presetId =
        item.source === 'explicit'
          ? item.presetId
          : (task.resolvedAgentModelPresetId ?? 'agent-default');
      return {
        nodeId: item.nodeId,
        nodeName: item.nodeName,
        nodeType: item.nodeType,
        source: item.source,
        model: toModel(presetId),
      };
    });

    return {
      taskId: task.id,
      taskStatus: task.status.toLowerCase(),
      flow: {
        id: task.flowVersion.flow.id,
        name: task.flowVersion.flow.name,
        versionId: task.flowVersion.id,
        version: task.flowVersion.version,
        digest: task.flowDigest,
      },
      agentDefaultModel: task.resolvedAgentModelPresetId
        ? toModel(task.resolvedAgentModelPresetId)
        : null,
      nodeModels,
    };
  }

  /**
   * 解析 Flow Definition 中会实际发起模型调用的节点配置
   * @param definition 任务锁定的不可变 Flow Definition
   * @returns 返回各模型节点声明的预设标识和来源
   * @description 历史工件不兼容当前契约时返回空数组，避免展示增强阻断整个测试会话详情。
   */
  private readModelNodeDeclarations(
    definition: Prisma.JsonValue,
  ): ModelNodeDeclaration[] {
    const parsed = validateFlowDefinition(definition);
    if (!parsed.success) return [];

    const declarations: ModelNodeDeclaration[] = [];
    for (const node of parsed.definition.nodes) {
      const declaredPresetId =
        node.type === 'agent'
          ? node.config.modelPreset
          : node.type === 'plan'
            ? node.config.modelPreset
            : node.type === 'plan-loop'
              ? node.config.executor.modelPreset
              : node.type === 'approval' && node.config.policy === 'model'
                ? node.config.modelPreset
                : node.type === 'synthesize'
                  ? node.config.modelPreset
                  : undefined;
      const source =
        declaredPresetId && declaredPresetId !== 'agent-default'
          ? 'explicit'
          : 'agent-default';
      const presetId =
        source === 'explicit' ? declaredPresetId : 'agent-default';
      if (!presetId) continue;
      if (
        node.type !== 'agent' &&
        node.type !== 'plan' &&
        node.type !== 'plan-loop' &&
        node.type !== 'synthesize' &&
        !(node.type === 'approval' && node.config.policy === 'model')
      ) {
        continue;
      }
      declarations.push({
        nodeId: node.id,
        nodeName: node.name ?? null,
        nodeType: node.type,
        source,
        presetId,
      });
    }
    return declarations;
  }

  /**
   * 将 Prisma JSON 值收敛为可安全透出的对象
   * @param value trace 字段中持久化的 Prisma JSON 值
   * @returns 返回浅拷贝后的对象；标量、数组和空值返回 null
   * @description 测试台与任务详情共享 trace 语义，只允许对象结构进入详情面板。
   */
  private readJsonObject(
    value: Prisma.JsonValue | null,
  ): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return Object.fromEntries(Object.entries(value));
  }
}
