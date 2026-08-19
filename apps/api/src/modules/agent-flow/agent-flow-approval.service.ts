import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentFlowApprovalKind,
  AgentFlowApprovalStatus,
  ConversationTraceItemStatus,
  Prisma,
  StreamTaskStatus,
} from '@prisma/client';
import { StreamTaskEventType } from '@litter-bear/types/protocol';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentFlowTaskEventService } from './agent-flow-task-event.service';

/** 提交持久化审批决定所需的最小输入。 */
export interface DecideAgentFlowApprovalInput {
  taskId: string;
  approvalId: string;
  actorId: string;
  decision: Prisma.InputJsonValue;
}

/** Flow 审批决定并排队 Temporal Signal 所需的最小输入。 */
export interface DecideAndQueueAgentFlowApprovalInput extends DecideAgentFlowApprovalInput {
  kind: AgentFlowApprovalKind;
}

/**
 * AgentFlow 审批事实服务
 * @description 负责审批决定的一次性持久化与重复提交判断；事件、trace 收敛和 Temporal Signal outbox 在 Flow 执行接入阶段完成。
 */
@Injectable()
export class AgentFlowApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskEventService: AgentFlowTaskEventService,
  ) {}

  /**
   * 原子地保存一次审批决定
   * @param input 包含任务、审批、操作者和决定的请求
   * @returns 返回首次保存或同决定重复提交时的审批记录
   * @description 仅允许从 PENDING 条件更新一次。相同 taskId、approvalId 和决定的重复请求返回既有记录；不同决定抛出冲突，绝不覆盖首次结果。
   */
  async decide(input: DecideAgentFlowApprovalInput) {
    const approval = await this.findApproval(input.taskId, input.approvalId);
    if (approval.status !== AgentFlowApprovalStatus.PENDING) {
      return this.resolveRepeatedDecision(approval, input.decision);
    }

    const decidedAt = new Date();
    const result = await this.prisma.agentFlowApproval.updateMany({
      where: {
        id: input.approvalId,
        taskId: input.taskId,
        status: AgentFlowApprovalStatus.PENDING,
      },
      data: {
        status: AgentFlowApprovalStatus.RESOLVED,
        decision: input.decision,
        decidedAt,
        decidedById: input.actorId,
      },
    });
    if (result.count === 1) {
      return {
        ...approval,
        status: AgentFlowApprovalStatus.RESOLVED,
        decision: input.decision,
        decidedAt,
        decidedById: input.actorId,
      };
    }

    // 条件更新未命中意味着另一请求已先提交决定；重新读取以区分幂等重试与冲突。
    const resolvedApproval = await this.findApproval(
      input.taskId,
      input.approvalId,
    );
    return this.resolveRepeatedDecision(resolvedApproval, input.decision);
  }

  /**
   * 原子地保存 Flow 审批决定、收敛 trace 并创建 Signal outbox
   * @param input 包含任务、审批、操作者和已校验的决定对象
   * @returns 返回首次决定或同决定重复提交对应的审批记录
   * @description 首次决定在一个 PostgreSQL 事务内完成审批条件更新、trace 收敛、`flow.run.resumed` 语义事件和 outbox 写入；事务提交后才发布 SSE 帧。Signal 由 outbox 派发器投递，决定正文绝不进入 Temporal。
   */
  async decideAndQueueSignal(input: DecideAndQueueAgentFlowApprovalInput) {
    const result = await this.prisma.$transaction(async (transaction) => {
      const approval = await this.findFlowApproval(
        transaction,
        input.taskId,
        input.approvalId,
      );
      if (!approval.task.flowVersionId) {
        throw new BadRequestException('该审批不属于 AgentFlow 任务');
      }
      if (approval.kind !== input.kind) {
        throw new BadRequestException('审批类型与当前提交入口不匹配');
      }
      this.assertDecisionAllowed(approval.requestSummary, input.decision);
      const conversationId = approval.task.conversationId;
      const messageId = approval.task.messageId;
      if (!conversationId || !messageId) {
        throw new NotFoundException('审批关联的任务上下文不存在');
      }
      if (approval.status !== AgentFlowApprovalStatus.PENDING) {
        return {
          approval: this.resolveRepeatedDecision(approval, input.decision),
          event: null,
        };
      }

      const decidedAt = new Date();
      const updateResult = await transaction.agentFlowApproval.updateMany({
        where: {
          id: input.approvalId,
          taskId: input.taskId,
          status: AgentFlowApprovalStatus.PENDING,
        },
        data: {
          status: AgentFlowApprovalStatus.RESOLVED,
          decision: input.decision,
          decidedAt,
          decidedById: input.actorId,
        },
      });
      if (updateResult.count !== 1) {
        const resolvedApproval = await this.findFlowApproval(
          transaction,
          input.taskId,
          input.approvalId,
        );
        return {
          approval: this.resolveRepeatedDecision(
            resolvedApproval,
            input.decision,
          ),
          event: null,
        };
      }

      if (approval.traceItemId) {
        await transaction.conversationTurnTraceItem.update({
          where: { id: approval.traceItemId },
          data: {
            status: ConversationTraceItemStatus.SUCCESS,
            summary: this.describeDecision(approval.kind, input.decision),
            outputSummary: input.decision,
            metadata: {
              approvalId: approval.id,
              decidedBy: input.actorId,
            },
            endedAt: decidedAt,
          },
        });
      }

      const event = await this.taskEventService.persistInTransaction(
        transaction,
        {
          taskId: approval.taskId,
          streamId: approval.runId ?? approval.task.currentRunId,
          userId: approval.task.userId,
          conversationId,
          messageId,
          eventName: StreamTaskEventType.FlowRunResumed,
          status: StreamTaskStatus.WAITING_HUMAN,
          payload: {
            runSequence: approval.run?.sequence ?? 1,
            reason: 'approval',
          },
          taskUpdate: { currentStep: approval.nodeKey },
        },
      );
      await transaction.agentFlowSignalOutbox.create({
        data: {
          taskId: approval.taskId,
          approvalId: approval.id,
          createdById: input.actorId,
        },
      });

      return {
        approval: {
          ...approval,
          status: AgentFlowApprovalStatus.RESOLVED,
          decision: input.decision,
          decidedAt,
          decidedById: input.actorId,
        },
        event,
      };
    });

    if (result.event) {
      await this.taskEventService.publishAfterCommit(result.event);
    }
    return result.approval;
  }

  /**
   * 读取并校验审批归属
   * @param taskId 当前任务ID
   * @param approvalId 稳定审批ID
   * @returns 返回属于该任务的审批记录
   * @description 不向其他任务泄露审批存在性；ID 不存在或不属于请求任务都返回同一未找到错误。
   */
  private async findApproval(taskId: string, approvalId: string) {
    const approval = await this.prisma.agentFlowApproval.findUnique({
      where: { id: approvalId },
    });
    if (!approval || approval.taskId !== taskId) {
      throw new NotFoundException('审批不存在');
    }
    return approval;
  }

  /**
   * 在事务内读取并校验属于 Flow 任务的审批事实
   * @param transaction 当前 PostgreSQL 事务客户端
   * @param taskId 当前任务ID
   * @param approvalId 稳定审批ID
   * @returns 返回含 Flow 任务和可见 run 序号的审批记录
   * @description 将审批、任务和 run 一并读取，避免事务中混用事务外的任务状态；审批不存在或跨任务访问都返回同一未找到错误。
   */
  private async findFlowApproval(
    transaction: Prisma.TransactionClient,
    taskId: string,
    approvalId: string,
  ) {
    const approval = await transaction.agentFlowApproval.findUnique({
      where: { id: approvalId },
      include: {
        task: {
          select: {
            id: true,
            userId: true,
            conversationId: true,
            messageId: true,
            currentRunId: true,
            flowVersionId: true,
          },
        },
        run: { select: { sequence: true } },
      },
    });
    if (
      !approval ||
      approval.taskId !== taskId ||
      !approval.task.conversationId ||
      !approval.task.messageId
    ) {
      throw new NotFoundException('审批不存在');
    }
    return approval;
  }

  /**
   * 处理已经决议的重复请求
   * @param approval 已不处于 PENDING 的审批记录
   * @param decision 本次请求提交的决定
   * @returns 决定相同时返回原审批记录
   * @description 只认同语义一致的重复请求；已超时、取消、失败或不同的决定都不能被后续请求覆盖。
   */
  private resolveRepeatedDecision(
    approval: {
      status: AgentFlowApprovalStatus;
      decision: Prisma.JsonValue | null;
    },
    decision: Prisma.InputJsonValue,
  ) {
    if (
      approval.status === AgentFlowApprovalStatus.RESOLVED &&
      isSameJsonValue(approval.decision, decision)
    ) {
      return approval;
    }
    throw new ConflictException('审批已处理，不能提交不同决定');
  }

  /**
   * 校验当前审批事实允许提交的决定
   * @param requestSummary 审批创建时持久化的安全请求摘要
   * @param decision 本次待持久化的决定对象
   * @returns 无返回值
   * @description Flow 工具审批的多工具批次只允许后端投影时计算出的共同决定集合。该校验位于条件更新前，防止客户端绕过审批卡片直接提交多工具批次不支持的 edit。
   */
  private assertDecisionAllowed(
    requestSummary: Prisma.JsonValue,
    decision: Prisma.InputJsonValue,
  ): void {
    const allowedDecisions = readAllowedDecisions(requestSummary);
    if (allowedDecisions.length === 0) {
      return;
    }
    const decisionType = readDecisionType(decision);
    if (!decisionType || !allowedDecisions.includes(decisionType)) {
      throw new BadRequestException('当前审批不允许该决定');
    }
  }

  /**
   * 生成审批决定的安全展示摘要
   * @param kind 审批类型
   * @param decision 已校验且待持久化的决定 JSON
   * @returns 返回用于 trace 收敛的中文摘要
   * @description 摘要只读取协议决定枚举，不复制编辑参数、计划正文或拒绝反馈等可能较长的内容。
   */
  private describeDecision(
    kind: AgentFlowApprovalKind,
    decision: Prisma.InputJsonValue,
  ): string {
    const decisionType = readDecisionType(decision);
    if (kind === AgentFlowApprovalKind.TOOL) {
      switch (decisionType) {
        case 'approve':
          return '已通过';
        case 'edit':
          return '已修改并通过';
        case 'reject':
          return '已拒绝';
        default:
          return '人工确认已处理';
      }
    }
    switch (decisionType) {
      case 'approve':
        return '已确认计划';
      case 'edit':
        return '已修改计划';
      case 'reject_replan':
        return '已要求重新规划';
      case 'reject_terminate':
        return '已终止计划';
      default:
        return '计划确认已处理';
    }
  }
}

/**
 * 从 JSON 决定中读取协议 decision 字段
 * @param value 待持久化的 JSON 值
 * @returns 返回合法字符串决定；形状不符时返回 undefined
 * @description HTTP DTO 已负责正常校验；这里是服务层的防御性读取，用于生成展示摘要而不放宽任何状态迁移。
 */
function readDecisionType(value: Prisma.InputJsonValue): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, Prisma.InputJsonValue>;
  return typeof record.decision === 'string' ? record.decision : undefined;
}

/**
 * 从审批请求摘要读取受服务端约束的允许决定集合
 * @param value AgentFlowApproval.requestSummary 的 JSON 值
 * @returns 返回已验证的决定字符串列表；历史记录缺失字段时返回空数组
 * @description 新建 Flow 审批一定写入 allowedDecisions；空数组只兼容阶段 5 前已落库的审批记录，避免在升级过程中错误拒绝其原有产品语义。
 */
function readAllowedDecisions(value: Prisma.JsonValue): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const allowedDecisions = value.allowedDecisions;
  if (!Array.isArray(allowedDecisions)) {
    return [];
  }
  return allowedDecisions.filter(
    (allowedDecision): allowedDecision is string =>
      typeof allowedDecision === 'string',
  );
}

/**
 * 判断两个 JSON 值是否语义相等
 * @param left 已持久化的 JSON 值
 * @param right 本次请求提交的 JSON 值
 * @returns 键顺序不同但语义一致时返回 true
 * @description 决定参数是对象时不能依赖调用方字段顺序；递归规范化对象键后再比较稳定 JSON 字符串。
 */
function isSameJsonValue(
  left: Prisma.JsonValue | null,
  right: Prisma.InputJsonValue,
): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

/**
 * 生成键顺序稳定的 JSON 字符串
 * @param value 可序列化的 JSON 值
 * @returns 返回稳定序列化结果
 * @description 数组保持顺序，对象键递归排序，用于审批决定的幂等比较而非持久化或摘要计算。
 */
function canonicalizeJson(
  value: Prisma.JsonValue | Prisma.InputJsonValue,
): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<
      string,
      Prisma.JsonValue | Prisma.InputJsonValue
    >;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
