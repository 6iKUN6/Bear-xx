import { BadRequestException, Injectable } from '@nestjs/common';
import { ConversationType, MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { describeToolGroups } from '../ai/agent-loop/capability/tool-group-labels';
import { groupContextPrompt } from '../../prompts';
import { resolveBoundFlowToolGroups } from '../agent-flow/definition/flow-tool-groups';
import type { LlmMessage } from '../llm/llm.types';
import {
  ConversationSummaryService,
  summarySourceDigest,
  type ConversationSummaryValue,
} from './conversation-summary.service';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import {
  estimateContextTokens,
  estimateContextTextTokens,
} from './context-budget';

export interface ChatContextOptions {
  modelPreset?: string;
  /** 完整节点提示词、工具定义、上游结果等固定输入的预算。 */
  reservedTokens?: number;
  onSummaryModelCall?: () => void | Promise<void>;
}

export interface ChatContextBundle {
  messages: LlmMessage[];
  summary?: {
    content: string;
    latestMessageId?: string;
    messageCount: number;
  };
  recentWindow: {
    limit: number;
    messageCount: number;
  };
}

@Injectable()
export class ChatContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationSummaryService: ConversationSummaryService,
    private readonly modelRegistry: LlmModelRegistryService,
  ) {}

  /**
   * 构建聊天上下文消息列表
   * @param conversationId 会话ID
   * @param pendingMessageId 当前待生成的 assistant 消息ID
   * @returns 返回可直接传给 LLM 的上下文消息列表
   * @description 使用任务固定的消息范围与模型预算，需要时生成或复用摘要。
   */
  async buildChatMessages(
    conversationId: string,
    pendingMessageId: string,
    answeringAgentId?: string | null,
  ): Promise<LlmMessage[]> {
    const bundle = await this.buildContextBundle(
      conversationId,
      pendingMessageId,
      answeringAgentId,
    );
    return bundle.messages;
  }

  /**
   * 构建聊天上下文包
   * @param conversationId 会话ID
   * @param pendingMessageId 当前待生成的 assistant 消息ID
   * @param answeringAgentId 本轮回答者智能体 id；null/undefined = 默认助手
   * @param options 节点模型、固定输入预算与摘要计费回调
   * @returns 返回包含 LLM 消息、摘要信息和最近窗口信息的上下文包
   * @description 按节点模型预算组装冻结历史，达到 80% 时压缩较早消息。群聊会话（历史中存在其它智能体的发言）时做身份感知转写：
   * 回答者自己的消息保持 assistant 角色，其它智能体的消息转写为带署名的 user 侧记录，
   * 避免模型把别的助手说过的话当成自己说的。单助手会话路径与原实现完全一致。
   */
  async buildContextBundle(
    conversationId: string,
    pendingMessageId: string,
    answeringAgentId?: string | null,
    options: ChatContextOptions = {},
  ): Promise<ChatContextBundle> {
    const task = await this.prisma.streamTask.findFirst({
      where: { conversationId, messageId: pendingMessageId },
      select: { contextMessageIds: true },
    });
    if (!task?.contextMessageIds.length) {
      throw new BadRequestException('任务缺少会话历史快照，请重新发送消息');
    }
    const limits = this.modelRegistry.getContextLimits(options.modelPreset);
    const inputLimit =
      limits.contextWindowTokens -
      limits.maxOutputTokens -
      Math.max(256, Math.ceil(limits.contextWindowTokens * 0.05)) -
      (options.reservedTokens ?? 0);
    if (inputLimit < 1024)
      throw new BadRequestException(
        '节点指令、工具和输出预留已占满模型上下文，请缩小输入或使用容量更大的模型',
      );
    const rows = await this.prisma.message.findMany({
      where: { conversationId, id: { in: task.contextMessageIds } },
      select: {
        id: true,
        role: true,
        content: true,
        agentId: true,
        modelContext: true,
      },
    });
    const byId = new Map(rows.map((message) => [message.id, message]));
    const orderedMessages = task.contextMessageIds.map((id) => {
      const message = byId.get(id);
      if (!message)
        throw new BadRequestException('任务历史快照中的消息已不存在');
      return message;
    });
    const currentAgentId = answeringAgentId ?? null;

    // 历史里出现过的其它发言者（null 视为默认助手，同一身份）
    const foreignAgentIds = new Set(
      orderedMessages
        .filter(
          (m) =>
            m.role === MessageRole.ASSISTANT &&
            (m.agentId ?? null) !== currentAgentId,
        )
        .map((m) => m.agentId ?? null),
    );

    // 群语境判定以「会话形态」为准，不能只看历史里有没有别人发过言：
    // 群聊第一条消息时历史为空，若按历史判定就不会注入身份说明，模型不知道
    // 自己是谁、群里还有谁，会出现冒充其它成员的幻觉。历史判定作为旧数据
    // （无 type 的会话）的兜底保留。
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { type: true, agentIds: true },
    });
    const isGroupContext =
      conversation?.type === ConversationType.GROUP || foreignAgentIds.size > 0;

    const agentNameById = isGroupContext
      ? await this.loadAgentNames(foreignAgentIds)
      : new Map<string | null, string>();

    const contextMessages: LlmMessage[] = [];

    if (isGroupContext) {
      contextMessages.push({
        role: 'system',
        content: await this.formatGroupContextMessage(
          currentAgentId,
          conversation?.agentIds ?? [],
        ),
      });
    }

    const historyMessages: LlmMessage[] = orderedMessages.map((message) => {
      if (
        isGroupContext &&
        message.role === MessageRole.ASSISTANT &&
        (message.agentId ?? null) !== currentAgentId
      ) {
        // 其它智能体的发言：转写为带署名的 user 侧记录，让模型知道这是群里别人说的。
        const name = agentNameById.get(message.agentId ?? null) ?? '助手';
        return {
          role: 'user' as const,
          content: `[助手·${name}]: ${message.content}`,
        };
      }
      return {
        role: this.toLlmMessageRole(message.role),
        content: message.content,
        ...(message.role === MessageRole.ASSISTANT && message.modelContext
          ? { modelContext: message.modelContext }
          : {}),
      };
    });
    let messages = [...contextMessages, ...historyMessages];
    let summary: ConversationSummaryValue | null = null;
    let retainedCount = historyMessages.length;
    const trigger = Math.floor(inputLimit * 0.8);
    if (estimateContextTokens(messages) > trigger) {
      const summaryTokens = Math.max(
        128,
        Math.min(2048, limits.maxOutputTokens, Math.floor(inputLimit * 0.08)),
      );
      const existing =
        await this.conversationSummaryService.getConversationSummary(
          conversationId,
        );
      const prefixLength = existing?.messageCount ?? 0;
      const canReuse =
        existing &&
        prefixLength > 0 &&
        prefixLength < orderedMessages.length &&
        existing.sourceDigest ===
          summarySourceDigest(orderedMessages.slice(0, prefixLength)) &&
        orderedMessages[prefixLength].role === MessageRole.USER &&
        estimateContextTextTokens(existing.summary) <= summaryTokens * 2;
      const withSummary = (
        value: ConversationSummaryValue,
        offset: number,
      ): LlmMessage[] => [
        ...contextMessages,
        {
          role: 'system',
          content: this.formatSummaryContextMessage(value.summary),
        },
        ...historyMessages.slice(offset),
      ];
      if (
        canReuse &&
        estimateContextTokens(withSummary(existing, prefixLength)) <= trigger
      ) {
        summary = existing;
        messages = withSummary(existing, prefixLength);
        retainedCount = historyMessages.length - prefixLength;
      } else {
        // 截取点必须落在用户消息处，整组保留工具往返；本轮输入始终完整保留。
        let offset = orderedMessages.length - 1;
        if (orderedMessages[offset].role !== MessageRole.USER)
          throw new BadRequestException('任务上下文末尾不是本轮用户消息');
        const target = Math.floor(inputLimit * 0.5) - summaryTokens * 2 - 200;
        for (let index = offset - 1; index >= 0; index--) {
          if (orderedMessages[index].role !== MessageRole.USER) continue;
          if (
            estimateContextTokens([
              ...contextMessages,
              ...historyMessages.slice(index),
            ]) > target
          )
            break;
          offset = index;
        }
        const tailTokens = estimateContextTokens([
          ...contextMessages,
          ...historyMessages.slice(offset),
        ]);
        if (
          tailTokens > inputLimit ||
          (offset > 0 && tailTokens + summaryTokens * 2 + 200 > inputLimit)
        ) {
          throw new BadRequestException(
            '本轮输入超过模型可用上下文，请拆分内容或切换容量更大的模型',
          );
        }
        if (offset > 0) {
          summary =
            await this.conversationSummaryService.refreshConversationSummary(
              conversationId,
              orderedMessages.slice(0, offset),
              {
                modelPreset: limits.modelPreset,
                maxOutputTokens: summaryTokens,
                onModelCall: options.onSummaryModelCall,
              },
            );
          if (!summary) throw new Error('会话摘要生成失败');
          messages = withSummary(summary, offset);
          retainedCount = historyMessages.length - offset;
        }
      }
    }
    const inputTokens = estimateContextTokens(messages);
    if (inputTokens > inputLimit)
      throw new BadRequestException('压缩后的会话仍超出模型上下文，请拆分内容');
    return {
      messages,
      summary: summary
        ? {
            content: summary.summary,
            latestMessageId: summary.latestMessageId ?? undefined,
            messageCount: summary.messageCount,
          }
        : undefined,
      recentWindow: {
        limit: task.contextMessageIds.length,
        messageCount: retainedCount,
      },
    };
  }

  /**
   * 批量加载智能体显示名
   * @param agentIds 其它发言者 id 集合（可含 null=默认助手）
   * @returns 返回 id → 名称映射；null 键映射到默认智能体名（查不到则“默认助手”）
   */
  private async loadAgentNames(
    agentIds: Set<string | null>,
  ): Promise<Map<string | null, string>> {
    const nameById = new Map<string | null, string>();
    const concreteIds = [...agentIds].filter((id): id is string => id !== null);

    if (concreteIds.length > 0) {
      const agents = await this.prisma.agent.findMany({
        where: { id: { in: concreteIds } },
        select: { id: true, name: true },
      });
      for (const agent of agents) {
        nameById.set(agent.id, agent.name);
      }
    }

    if (agentIds.has(null)) {
      const defaultAgent = await this.prisma.agent.findFirst({
        where: { isDefault: true },
        select: { name: true },
      });
      nameById.set(null, defaultAgent?.name ?? '默认助手');
    }

    return nameById;
  }

  /**
   * 群聊语境说明
   * @param currentAgentId 本轮回答者 id（null = 默认助手）
   * @param memberIds 群成员 id 列表（可空：旧数据无成员表时只给通用规则）
   * @returns 返回注入 LLM 的 system 消息内容
   * @description 静态规则来自 prompts/group-context.md，这里补上动态花名册：
   * 「你是谁 + 你的专长」与「群里还有谁 + 各自专长」。缺了这两段，模型在群聊
   * 首条消息时既不知道自己的身份也不知道同伴，容易自称成别的成员。
   */
  private async formatGroupContextMessage(
    currentAgentId: string | null,
    memberIds: string[],
  ): Promise<string> {
    const sections = [groupContextPrompt];
    const roster = await this.loadGroupRoster(memberIds, currentAgentId);

    if (roster.self) {
      sections.push(
        `## 你的身份\n你是「${roster.self.name}」，专长：${roster.self.capability}。`,
      );
    }
    if (roster.others.length > 0) {
      const lines = roster.others
        .map((member) => `- ${member.name}：${member.capability}`)
        .join('\n');
      sections.push(`## 群内其它成员\n${lines}`);
    }

    return sections.join('\n\n');
  }

  /**
   * 加载群成员花名册
   * @returns 返回本轮回答者自身信息与其它成员信息（含中文能力描述）
   * @description 能力用 describeToolGroups 译成中文语义（image-gen 这类技术标识
   * 对模型语义太弱）；简介存在时并入能力描述，便于模型判断该不该接这个需求。
   */
  private async loadGroupRoster(
    memberIds: string[],
    currentAgentId: string | null,
  ): Promise<{
    self?: { name: string; capability: string };
    others: Array<{ name: string; capability: string }>;
  }> {
    const ids = [...new Set(memberIds)];
    if (ids.length === 0) {
      return { others: [] };
    }

    const agents = await this.prisma.agent.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        description: true,
        // 能力从绑定 Flow 的图上推导；Agent.toolGroups 那一列已删除
        defaultFlowVersion: { select: { definition: true } },
      },
    });

    const describe = (agent: (typeof agents)[number]) => {
      const capability = describeToolGroups(
        resolveBoundFlowToolGroups(agent.defaultFlowVersion?.definition),
      );
      return agent.description
        ? `${capability}（${agent.description}）`
        : capability;
    };

    return {
      self: agents
        .filter((agent) => agent.id === currentAgentId)
        .map((agent) => ({ name: agent.name, capability: describe(agent) }))[0],
      others: agents
        .filter((agent) => agent.id !== currentAgentId)
        .map((agent) => ({ name: agent.name, capability: describe(agent) })),
    };
  }

  /**
   * 转换消息角色
   * @param role 数据库中的消息角色枚举
   * @returns 返回 LLM 可识别的消息角色
   * @description 将数据库层的 USER 和 ASSISTANT 枚举转换为统一的 LLM 消息角色字符串，避免在调用方重复判断。
   */
  private toLlmMessageRole(role: MessageRole): 'user' | 'assistant' {
    return role === MessageRole.USER ? 'user' : 'assistant';
  }

  /**
   * 格式化摘要上下文消息
   * @param summary 会话较早历史摘要
   * @returns 返回注入 LLM 的 system 上下文消息
   * @description 明确摘要只用于延续上下文，并要求最近消息优先于摘要，降低旧摘要和最新对话冲突时的误用风险。
   */
  private formatSummaryContextMessage(summary: string) {
    return [
      '以下是当前会话较早历史的压缩摘要，只用于延续上下文，不要向用户暴露摘要本身。',
      '如果摘要与最近消息冲突，优先相信最近消息。',
      '',
      summary,
    ].join('\n');
  }
}
