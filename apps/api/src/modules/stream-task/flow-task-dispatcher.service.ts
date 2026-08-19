import { BadRequestException, Injectable } from '@nestjs/common';
import { AgentFlowVersionStatus, Prisma } from '@prisma/client';
import { validateFlowDefinition } from '../agent-flow/definition/flow-definition.validator';
import { TemporalClientService } from '../agent-flow/temporal/temporal-client.service';
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
  ) {}

  /**
   * 解析测试任务应锁定的已发布 Flow 快照
   * @param tx 当前创建 StreamTask 所在的 Prisma 事务客户端
   * @param input 包含回答 Agent 与测试会话标记的任务创建上下文
   * @returns 返回可写入 StreamTask 的 Flow 快照；非测试任务或未绑定 Flow 的 Agent 返回 null
   * @description 阶段 5 仅允许 admin 测试会话启用 Flow。查询、版本状态校验与入口节点解析均发生在创建任务的同一事务内，防止任务后续读取到 Agent 改绑后的 FlowVersion。
   */
  async resolveTaskFlowSnapshot(
    tx: Prisma.TransactionClient,
    input: { agentId?: string; isTest: boolean },
  ): Promise<FlowTaskSnapshot | null> {
    if (!input.isTest || !input.agentId) {
      return null;
    }

    const agent = await tx.agent.findUnique({
      where: { id: input.agentId },
      select: {
        defaultFlowVersion: {
          select: {
            id: true,
            digest: true,
            status: true,
            definition: true,
          },
        },
      },
    });
    const flowVersion = agent?.defaultFlowVersion;
    if (!flowVersion) {
      return null;
    }
    if (
      flowVersion.status !== AgentFlowVersionStatus.PUBLISHED ||
      !flowVersion.digest
    ) {
      throw new BadRequestException(
        '智能体绑定的 FlowVersion 未发布或缺少摘要',
      );
    }

    const parsed = validateFlowDefinition(flowVersion.definition);
    if (!parsed.success) {
      throw new BadRequestException('智能体绑定的 FlowVersion 定义无效');
    }
    const entryNodeIds = new Set(
      parsed.definition.edges.map((edge) => edge.to),
    );
    const entryNode = parsed.definition.nodes.find(
      (node) => !entryNodeIds.has(node.id),
    );
    if (!entryNode) {
      throw new BadRequestException('智能体绑定的 FlowVersion 缺少入口节点');
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
