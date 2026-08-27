import { BadRequestException, Injectable } from '@nestjs/common';
import { AgentFlowVersionStatus, Prisma } from '@prisma/client';
import { validateFlowDefinition } from '../agent-flow/definition/flow-definition.validator';
import { TemporalClientService } from '../agent-flow/temporal/temporal-client.service';
import { BuiltinFlowService } from '../agent-flow/builtin-flow.service';
import { FlowRuntimeValidator } from '../agent-flow/runtime/flow-runtime-validator.service';
import { PrismaService } from '../../prisma/prisma.service';

/** 已冻结到 StreamTask 的 Flow 任务快照。 */
export interface FlowTaskSnapshot {
  flowVersionId: string;
  flowDigest: string;
  currentStep: string;
}

/** 派发一个已冻结 Flow 任务所需的最小持久化字段。 */
export interface FlowTaskDispatchInput {
  taskId: string;
  flowVersionId: string;
  flowDigest: string;
  temporalWorkflowId: string | null;
  temporalRunId: string | null;
}

/** 已成功启动的 Temporal Workflow 标识。 */
export interface FlowTaskDispatchResult {
  workflowId: string;
  runId: string;
}

/**
 * Flow 任务派发器
 * @description 在 StreamTask 与 Temporal Workflow 之间提供唯一的派发 seam：事务内锁定不可变 Flow 快照，事务提交后幂等启动 Workflow 并回写 Temporal 执行标识。它不执行业务节点、不写 SSE 帧，也不进入旧的进程内 Agent producer。
 */
@Injectable()
export class FlowTaskDispatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temporalClientService: TemporalClientService,
    private readonly runtimeValidator: FlowRuntimeValidator,
    private readonly builtinFlow: BuiltinFlowService,
  ) {}

  /**
   * 解析任务应锁定的已发布 Flow 快照
   * @param tx 当前创建 StreamTask 所在的 Prisma 事务客户端
   * @param input 包含回答 Agent 的任务创建上下文
   * @returns 返回可写入 StreamTask 的 Flow 快照；库中一个可用 Agent 都没有时返回 null
   * @description **Flow 是唯一编排路径**：所有聊天都从这里取图，不再有「绑了 Flow 才走 Flow」
   * 的分叉。Agent 绑没绑 Flow 只决定用哪张图——绑了用它的，没绑用内置直接回复 Flow。
   *
   * 没有指定 Agent 时回落到 `isDefault` 的 Agent：内置 Flow 里的 `agent-default` 需要一个
   * 具体的模型来源，而"没有 Agent"提供不了。库里连 isDefault 都没有才返回 null——那种情况下
   * 旧链路也答不出什么，但让它继续走旧链路比在这里抛错温和。
   *
   * 查询与校验都在创建 StreamTask 的同一事务内，防止任务后续读到 Agent 改绑后的 FlowVersion。
   */
  async resolveTaskFlowSnapshot(
    tx: Prisma.TransactionClient,
    input: { agentId?: string },
  ): Promise<FlowTaskSnapshot | null> {
    const agentSelect = {
      modelPreset: true,
      defaultFlowVersion: {
        select: {
          id: true,
          digest: true,
          status: true,
          definition: true,
        },
      },
    } as const;
    const agent = input.agentId
      ? await tx.agent.findUnique({
          where: { id: input.agentId },
          select: agentSelect,
        })
      : await tx.agent.findFirst({
          where: { isDefault: true, enabled: true },
          select: agentSelect,
        });
    if (!agent) {
      return null;
    }
    const bound = agent.defaultFlowVersion;
    const flowVersion = bound ?? (await this.builtinFlow.findDirectVersion(tx));
    if (!flowVersion) {
      // 内置 Flow 由启动时 ensure 建立；拿不到说明那一步失败了。静默回落旧链路会让
      // 这个故障一直不被发现，而用户拿到的是一条没人知道走了哪套编排的回复。
      throw new BadRequestException('内置 Flow 尚未初始化，请检查服务启动日志');
    }
    const source = bound ? '智能体绑定的' : '内置';
    if (
      flowVersion.status !== AgentFlowVersionStatus.PUBLISHED ||
      !flowVersion.digest
    ) {
      throw new BadRequestException(`${source} FlowVersion 未发布或缺少摘要`);
    }

    const parsed = validateFlowDefinition(flowVersion.definition);
    if (!parsed.success) {
      throw new BadRequestException(`${source} FlowVersion 定义无效`);
    }
    const entryNodeIds = new Set(
      parsed.definition.edges.map((edge) => edge.to),
    );
    const entryNode = parsed.definition.nodes.find(
      (node) => !entryNodeIds.has(node.id),
    );
    if (!entryNode) {
      throw new BadRequestException(`${source} FlowVersion 缺少入口节点`);
    }

    // 任务锁定期校验：节点上的 `agent-default` 到这一刻才能解析成具体预设。
    // 不在这里拦，任务会被派发出去、在 Temporal Activity 里以
    // AGENT_FLOW_RUNTIME_CONTEXT_INVALID 失败，用户只看到一句「流程执行失败」，
    // 真实原因只能翻 worker 日志——错误必须还给发起者。
    const runtime = this.runtimeValidator.validate(parsed.definition, {
      phase: 'task',
      agentDefaultModelPreset: agent.modelPreset,
    });
    if (!runtime.valid) {
      throw new BadRequestException({
        message: `${source} Flow 在当前配置下无法运行`,
        errors: runtime.errors,
      });
    }

    return {
      flowVersionId: flowVersion.id,
      flowDigest: flowVersion.digest,
      currentStep: entryNode.id,
    };
  }

  /**
   * 幂等派发一个已冻结的 Flow 任务
   * @param input StreamTask 的 Flow 快照与已持久化 Temporal 标识
   * @returns 返回首次启动的 Workflow 标识；已保存标识的任务返回 null
   * @description Temporal Workflow ID 固定使用 StreamTask ID。仅在任务尚未保存 Workflow 标识时调用 Temporal；成功启动后立即回写 workflowId 与 runId，使 HTTP/SSE 进程后续只负责订阅和回放。
   */
  async dispatch(
    input: FlowTaskDispatchInput,
  ): Promise<FlowTaskDispatchResult | null> {
    if (input.temporalWorkflowId || input.temporalRunId) {
      return null;
    }

    const workflow = await this.temporalClientService.startWorkflow({
      streamTaskId: input.taskId,
      flowVersionId: input.flowVersionId,
      flowDigest: input.flowDigest,
    });
    await this.prisma.streamTask.update({
      where: { id: input.taskId },
      data: {
        temporalWorkflowId: workflow.workflowId,
        temporalRunId: workflow.runId,
      },
    });
    return workflow;
  }
}
