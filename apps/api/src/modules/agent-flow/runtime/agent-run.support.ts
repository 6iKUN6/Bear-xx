import { Injectable } from '@nestjs/common';
import {
  AgentFlowApprovalKind,
  AgentFlowApprovalStatus,
  AgentFlowNodeExecutionResultKind,
  ConversationTraceItemStatus,
  ConversationTraceItemType,
  MessageStatus,
  Prisma,
  StreamTaskRunStatus,
  StreamTaskRuntime,
  StreamTaskStatus,
} from '@prisma/client';
import { GraphRecursionError } from '@langchain/langgraph';
import { ApplicationFailure } from '@temporalio/client';
import {
  StreamTaskEventType,
  TASK_ERROR_CATEGORY_LABELS,
  type ApprovalDecision,
  type ApprovalRequiredPayload,
  type TaskErrorCategory,
  type ToolCallDonePayload,
  type ToolCallErrorPayload,
  type ToolCallStartPayload,
} from '@litter-bear/types/protocol';
import type { ReasoningSelection } from '@litter-bear/types';
import {
  classifyLlmError,
  isRetryableTaskErrorCategory,
} from '../../llm/llm-error';
import { PrismaService } from '../../../prisma/prisma.service';
import type { CommonChatAgentStreamEvent } from '../../ai/agents/common-chat-agent/common-chat-agent.types';
import {
  getModelCallPeakInput,
  getModelCallTokenUsage,
  runWithModelCallContext,
} from '../../ai/telemetry/model-call-context';
import { LlmModelRegistryService } from '../../llm/llm-model-registry.service';
import type { LlmMessage } from '../../llm/llm.types';
import { AgentFlowTaskEventService } from '../agent-flow-task-event.service';
import type { PersistedAgentFlowTaskEvent } from '../agent-flow-task-event.service';
import { StorageAssetService } from '../../storage/storage-asset.service';
import type { AgentFlowFinalStatus } from '../../../temporal/workflows/agent-flow.workflow.types';
import type { FlowNodeContextSnapshot } from './flow-context.service';

/**
 * 一次智能体运行所处的任务与节点身份
 * @description AgentFlow 节点与默认 ReAct 智能体共用的最小上下文：只含写事件、写审批、计预算所需的字段，
 * 不含 FlowDefinition。AgentFlow 的执行上下文结构上满足它，可以直接传入。
 */
export interface AgentRunScope {
  task: {
    id: string;
    userId: string;
    conversationId: string;
    messageId: string;
    streamId: string | null;
    /** 本轮用户消息正文 */
    inputText: string;
    imageAssetId?: string;
    /** 任务是否为测试任务：渲染工具据此决定成片写入 dev 目录还是正式目录。 */
    isTest: boolean;
    budgetUsage: PersistedFlowBudgetUsage;
  };
  /** 事件、审批与轨迹归属的节点键；默认 ReAct 智能体使用固定键 */
  node: { key: string };
}

/** 一次 Activity 执行的稳定身份；traceKey 与幂等记录都从它派生。 */
export interface AgentRunInput {
  nodeExecutionId: string;
}

/** 已持久化审批事实、需要 Workflow 等待 Signal 的结果。 */
export interface AgentRunWaitingResult {
  kind: 'waiting_human';
  approvalId: string;
  timeoutSeconds: number;
}

/** 任务收尾的最小输入。 */
export interface AgentRunFinalizeInput {
  streamTaskId: string;
  status: AgentFlowFinalStatus;
  lastNodeKey: string | null;
  /** 必须落在协议闭集内：它会直接进入下发给前端的 task.error 载荷 */
  errorCategory?: TaskErrorCategory;
  /** 只允许来自我们自己抛出的 ApplicationFailure 文案 */
  errorReason?: string;
}

export const FLOW_APPROVAL_TIMEOUT_SECONDS = 900;

/** Flow 内由 LangChain 消费的单次模型请求边界；失败不再叠加 Temporal 整节点重试。 */
export const AGENT_FLOW_MODEL_RUNTIME = {
  maxRetries: 1,
  timeoutMs: 25000,
} as const;

/**
 * Flow 运行至今的预算用量
 * @description 跨节点、跨 Activity retry、跨 HITL 恢复累计，因此必须落库；放在内存里会让
 * 每次 Activity 重试都把预算清零，护栏形同虚设。存 StreamTask 的整数列而不是 executionState
 * JSON：JSON 只能整块读改写，两个并发节点会互相吞掉计数，等于无限预算。
 */
export interface PersistedFlowBudgetUsage {
  modelCalls: number;
  toolCalls: number;
}

/** 已被突破的预算维度，直接对应 FlowDefinition.policy 的字段名。 */
export type FlowBudgetDimension = 'maxModelCalls' | 'maxToolCalls';

/** 一次 Activity 内的预算追踪器。 */
export interface FlowBudgetTracker {
  countModelCall: () => void;
  countToolCall: () => void;
  /**
   * 把本次 Activity 新增的调用数原子累加到库里，并用返回的权威总量刷新基线
   * @description 刻意不并入节点完成事务：额度是真花掉的，节点写入失败或回滚不该让这笔消耗
   * 从账上消失——那是把护栏往松的方向改。刷新基线的副作用是同一个 Activity 内后续的
   * overspent 判定也能看到其他并行分支的消耗。
   */
  flush: () => Promise<void>;
  /**
   * 模型调用额度已用尽（用量 >= 上限）；发起新的模型调用前的准入检查
   * @description 只看模型维度：maxToolCalls 为 0 是合法配置（禁用工具的纯问答节点），
   * 若在此一并要求工具额度，这类 Flow 会一次都跑不起来。工具超支由 overspent 在流中拦。
   */
  modelCallExhausted: () => boolean;
  /** 任一维度已突破上限（用量 > 上限）；用于在流中途立即停止消费 */
  overspent: () => FlowBudgetDimension | null;
}

/**
 * 创建 Flow 预算追踪器
 * @param limits 已发布 FlowDefinition 冻结的预算上限
 * @param usage 任务锁定时从计数列读到的历史累计用量
 * @param persist 把增量原子累加进库并返回累加后权威总量的写入函数
 * @returns 返回可计数、判定与落库的追踪器
 * @description 区分两个判定是为了既不浪费额度也不超支：进入一次模型调用前用
 * modelCallExhausted 拦截（没额度就不该再调模型），流内则用 overspent，让最后一次允许的
 * 调用完整产出后再中断，而不是把额度内的回复截断在半句话。
 * 计数在内存里累积、由 flush 成批落库，是因为 onModelTurn 是流映射层的同步回调，
 * 改成异步会把每次模型轮次都卡在一次数据库写上。
 */
export function createBudgetTracker(
  limits: { maxModelCalls: number; maxToolCalls: number },
  usage: PersistedFlowBudgetUsage,
  persist: (
    delta: PersistedFlowBudgetUsage,
  ) => Promise<PersistedFlowBudgetUsage>,
): FlowBudgetTracker {
  let persisted: PersistedFlowBudgetUsage = { ...usage };
  const pending: PersistedFlowBudgetUsage = { modelCalls: 0, toolCalls: 0 };
  const total = (): PersistedFlowBudgetUsage => ({
    modelCalls: persisted.modelCalls + pending.modelCalls,
    toolCalls: persisted.toolCalls + pending.toolCalls,
  });
  return {
    countModelCall: () => {
      pending.modelCalls += 1;
    },
    countToolCall: () => {
      pending.toolCalls += 1;
    },
    modelCallExhausted: () => total().modelCalls >= limits.maxModelCalls,
    overspent: () => {
      const current = total();
      if (current.modelCalls > limits.maxModelCalls) {
        return 'maxModelCalls';
      }
      if (current.toolCalls > limits.maxToolCalls) {
        return 'maxToolCalls';
      }
      return null;
    },
    flush: async () => {
      const delta = { ...pending };
      if (delta.modelCalls === 0 && delta.toolCalls === 0) {
        return;
      }
      // 先写成功再扣减 pending：写失败时增量必须留在待落库账上，否则这次消耗静默消失
      const next = await persist(delta);
      pending.modelCalls -= delta.modelCalls;
      pending.toolCalls -= delta.toolCalls;
      persisted = next;
    },
  };
}

/**
 * 计算一组工具请求可共同提交的审批决定
 * @param requests 同一轮 LangGraph interrupt 产出的工具审批请求
 * @returns 返回所有请求均允许的决定集合
 * @description 恢复时一个 ApprovalDecision 会被 `buildHitlResponse` 应用于整批 actionRequests，因此只向客户端暴露交集，避免对部分工具不合法的 edit 决定。
 */
export function resolveBatchAllowedDecisions(
  requests: ApprovalRequiredPayload[],
): ApprovalRequiredPayload['allowedDecisions'] {
  const firstRequest = requests[0];
  if (!firstRequest) {
    return [];
  }
  const commonDecisions = firstRequest.allowedDecisions.filter((decision) =>
    requests.every((request) => request.allowedDecisions.includes(decision)),
  );
  return requests.length > 1
    ? commonDecisions.filter((decision) => decision !== 'edit')
    : commonDecisions;
}

/**
 * 将普通值转换为 Prisma JSON 输入
 * @param value 已由服务端构造的安全对象
 * @returns 返回独立的 Prisma JSON 值
 * @description JSON 往返移除 undefined，确保审批请求摘要不会因运行时对象或可选字段破坏数据库写入。
 */
export function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * 创建 Flow 工具调用 traceKey
 * @param nodeExecutionId Temporal 计算出的稳定节点执行标识
 * @param toolCallId 供应商工具调用 id；缺失时用调用序号
 * @returns 返回同一次工具调用 start/done/error 共用的 traceKey
 */
export function createToolTraceKey(
  nodeExecutionId: string,
  toolCallId: string,
) {
  return `flow:tool:${nodeExecutionId}:${toolCallId}`;
}

/**
 * 创建 Flow 审批 traceKey
 * @param nodeExecutionId Temporal 计算出的稳定节点执行标识
 * @returns 返回审批等待与决策收敛共用的 traceKey
 * @description 工具审批从所属节点派生，避免相同工具名在不同 Flow 节点或不同任务中发生 trace 归并冲突。
 */
export function createApprovalTraceKey(nodeExecutionId: string): string {
  return `flow:approval:${nodeExecutionId}`;
}

/**
 * 判断 StreamTask 是否已进入终态
 * @param status 当前任务状态
 * @returns 任务不可再被 Flow finalizer 更新时返回 true
 * @description 与 StreamTaskService 的终态集合保持一致，避免 Workflow retry 在用户取消或已有错误后覆盖最终状态。
 */
export function isTerminalTaskStatus(status: StreamTaskStatus): boolean {
  return (
    status === StreamTaskStatus.COMPLETED ||
    status === StreamTaskStatus.ERROR ||
    status === StreamTaskStatus.EXPIRED ||
    status === StreamTaskStatus.CANCELED
  );
}

/**
 * 判断任务是否由 Temporal 执行
 * @param task 任务上的运行时与 Flow 快照字段
 * @returns 默认 ReAct 智能体任务或锁定了 FlowVersion 的任务返回 true
 * @description 两种运行时都经 Temporal 执行、共用审批与取消 Signal。只剩历史上未锁定 Flow 的旧任务
 * 会返回 false——CHAT_AGENT 任务没有 flowVersionId，靠它判定会让新任务落进旧的进程内链路。
 */
export function isTemporalTask(task: {
  runtime: StreamTaskRuntime;
  flowVersionId: string | null;
}): boolean {
  return (
    task.runtime === StreamTaskRuntime.CHAT_AGENT || Boolean(task.flowVersionId)
  );
}

/**
 * 创建不会触发 Temporal Activity retry 的业务失败
 * @param message 可安全记录的错误说明
 * @param type 固定错误类别
 * @returns 返回带 nonRetryable 标记的 Temporal ApplicationFailure
 * @description 版本快照损坏、上下文缺失、审批格式异常和未接入节点不能通过重复调用修复，必须直接交给管理端或后续阶段的补偿流程处理。
 */
export function createNonRetryableActivityFailure(
  message: string,
  type: string,
): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, type);
}

/**
 * 将 Agent 节点的模型超时转换为不会重复整轮 Activity 的安全失败
 * @param error LangChain 或模型 SDK 抛出的原始错误
 * @returns 非超时错误保持原样；该返回仅用于满足 throw 表达式的类型
 * @description AgentFlow 已允许 LangChain 在同一次模型请求内补试一次。若补试仍超时，
 * 再交给 Temporal 重跑整个节点会重复消息生成甚至工具循环，并把 30 秒故障放大到数分钟。
 * OpenAI SDK 在外部 timeout signal 触发时会使用 “Request was aborted.”，而 AgentFlow
 * 不向模型传用户取消 signal，因此这里可明确把该文案归为请求超时。
 */
export function toAgentFlowModelFailure(error: unknown): unknown {
  // 工具往返轮数触顶是运行护栏，不是模型故障：按预算停止收敛，重试只会再撞一次上限
  if (error instanceof GraphRecursionError) {
    return ApplicationFailure.nonRetryable(
      '工具调用轮数已达上限，请缩小任务范围后重试',
      'AGENT_FLOW_CONTEXT_BUDGET_EXCEEDED',
    );
  }
  const classified = classifyLlmError(error);
  const abortedByModelTimeout =
    classified.category === 'unknown' &&
    error instanceof Error &&
    error.message.trim().toLowerCase() === 'request was aborted.';
  if (classified.category === 'timeout' || abortedByModelTimeout) {
    return ApplicationFailure.nonRetryable(
      '模型响应超时，请重试',
      'AGENT_FLOW_LLM_TIMEOUT',
    );
  }
  return error;
}

/**
 * 把不可信字符串收窄为协议错误类别
 * @param value 来自数据库 JSON 的候选值
 * @returns 落在闭集内时返回该类别，否则返回 undefined
 * @description 成员判断直接借 TASK_ERROR_CATEGORY_LABELS 的键：它是
 * `Record<TaskErrorCategory, string>`，新增类别时编译器会强制补文案，
 * 因此不需要再维护第二份类别清单去和它对齐。
 */
export function toTaskErrorCategory(
  value: string | undefined,
): TaskErrorCategory | undefined {
  if (value && Object.hasOwn(TASK_ERROR_CATEGORY_LABELS, value)) {
    return value as TaskErrorCategory;
  }
  return undefined;
}

/** 终止语义到落库枚举的映射；两侧都是闭集，编译器强制补齐。 */
export const STOPPED_RESULT_KIND: Readonly<
  Record<'completed' | 'cancelled' | 'error', AgentFlowNodeExecutionResultKind>
> = {
  completed: AgentFlowNodeExecutionResultKind.STOPPED_COMPLETED,
  cancelled: AgentFlowNodeExecutionResultKind.STOPPED_CANCELLED,
  error: AgentFlowNodeExecutionResultKind.STOPPED_ERROR,
};

/** 落库枚举回到 Workflow 终止语义的映射。 */
export const STOPPED_RESULT_STATUS: Readonly<
  Record<
    Exclude<AgentFlowNodeExecutionResultKind, 'COMPLETED'>,
    'completed' | 'cancelled' | 'error'
  >
> = {
  STOPPED_COMPLETED: 'completed',
  STOPPED_CANCELLED: 'cancelled',
  STOPPED_ERROR: 'error',
};

/**
 * 将持久化 JSON 解析为工具审批决定
 * @param value AgentFlowApproval.decision 的 JSON 值
 * @returns 返回合法工具审批决定；格式异常时返回 undefined
 * @description 只接受工具审批的 approve/reject/edit 闭集，计划审批不会被误送进 CommonChatAgentService 的 HITL Command。
 */
export function toApprovalDecision(
  value: Prisma.JsonValue | null,
): ApprovalDecision | undefined {
  if (!isJsonObject(value) || typeof value.decision !== 'string') {
    return undefined;
  }
  if (value.decision === 'approve') {
    return { decision: 'approve' };
  }
  if (value.decision === 'reject') {
    return {
      decision: 'reject',
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    };
  }
  if (value.decision === 'edit') {
    return {
      decision: 'edit',
      ...(isJsonObject(value.editedArgs)
        ? { editedArgs: toUnknownRecord(value.editedArgs) }
        : {}),
    };
  }
  return undefined;
}

/**
 * 将受限 JSON 对象转换为工具入参记录
 * @param value 已验证为 JSON 对象的值
 * @returns 返回不含原型链的普通记录
 * @description 仅用于把审批事实中的 editedArgs 交给既有 HITL 恢复 API；值仍来自已持久化并经 DTO 验证的决定。
 */
export function toUnknownRecord(
  value: Prisma.JsonObject,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

/**
 * 从任务请求 JSON 中读取一个字符串字段
 * @param value StreamTask.requestPayload 的 JSON 值
 * @param key 允许读取的顶层固定字段名
 * @returns 返回非空字符串；不存在或格式错误时返回 undefined
 * @description 只读取任务创建期冻结的用户凭据标识，不读取或解析任意嵌套对象。
 */
export function readJsonString(
  value: Prisma.JsonValue,
  key: string,
): string | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/**
 * 判断值是否为 Prisma 支持的 JSON 对象
 * @param value 待检查的 JSON 值
 * @returns 值为非数组对象时返回 true
 * @description 用于收敛历史 executionState 和审批 JSON，避免 `null`、数组或标量被当作有字段的对象读取。
 */
export function isJsonObject(
  value: Prisma.JsonValue | null | undefined,
): value is Prisma.JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 智能体运行的共享执行支持
 * @description AgentFlow 的 agent 节点与代码定义的默认 ReAct 智能体共用：消费底层智能体事件流、
 * 推送工具与模型轨迹、创建工具审批等待、图片输入、预算计数与任务收尾。这些逻辑只依赖任务与节点身份，
 * 与 FlowDefinition 无关，放在一处避免两条运行时各写一份后漂移。
 */
@Injectable()
export class AgentRunSupport {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskEventService: AgentFlowTaskEventService,
    private readonly modelRegistry: LlmModelRegistryService,
    private readonly storageAssetService: StorageAssetService,
  ) {}

  /**
   * 为一次运行创建已接上原子落库的预算追踪器
   * @param scope 任务身份与锁定时读到的历史用量
   * @param limits 本次运行的预算上限（Flow 来自冻结的 policy，默认智能体来自代码常量）
   * @returns 返回可计数、判定与落库的追踪器
   * @description 落库走 Prisma 的 `increment`（SQL 层 `col = col + n`），并回读累加后的权威总量，
   * 因此并发节点各自记账不会互相覆盖。
   */
  createTaskBudgetTracker(
    scope: AgentRunScope,
    limits: { maxModelCalls: number; maxToolCalls: number },
  ): FlowBudgetTracker {
    return createBudgetTracker(
      limits,
      scope.task.budgetUsage,
      async (delta) => {
        const task = await this.prisma.streamTask.update({
          where: { id: scope.task.id },
          data: {
            flowModelCalls: { increment: delta.modelCalls },
            flowToolCalls: { increment: delta.toolCalls },
          },
          select: { flowModelCalls: true, flowToolCalls: true },
        });
        return {
          modelCalls: task.flowModelCalls,
          toolCalls: task.flowToolCalls,
        };
      },
    );
  }

  /**
   * 收敛一次任务的终态（AgentFlow 与默认 ReAct 智能体共用）
   * @param input 待持久化的受限终态、最后节点与安全错误类别
   * @returns 无返回值
   * @description 在事务内写入标准终态事件、任务/消息/run 状态与终态 trace，随后再收紧 Redis 帧保留窗口；重复调用已处于终态的任务不会产生第二组完成事件。
   */
  async finalizeTask(input: AgentRunFinalizeInput): Promise<void> {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: input.streamTaskId },
      select: {
        id: true,
        userId: true,
        status: true,
        conversationId: true,
        messageId: true,
        currentRunId: true,
        fullContent: true,
      },
    });
    if (!task) {
      return;
    }
    const conversationId = task.conversationId;
    const messageId = task.messageId;
    if (!conversationId || !messageId) {
      return;
    }
    if (isTerminalTaskStatus(task.status)) {
      if (task.status === StreamTaskStatus.CANCELED) {
        await this.prisma.$transaction(async (transaction) => {
          await this.settlePendingApprovalsInTransaction(
            transaction,
            task.id,
            AgentFlowApprovalStatus.CANCELED,
            '任务已取消',
          );
          await this.settleRunningToolTracesInTransaction(
            transaction,
            task.id,
            '任务已取消，工具未执行完成',
          );
        });
      }
      return;
    }

    const completed = input.status === 'completed';
    const cancelled = input.status === 'cancelled';
    const taskStatus = completed
      ? StreamTaskStatus.COMPLETED
      : cancelled
        ? StreamTaskStatus.CANCELED
        : StreamTaskStatus.ERROR;
    // 有具体原因就用它：泛化成「流程执行失败」会让用户和排障者都只能去翻 worker 日志。
    // errorReason 只可能来自我们自己抛的 ApplicationFailure，第三方错误已在 Workflow 侧滤掉。
    const errorMessage = completed
      ? undefined
      : cancelled
        ? '流程已取消'
        : input.errorReason?.trim() || '流程执行失败';
    const events = await this.prisma.$transaction(async (transaction) => {
      const persisted: PersistedAgentFlowTaskEvent[] = [];
      if (completed) {
        persisted.push(
          await this.taskEventService.persistInTransaction(transaction, {
            taskId: task.id,
            streamId: task.currentRunId,
            userId: task.userId,
            conversationId,
            messageId,
            eventName: StreamTaskEventType.MessageDone,
            status: StreamTaskStatus.STREAMING,
            payload: { content: task.fullContent },
            taskUpdate: { fullContent: task.fullContent },
          }),
        );
      }
      const eventName = completed
        ? StreamTaskEventType.TaskCompleted
        : cancelled
          ? StreamTaskEventType.TaskCanceled
          : StreamTaskEventType.TaskError;
      persisted.push(
        await this.taskEventService.persistInTransaction(transaction, {
          taskId: task.id,
          streamId: task.currentRunId,
          userId: task.userId,
          conversationId,
          messageId,
          eventName,
          status: taskStatus,
          ...(eventName === StreamTaskEventType.TaskError
            ? {
                errorMessage,
                payload: {
                  // 曾硬编码为 'server'，把配置错误（invalid）也说成"服务暂时不可用，
                  // 请稍后重试"，前端据此给出的重试建议是错的；类别由 Workflow 侧按
                  // ApplicationFailure 类型判定后传入
                  category: input.errorCategory ?? 'server',
                  retryable: isRetryableTaskErrorCategory(
                    input.errorCategory ?? 'server',
                  ),
                },
              }
            : {}),
          taskUpdate: {
            currentStep: input.lastNodeKey ?? taskStatus.toLowerCase(),
            completedAt: new Date(),
            fullContent: task.fullContent,
            errorMessage: errorMessage ?? null,
          },
        }),
      );
      await transaction.message.update({
        where: { id: messageId },
        data: {
          content: task.fullContent || errorMessage || '流程已完成',
          status: completed ? MessageStatus.DONE : MessageStatus.ERROR,
        },
      });
      if (task.currentRunId) {
        await transaction.streamTaskRun.update({
          where: { id: task.currentRunId },
          data: {
            status: completed
              ? StreamTaskRunStatus.COMPLETED
              : cancelled
                ? StreamTaskRunStatus.CANCELED
                : StreamTaskRunStatus.ERROR,
            endedAt: new Date(),
            closeReason: input.status,
            endEventId: persisted[persisted.length - 1]?.eventId,
          },
        });
      }
      if (!completed) {
        await this.settlePendingApprovalsInTransaction(
          transaction,
          task.id,
          cancelled
            ? AgentFlowApprovalStatus.CANCELED
            : input.status === 'timed_out'
              ? AgentFlowApprovalStatus.TIMED_OUT
              : AgentFlowApprovalStatus.ERROR,
          cancelled
            ? '任务已取消'
            : input.status === 'timed_out'
              ? '审批等待超时'
              : '流程执行失败',
        );
      }
      // 正常完成也可能留下未执行的工具行（例如审批被拒绝后不再执行），一并收敛
      await this.settleRunningToolTracesInTransaction(
        transaction,
        task.id,
        completed
          ? '工具未执行'
          : cancelled
            ? '任务已取消，工具未执行完成'
            : '任务已结束，工具未执行完成',
      );
      return persisted;
    });
    for (const event of events) {
      await this.taskEventService.publishAfterCommit(event);
    }
    await this.taskEventService.markCompletedAfterCommit(task.id);
  }

  /**
   * 为最终回答节点注入当前用户图片。
   * @param context 当前 Flow 执行上下文
   * @param modelPreset 回答节点锁定的模型预设 ID
   * @param messages 当前会话文字上下文
   * @returns 返回带公网图片 URL 的消息；K3 额外返回仅驻留内存的发包替换
   * @description 只给本轮原文附图；原文由引用提供时追加图片消息。历史图片不自动回放；Data URI 不进入消息状态，
   * 因而不会写进 LangGraph checkpoint、数据库、Redis 或 Temporal History。
   */
  async prepareAnswerVision(
    context: AgentRunScope,
    modelPreset: string,
    messages: LlmMessage[],
  ) {
    const transport = this.modelRegistry.getVisionTransport(modelPreset);
    if (!transport || !context.task.imageAssetId) {
      throw createNonRetryableActivityFailure(
        `回答节点模型「${modelPreset}」不支持图片输入`,
        'AGENT_FLOW_VISION_MODEL_UNSUPPORTED',
      );
    }
    const image = await this.storageAssetService.prepareChatImageForModel(
      context.task.userId,
      context.task.imageAssetId,
      transport,
    );
    const lastUserIndex = messages.findLastIndex(
      (message) =>
        message.role === 'user' && message.content === context.task.inputText,
    );
    const withImage = messages.map((message, index) =>
      index === lastUserIndex
        ? {
            ...message,
            content: context.task.inputText,
            image: { url: image.publicUrl, detail: 'auto' as const },
          }
        : message,
    );
    // 显式引用 start.text 时当前正文已经包含在来源消息中，只追加图片，不能覆盖上游结果。
    if (lastUserIndex < 0)
      withImage.push({
        role: 'user',
        content: '',
        image: { url: image.publicUrl, detail: 'auto' },
      });
    return {
      messages: withImage,
      ...(image.wireDataUri
        ? {
            transform: {
              sourceUrl: image.publicUrl,
              dataUri: image.wireDataUri,
            },
          }
        : {}),
    };
  }

  /**
   * 消费底层 Agent 的结构化事件流
   * @param context 当前节点执行上下文
   * @param input Temporal 节点执行标识
   * @param stream CommonChatAgentService 的事件流
   * @returns 返回累计正文、同一轮待审批工具请求批次，以及是否已突破预算
   * @description token 增量只写 Redis Frame；工具 start/done/error 落库并进入轨迹，使 SSE 与历史都能看到工具行。LangGraph 同一轮 interrupt 可能含多个工具请求，必须完整消费并作为一个审批批次持久化，随后由 Temporal Workflow 等待同一个 approvalId。工具调用在此按 tool.call.start 计入预算，模型调用由调用方经 onModelTurn 计入。
   */
  async consumeAgentStream(
    context: AgentRunScope,
    input: AgentRunInput,
    stream: AsyncGenerator<CommonChatAgentStreamEvent, void, unknown>,
    options: {
      initialContent: string;
      publishMessageDelta: boolean;
      budget: FlowBudgetTracker;
    },
  ): Promise<{
    fullContent: string;
    /** 只含本节点这一轮产出的正文，作为节点声明输出 text；fullContent 是任务累计正文 */
    nodeText: string;
    hadToolCalls: boolean;
    approvals: ApprovalRequiredPayload[];
    overspent: FlowBudgetDimension | null;
  }> {
    let fullContent = options.initialContent;
    let nodeText = '';
    let hadToolCalls = false;
    const approvals: ApprovalRequiredPayload[] = [];
    for await (const event of stream) {
      if (event.type === StreamTaskEventType.ToolCallStart) {
        // 只在 start 上计数：同一次工具调用还会产出 delta / done，重复计会虚高
        hadToolCalls = true;
        options.budget.countToolCall();
      }
      // 计数后立刻判定并 return：for-await 提前退出会对生成器调用 return()，
      // 从而中断底层 LangGraph 流，工具在本轮不会被真正执行。留到下一个事件再判
      // 会放过一次超额调用。
      const overspent = options.budget.overspent();
      if (overspent) {
        return {
          fullContent,
          nodeText,
          hadToolCalls,
          approvals,
          overspent,
        };
      }
      if (
        event.type === StreamTaskEventType.ToolCallStart ||
        event.type === StreamTaskEventType.ToolCallDone ||
        event.type === StreamTaskEventType.ToolCallError
      ) {
        hadToolCalls = true;
        await this.publishToolTraceEvent(context, input, event);
        continue;
      }
      if (event.type === StreamTaskEventType.MessageDelta) {
        fullContent += event.delta;
        nodeText += event.delta;
        if (options.publishMessageDelta) {
          await this.taskEventService.publishTransient(
            context.task.id,
            StreamTaskEventType.MessageDelta,
            JSON.stringify({
              type: StreamTaskEventType.MessageDelta,
              taskId: context.task.id,
              streamId: context.task.streamId ?? undefined,
              conversationId: context.task.conversationId,
              messageId: context.task.messageId,
              status: StreamTaskStatus.STREAMING.toLowerCase(),
              payload: { delta: event.delta },
            }),
          );
        }
        continue;
      }
      // 入参分片量大且只服务于拼接，不逐条落库；完整入参随 done 摘要进入轨迹
      if (event.type === StreamTaskEventType.ToolCallDelta) {
        hadToolCalls = true;
        continue;
      }
      if (event.type === StreamTaskEventType.ApprovalRequired) {
        approvals.push(event.payload);
      }
    }
    return {
      fullContent,
      nodeText,
      hadToolCalls,
      approvals,
      overspent: options.budget.overspent(),
    };
  }

  /**
   * 创建或复用一个工具审批等待事实
   * @param context 当前节点执行上下文
   * @param input Temporal 节点执行标识
   * @param requests 同一轮底层 agent 产出的安全工具审批请求批次
   * @param fullContent 等待前累计的回复正文
   * @returns 返回 Workflow 可等待的稳定 approvalId
   * @description 审批、Flow waiting 事件、审批 trace 和 StreamTask.WAITING_HUMAN 在同一事务提交。Activity 重试命中同节点的 PENDING 审批时直接复用，避免重复卡片和重复 trace。
   */
  async createToolApprovalWait(
    context: AgentRunScope,
    input: AgentRunInput,
    requests: ApprovalRequiredPayload[],
    fullContent: string,
    traceKey = createApprovalTraceKey(input.nodeExecutionId),
  ): Promise<AgentRunWaitingResult> {
    const allowedDecisions = resolveBatchAllowedDecisions(requests);
    const existing = await this.prisma.agentFlowApproval.findFirst({
      where: {
        taskId: context.task.id,
        nodeKey: context.node.key,
        kind: AgentFlowApprovalKind.TOOL,
        status: AgentFlowApprovalStatus.PENDING,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return {
        kind: 'waiting_human',
        approvalId: existing.id,
        timeoutSeconds: FLOW_APPROVAL_TIMEOUT_SECONDS,
      };
    }
    const expiresAt = new Date(
      Date.now() + FLOW_APPROVAL_TIMEOUT_SECONDS * 1_000,
    );
    const result = await this.prisma.$transaction(async (transaction) => {
      const approval = await transaction.agentFlowApproval.create({
        data: {
          taskId: context.task.id,
          runId: context.task.streamId,
          nodeKey: context.node.key,
          kind: AgentFlowApprovalKind.TOOL,
          requestSummary: toInputJsonValue({
            requests: requests.map((request) => ({
              toolName: request.toolName,
              ...(request.args ? { args: request.args } : {}),
              ...(request.description
                ? { description: request.description }
                : {}),
              index: request.index,
            })),
            allowedDecisions,
          }),
        },
      });
      const event = await this.taskEventService.persistInTransaction(
        transaction,
        {
          taskId: context.task.id,
          streamId: context.task.streamId,
          userId: context.task.userId,
          conversationId: context.task.conversationId,
          messageId: context.task.messageId,
          eventName: StreamTaskEventType.FlowWaitingHuman,
          status: StreamTaskStatus.WAITING_HUMAN,
          payload: {
            approvalId: approval.id,
            nodeKey: context.node.key,
            traceKey,
            approval: {
              kind: 'tool',
              requests: requests.map((request) => ({
                toolName: request.toolName,
                ...(request.args ? { args: request.args } : {}),
                ...(request.description
                  ? { description: request.description }
                  : {}),
                index: request.index,
              })),
              allowedDecisions,
            },
            expiresAt: expiresAt.toISOString(),
          },
          taskUpdate: {
            currentStep: context.node.key,
            fullContent,
            pausedAt: new Date(),
            expiresAt,
          },
        },
      );
      if (event.traceItemId) {
        await transaction.agentFlowApproval.update({
          where: { id: approval.id },
          data: { traceItemId: event.traceItemId },
        });
      }
      return { approvalId: approval.id, event };
    });
    await this.taskEventService.publishAfterCommit(result.event);
    return {
      kind: 'waiting_human',
      approvalId: result.approvalId,
      timeoutSeconds: FLOW_APPROVAL_TIMEOUT_SECONDS,
    };
  }

  /**
   * 追踪一个 Flow 模型节点的完整调用段
   * @description 一个 Agent 节点可能包含多次 ReAct 往返，这里将它们聚合为同一条模型节点 trace，
   * 同时保留每次供应商 usage 的累加结果。思考内容只传递配置与 token，不把私有思维链写入事件。
   */
  async runTrackedModelNode<T>(
    context: AgentRunScope,
    input: AgentRunInput,
    modelPreset: string | undefined,
    reasoning: ReasoningSelection | undefined,
    estimatedInputTokens: number,
    fn: () => Promise<T>,
    snapshot?: FlowNodeContextSnapshot,
  ): Promise<T> {
    const limits = this.modelRegistry.getContextLimits(modelPreset);
    const resolved = this.modelRegistry.resolveTextRequest({
      model: { modelId: modelPreset },
      reasoning,
    });
    const traceKey = `model:${input.nodeExecutionId}:${snapshot?.phase ?? 'model'}:${context.task.streamId ?? 'initial'}`;
    const contextSources = snapshot
      ? {
          conversation: snapshot.manifest.conversation,
          historyMessageCount: snapshot.manifest.messageIds.length,
          summaryMessageCount: snapshot.manifest.summaryMessageCount,
          upstream: snapshot.manifest.sources,
        }
      : undefined;
    const percent = this.contextUsagePercent(
      estimatedInputTokens,
      limits.contextWindowTokens,
    );
    await this.publishModelTraceEvent(context, input, {
      eventName: StreamTaskEventType.ModelCallStart,
      payload: {
        nodeKey: context.node.key,
        traceKey,
        publicStatus: '正在调用模型',
        contextSources,
        inputTokenLimit: snapshot?.inputTokenLimit,
        model: resolved.model.model,
        provider: resolved.model.platform,
        modelPresetId: limits.modelPreset,
        contextWindowTokens: limits.contextWindowTokens,
        estimatedInputTokens,
        contextUsagePercent: percent,
        ...(reasoning ? { reasoning } : {}),
      },
    });

    const startedAt = Date.now();
    let completed = false;
    let peak: ReturnType<typeof getModelCallPeakInput>;
    let usage: ReturnType<typeof getModelCallTokenUsage>;
    try {
      const result = await runWithModelCallContext(
        context.task.id,
        async () => {
          try {
            return await fn();
          } finally {
            // AsyncLocalStorage 在 run 返回后会恢复父上下文，必须在这里读取聚合结果。
            usage = getModelCallTokenUsage();
            peak = getModelCallPeakInput();
          }
        },
        context.task.userId,
        context.task.isTest,
      );
      completed = true;
      return result;
    } finally {
      const inputTokens = usage?.inputTokens;
      await this.publishModelTraceEvent(context, input, {
        eventName: StreamTaskEventType.ModelCallDone,
        payload: {
          nodeKey: context.node.key,
          traceKey,
          model: resolved.model.model,
          provider: resolved.model.platform,
          modelPresetId: limits.modelPreset,
          contextWindowTokens: limits.contextWindowTokens,
          inputTokens,
          status: completed ? 'success' : 'error',
          contextSources,
          inputTokenLimit: snapshot?.inputTokenLimit,
          peakInputTokens: peak?.tokens ?? estimatedInputTokens,
          contextUsageEstimated: peak?.estimated ?? true,
          outputTokens: usage?.outputTokens,
          totalTokens: usage?.totalTokens,
          invocations: usage?.invocations,
          cachedInputTokens: usage?.cachedInputTokens,
          reasoningTokens: usage?.reasoningTokens,
          contextUsagePercent: this.contextUsagePercent(
            peak?.tokens ?? estimatedInputTokens,
            snapshot?.contextWindowTokens ?? limits.contextWindowTokens,
          ),
          estimated: usage?.estimated ?? true,
          durationMs: Date.now() - startedAt,
          ...(reasoning ? { reasoning } : {}),
        },
      });
    }
  }

  contextUsagePercent(inputTokens: number, capacity: number): number {
    return Math.min(100, Math.round((inputTokens / capacity) * 1000) / 10);
  }

  async publishModelTraceEvent(
    context: AgentRunScope,
    input: AgentRunInput,
    event: {
      eventName:
        StreamTaskEventType.ModelCallStart | StreamTaskEventType.ModelCallDone;
      payload:
        | import('@litter-bear/types/protocol').ModelCallStartPayload
        | import('@litter-bear/types/protocol').ModelCallDonePayload;
    },
  ): Promise<void> {
    const persisted = await this.prisma.$transaction((transaction) =>
      this.taskEventService.persistInTransaction(transaction, {
        taskId: context.task.id,
        streamId: context.task.streamId,
        userId: context.task.userId,
        conversationId: context.task.conversationId,
        messageId: context.task.messageId,
        eventName: event.eventName,
        status: StreamTaskStatus.STREAMING,
        payload: event.payload,
      }),
    );
    await this.taskEventService.publishAfterCommit(persisted);
  }

  /**
   * 落库并推送一次工具生命周期事件
   * @param context 当前节点执行上下文
   * @param input Temporal 节点执行标识
   * @param event 底层 agent 产出的工具 start/done/error 事件
   * @returns 无返回值
   * @description 底层 agent 不知道自己所处的 Flow 节点，nodeKey 与 traceKey 在这里改写：
   * traceKey 带上 nodeExecutionId，供应商的 toolCallId（如 `call_0`）跨节点、跨轮会重复，
   * 只用它会让不同调用收敛到同一条轨迹。审批恢复后的 done 与首轮 start 共用同一个键。
   */
  async publishToolTraceEvent(
    context: AgentRunScope,
    input: AgentRunInput,
    event: Extract<
      CommonChatAgentStreamEvent,
      {
        type:
          | StreamTaskEventType.ToolCallStart
          | StreamTaskEventType.ToolCallDone
          | StreamTaskEventType.ToolCallError;
      }
    >,
  ): Promise<void> {
    const payload:
      ToolCallStartPayload | ToolCallDonePayload | ToolCallErrorPayload = {
      ...event.payload,
      nodeKey: context.node.key,
      traceKey: createToolTraceKey(
        input.nodeExecutionId,
        event.payload.toolCallId ?? String(event.payload.index),
      ),
    };
    const persisted = await this.prisma.$transaction((transaction) =>
      this.taskEventService.persistInTransaction(transaction, {
        taskId: context.task.id,
        streamId: context.task.streamId,
        userId: context.task.userId,
        conversationId: context.task.conversationId,
        messageId: context.task.messageId,
        eventName: event.type,
        status: StreamTaskStatus.STREAMING,
        payload,
      }),
    );
    await this.taskEventService.publishAfterCommit(persisted);
  }

  /**
   * 在任务终态事务中收敛仍待处理的 Flow 审批及 trace
   * @param transaction 当前 PostgreSQL 事务客户端
   * @param taskId 当前 Flow 任务ID
   * @param status 审批应迁移到的不可逆终态
   * @param summary 写入审批 trace 的安全摘要
   * @returns 无返回值
   * @description 只更新 PENDING 审批，因此取消、超时或 Workflow retry 重复收尾均幂等；先读取关联 traceId，再在同一事务中把对应 RUNNING trace 标记为 ERROR，避免历史页面永久显示等待人工确认。
   */
  async settlePendingApprovalsInTransaction(
    transaction: Prisma.TransactionClient,
    taskId: string,
    status: Extract<
      AgentFlowApprovalStatus,
      'CANCELED' | 'TIMED_OUT' | 'ERROR'
    >,
    summary: string,
  ): Promise<void> {
    const pendingApprovals = await transaction.agentFlowApproval.findMany({
      where: { taskId, status: AgentFlowApprovalStatus.PENDING },
      select: { id: true, traceItemId: true },
    });
    if (pendingApprovals.length === 0) {
      return;
    }
    await transaction.agentFlowApproval.updateMany({
      where: { taskId, status: AgentFlowApprovalStatus.PENDING },
      data: { status },
    });
    const traceItemIds = pendingApprovals
      .map((approval) => approval.traceItemId)
      .filter((traceItemId): traceItemId is string => Boolean(traceItemId));
    if (traceItemIds.length === 0) {
      return;
    }
    await transaction.conversationTurnTraceItem.updateMany({
      where: {
        id: { in: traceItemIds },
        status: ConversationTraceItemStatus.RUNNING,
      },
      data: {
        status: ConversationTraceItemStatus.ERROR,
        summary,
        error: { message: summary },
        endedAt: new Date(),
      },
    });
  }

  /**
   * 收敛仍在运行的工具轨迹
   * @param transaction 当前事务客户端
   * @param taskId 任务 ID
   * @param summary 展示给用户的结束原因
   * @returns 无返回值
   * @description 工具 start 已落库、而任务在审批等待或执行中被取消/超时/打断时，对应 done 永远不会到达；
   * 不收敛的话历史里这一行会一直显示为执行中。
   */
  async settleRunningToolTracesInTransaction(
    transaction: Prisma.TransactionClient,
    taskId: string,
    summary: string,
  ): Promise<void> {
    await transaction.conversationTurnTraceItem.updateMany({
      where: {
        taskId,
        type: ConversationTraceItemType.TOOL_CALL,
        status: ConversationTraceItemStatus.RUNNING,
      },
      data: {
        status: ConversationTraceItemStatus.ERROR,
        summary,
        error: { message: summary },
        endedAt: new Date(),
      },
    });
  }

  /**
   * 为上下文压缩的摘要调用占用 Flow 模型调用额度
   * @param budget 当前节点的预算追踪器
   * @param exhaustedMessage 额度已用尽时的失败说明
   * @returns 摘要调用前执行的计数回调
   * @description 先检查再计数并立即落库，额度用尽时不可重试地终止，不跳过摘要继续发送超预算请求。
   */
  countSummaryModelCall(
    budget: FlowBudgetTracker,
    exhaustedMessage: string,
  ): () => Promise<void> {
    return async () => {
      if (budget.modelCallExhausted())
        throw createNonRetryableActivityFailure(
          exhaustedMessage,
          'AGENT_FLOW_CONTEXT_BUDGET_EXCEEDED',
        );
      budget.countModelCall();
      await budget.flush();
    };
  }
}
