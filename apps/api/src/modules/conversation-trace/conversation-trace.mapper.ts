import {
  AgentStrategyMode,
  type ToolCallDeltaPayload,
  type ToolCallDonePayload,
  type ToolCallStartPayload,
  type WorkflowStepStartPayload,
} from '@litter-bear/types/protocol';
import { StreamTaskEventType } from '../stream-task/stream-task-event.types';
import {
  ConversationTraceItemType,
  type RecordStreamEventInput,
  type TraceCommand,
  type TraceTaskContext,
} from './conversation-trace.types';

const MAX_SUMMARY_LENGTH = 240;

/**
 * 将流式事件映射为单轮对话轨迹命令
 * @param input 流式事件和任务上下文
 * @returns 返回可被轨迹服务执行的命令；无历史回显价值的事件返回 null
 * @description 只把策略、节点、模型、工具和最终消息等关键事件归约为 trace，跳过 message.delta 等高频快照。
 */
export function mapStreamEventToTraceCommand(
  input: RecordStreamEventInput,
): TraceCommand | null {
  const context = pickTraceContext(input);

  switch (input.eventName) {
    case StreamTaskEventType.AgentRouted: {
      const payload = input.payload;
      return {
        action: 'create-success',
        input: {
          ...context,
          traceKey: 'agent:routed',
          type: ConversationTraceItemType.AGENT_ROUTING,
          title: '指派回答者',
          // 自动路由带模型理由；显式 @ / 固定默认回答者没有理由，退化为来源说明
          summary: truncate(
            payload?.reason ?? describeRouteSource(payload?.source),
          ),
          metadata: safeMetadata(payload),
        },
      };
    }

    case StreamTaskEventType.StrategySelected: {
      const payload = input.payload;
      return {
        action: 'create-success',
        input: {
          ...context,
          traceKey: 'strategy:selected',
          type: ConversationTraceItemType.STRATEGY_DECISION,
          title: '选择执行策略',
          summary: truncate(payload?.reason),
          strategy: payload?.mode,
          metadata: safeMetadata(payload),
        },
      };
    }

    case StreamTaskEventType.SkillSelected: {
      const payload = input.payload;
      return {
        action: 'create-success',
        input: {
          ...context,
          traceKey: `skill:${payload?.skill ?? 'selected'}`,
          type: ConversationTraceItemType.SKILL_SELECTION,
          title: '选择业务能力',
          skill: payload?.skill,
          metadata: safeMetadata(payload),
        },
      };
    }

    case StreamTaskEventType.AgentLoopStart: {
      const payload = input.payload;
      return {
        action: 'create-success',
        input: {
          ...context,
          traceKey: payload?.traceKey ?? 'agent-loop:start',
          type: ConversationTraceItemType.WORKFLOW_STEP,
          title: '开始执行 Agent Loop',
          summary: truncate(payload?.publicStatus) ?? '已进入智能体编排流程',
          metadata: safeMetadata(payload),
        },
      };
    }

    case StreamTaskEventType.WorkflowStepStart: {
      const payload = input.payload;
      return {
        action: 'start',
        input: {
          ...context,
          traceKey: workflowTraceKey(payload),
          type: resolveWorkflowTraceType(payload?.strategy),
          title: payload?.title ?? payload?.step ?? '执行工作流步骤',
          summary: truncate(payload?.publicStatus),
          graph: payload?.strategy,
          nodeKey: payload?.nodeKey,
          metadata: safeMetadata(payload),
          startedAt: new Date(),
        },
      };
    }

    case StreamTaskEventType.WorkflowStepDone: {
      const payload = input.payload;
      return {
        action: 'complete',
        input: {
          taskId: input.taskId,
          traceKey: workflowTraceKey(payload),
          nodeKey: payload?.nodeKey,
          title: payload?.title ?? payload?.step,
          summary: truncate(payload?.summary ?? payload?.publicStatus),
          metadata: safeMetadata(payload),
          endedAt: new Date(),
        },
      };
    }

    case StreamTaskEventType.ModelCallStart: {
      const payload = input.payload;
      return {
        action: 'start',
        input: {
          ...context,
          traceKey: payload?.traceKey ?? `model:${payload?.nodeKey ?? 'call'}`,
          type: ConversationTraceItemType.MODEL_CALL,
          title: '调用模型',
          summary: truncate(payload?.publicStatus ?? payload?.model),
          nodeKey: payload?.nodeKey,
          metadata: safeMetadata(payload),
          startedAt: new Date(),
        },
      };
    }

    case StreamTaskEventType.ModelCallDone:
      return {
        action: 'complete',
        input: {
          taskId: input.taskId,
          traceKey:
            input.payload?.traceKey ??
            `model:${input.payload?.nodeKey ?? 'call'}`,
          nodeKey: input.payload?.nodeKey,
          summary: '模型调用完成',
          metadata: safeMetadata(input.payload),
          endedAt: new Date(),
        },
      };

    case StreamTaskEventType.ToolCallStart: {
      const payload = input.payload;
      return {
        action: 'start',
        input: {
          ...context,
          traceKey: toolTraceKey(payload),
          type: ConversationTraceItemType.TOOL_CALL,
          title: `调用工具${formatNameSuffix(payload?.toolName ?? payload?.name)}`,
          summary: truncate(payload?.publicStatus),
          nodeKey: payload?.nodeKey,
          toolName: payload?.toolName ?? payload?.name,
          metadata: safeMetadata(payload),
          startedAt: new Date(),
        },
      };
    }

    case StreamTaskEventType.ToolCallDelta: {
      const payload = input.payload;
      return {
        action: 'start',
        input: {
          ...context,
          traceKey: toolTraceKey(payload),
          type: ConversationTraceItemType.TOOL_CALL,
          title: `准备调用工具${formatNameSuffix(payload?.name)}`,
          summary: '模型已生成工具调用请求',
          toolName: payload?.name,
          inputSummary: summarizeToolArgs(payload?.args),
          metadata: safeMetadata(payload, ['args']),
          startedAt: new Date(),
        },
      };
    }

    case StreamTaskEventType.ToolCallDone: {
      const payload = input.payload;
      return {
        action: 'complete',
        input: {
          taskId: input.taskId,
          traceKey: toolTraceKey(payload),
          nodeKey: payload?.nodeKey,
          title: `工具调用完成${formatNameSuffix(payload?.toolName ?? payload?.name)}`,
          summary: truncate(payload?.summary ?? payload?.publicStatus),
          outputSummary: payload?.outputSummary,
          metadata: safeMetadata(payload),
          endedAt: new Date(),
        },
      };
    }

    case StreamTaskEventType.ToolCallError: {
      const payload = input.payload;
      return {
        action: 'fail',
        input: {
          ...context,
          traceKey: toolTraceKey(payload),
          type: ConversationTraceItemType.TOOL_CALL,
          title: `工具调用失败${formatNameSuffix(payload?.toolName ?? payload?.name)}`,
          summary: truncate(payload?.summary ?? payload?.publicStatus),
          nodeKey: payload?.nodeKey,
          toolName: payload?.toolName ?? payload?.name,
          error: payload?.error ?? {
            message: payload?.message ?? '工具调用失败',
          },
          metadata: safeMetadata(payload),
          endedAt: new Date(),
        },
      };
    }

    // 审批请求先开一条 RUNNING 项，由 approval.resolved 收敛为最终结果。
    // 不落 trace 的话，刷新后完全看不出「这条消息曾经过人工确认」。
    case StreamTaskEventType.ApprovalRequired: {
      const payload = input.payload;
      return {
        action: 'start',
        input: {
          ...context,
          traceKey: payload?.traceKey ?? 'approval',
          type: ConversationTraceItemType.APPROVAL,
          title: `待人工确认${formatNameSuffix(payload?.toolName)}`,
          summary: truncate(payload?.description ?? payload?.publicStatus),
          nodeKey: payload?.nodeKey,
          toolName: payload?.toolName,
          metadata: safeMetadata(payload),
        },
      };
    }

    case StreamTaskEventType.ApprovalResolved: {
      const payload = input.payload;
      return {
        action: 'complete',
        input: {
          taskId: input.taskId,
          traceKey: payload?.traceKey ?? 'approval',
          nodeKey: payload?.nodeKey,
          title: `人工确认${formatNameSuffix(payload?.toolName)}`,
          // publicStatus 由发射端写成决定的中文文案（已通过/已拒绝/…），
          // 标签映射只保留在协议包一处，不在此重复一份
          summary: payload?.publicStatus ?? '人工确认已处理',
          metadata: safeMetadata(payload),
          endedAt: new Date(),
        },
      };
    }

    // 计划审批复用 APPROVAL 类型（避免枚举迁移），靠 nodeKey=plan_review 区分来源。
    case StreamTaskEventType.PlanReviewRequired: {
      const payload = input.payload;
      return {
        action: 'start',
        input: {
          ...context,
          traceKey: payload?.traceKey ?? 'plan-review',
          type: ConversationTraceItemType.APPROVAL,
          title: '待确认计划',
          summary: truncate(
            payload?.steps?.length
              ? `共 ${payload.steps.length} 步待确认`
              : payload?.publicStatus,
          ),
          nodeKey: payload?.nodeKey,
          metadata: safeMetadata(payload),
        },
      };
    }

    case StreamTaskEventType.PlanReviewResolved: {
      const payload = input.payload;
      return {
        action: 'complete',
        input: {
          taskId: input.taskId,
          traceKey: payload?.traceKey ?? 'plan-review',
          nodeKey: payload?.nodeKey,
          title: '计划确认',
          // publicStatus 由发射端写成决定的中文文案（已确认计划/已打回/…）
          summary: payload?.publicStatus ?? '计划确认已处理',
          metadata: safeMetadata(payload),
          endedAt: new Date(),
        },
      };
    }

    case StreamTaskEventType.MessageDone: {
      const payload = input.payload;
      return {
        action: 'create-success',
        input: {
          ...context,
          traceKey: 'message:done',
          type: ConversationTraceItemType.MESSAGE_FINALIZE,
          title: '生成最终回复',
          summary: truncate(payload?.warning) ?? '助手回复已生成完成',
          metrics: {
            ...payload?.metrics,
            contentLength: payload?.content?.length ?? 0,
          },
          metadata: safeMetadata(payload, ['content']),
        },
      };
    }

    case StreamTaskEventType.TaskError: {
      // 人类可读的错误文本在信封的 errorMessage 上，不在 payload 里；
      // payload 只有 category/retryable/status 这些分类信息
      const message = input.errorMessage ?? '任务执行失败';
      return {
        action: 'fail',
        input: {
          ...context,
          traceKey: 'task:error',
          type: ConversationTraceItemType.ERROR,
          title: '任务执行失败',
          summary: truncate(message),
          error: { message },
          metadata: safeMetadata(input.payload),
          endedAt: new Date(),
        },
      };
    }

    default:
      return null;
  }
}

/**
 * 读取 trace 任务上下文
 * @param input 流式事件输入
 * @returns 返回可写入 trace 表的任务上下文
 * @description 过滤掉 mapper 不需要的事件字段，只保留 trace 写入必需的关联 ID。
 */
function pickTraceContext(input: RecordStreamEventInput): TraceTaskContext {
  return {
    userId: input.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    taskId: input.taskId,
    runId: input.runId,
  };
}

function workflowTraceKey(payload?: WorkflowStepStartPayload) {
  return (
    payload?.traceKey ??
    `workflow:${payload?.nodeKey ?? payload?.step ?? 'step'}`
  );
}

function toolTraceKey(
  payload?: ToolCallStartPayload | ToolCallDeltaPayload | ToolCallDonePayload,
) {
  if (payload && 'traceKey' in payload && payload.traceKey) {
    return payload.traceKey;
  }
  const name = payload && 'toolName' in payload ? payload.toolName : undefined;
  return `tool:${payload?.toolCallId ?? name ?? payload?.name ?? 'call'}`;
}

/** 指派来源的中文说明（自动路由无理由时作为 summary 兜底） */
function describeRouteSource(source?: string) {
  switch (source) {
    case 'explicit':
      return '用户指定回答者';
    case 'default':
      return '会话固定回答者';
    case 'fallback':
      return '自动分配不可用，已交给首位成员';
    case 'model':
      return '按能力自动分配';
    default:
      return undefined;
  }
}

function resolveWorkflowTraceType(mode?: AgentStrategyMode) {
  if (mode === AgentStrategyMode.ReAct) {
    return ConversationTraceItemType.REACT_NODE;
  }
  if (mode === AgentStrategyMode.Hybrid) {
    return ConversationTraceItemType.HYBRID_NODE;
  }
  if (mode === AgentStrategyMode.PlanExecute) {
    return ConversationTraceItemType.PLAN_NODE;
  }
  return ConversationTraceItemType.WORKFLOW_STEP;
}

/** 截断过长文本，避免 summary 撑爆展示与存储 */
function truncate(value?: string) {
  if (!value) {
    return undefined;
  }
  return value.length > MAX_SUMMARY_LENGTH
    ? `${value.slice(0, MAX_SUMMARY_LENGTH)}...`
    : value;
}

function safeMetadata(payload?: object, omitKeys: string[] = []) {
  const blockedKeys = new Set([
    'content',
    'prompt',
    'systemPrompt',
    'messages',
    'raw',
    'rawResponse',
    ...omitKeys,
  ]);
  return Object.fromEntries(
    Object.entries(payload ?? {}).filter(([key]) => !blockedKeys.has(key)),
  );
}

function summarizeToolArgs(args?: string) {
  if (!args) {
    return undefined;
  }
  return { args: truncate(args) };
}

function formatNameSuffix(name: string | undefined) {
  return name ? `：${name}` : '';
}
