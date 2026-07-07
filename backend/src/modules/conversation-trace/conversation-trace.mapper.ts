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
  const payload = input.payload ?? {};
  const context = pickTraceContext(input);

  switch (input.eventName) {
    case StreamTaskEventType.StrategySelected:
      return {
        action: 'create-success',
        input: {
          ...context,
          traceKey: readTraceKey(payload, 'strategy:selected'),
          type: ConversationTraceItemType.STRATEGY_DECISION,
          title: '选择执行策略',
          summary:
            readString(payload, 'reason') ??
            readString(payload, 'publicStatus'),
          strategy: readString(payload, 'mode'),
          metadata: safeMetadata(payload),
        },
      };

    case StreamTaskEventType.SkillSelected:
      return {
        action: 'create-success',
        input: {
          ...context,
          traceKey: readTraceKey(
            payload,
            `skill:${readString(payload, 'skill') ?? 'selected'}`,
          ),
          type: ConversationTraceItemType.SKILL_SELECTION,
          title: '选择业务能力',
          summary: readString(payload, 'reason') ?? readString(payload, 'name'),
          skill: readString(payload, 'skill') ?? readString(payload, 'name'),
          metadata: safeMetadata(payload),
        },
      };

    case StreamTaskEventType.AgentLoopStart:
      return {
        action: 'create-success',
        input: {
          ...context,
          traceKey: readTraceKey(payload, 'agent-loop:start'),
          type: ConversationTraceItemType.WORKFLOW_STEP,
          title: '开始执行 Agent Loop',
          summary:
            readString(payload, 'publicStatus') ?? '已进入智能体编排流程',
          metadata: safeMetadata(payload),
        },
      };

    case StreamTaskEventType.WorkflowStepStart:
      return {
        action: 'start',
        input: {
          ...context,
          traceKey: workflowTraceKey(payload),
          type: resolveWorkflowTraceType(payload),
          title:
            readString(payload, 'title') ??
            readString(payload, 'step') ??
            '执行工作流步骤',
          summary:
            readString(payload, 'summary') ??
            readString(payload, 'publicStatus'),
          graph:
            readString(payload, 'graph') ?? readString(payload, 'strategy'),
          nodeKey: readNodeKey(payload),
          metadata: safeMetadata(payload),
          startedAt: new Date(),
        },
      };

    case StreamTaskEventType.WorkflowStepDone:
      return {
        action: 'complete',
        input: {
          taskId: input.taskId,
          traceKey: workflowTraceKey(payload),
          nodeKey: readNodeKey(payload),
          title:
            readString(payload, 'title') ??
            readString(payload, 'step') ??
            undefined,
          summary:
            readString(payload, 'summary') ??
            readString(payload, 'publicStatus'),
          outputSummary: readObject(payload, 'outputSummary'),
          metrics: readMetrics(payload),
          metadata: safeMetadata(payload),
          endedAt: new Date(),
        },
      };

    case StreamTaskEventType.ModelCallStart:
      return {
        action: 'start',
        input: {
          ...context,
          traceKey: readTraceKey(
            payload,
            `model:${readNodeKey(payload) ?? 'call'}`,
          ),
          type: ConversationTraceItemType.MODEL_CALL,
          title: '调用模型',
          summary:
            readString(payload, 'publicStatus') ?? readString(payload, 'model'),
          nodeKey: readNodeKey(payload),
          inputSummary: readObject(payload, 'inputSummary'),
          metadata: safeMetadata(payload),
          startedAt: new Date(),
        },
      };

    case StreamTaskEventType.ModelCallDone:
      return {
        action: 'complete',
        input: {
          taskId: input.taskId,
          traceKey: readTraceKey(
            payload,
            `model:${readNodeKey(payload) ?? 'call'}`,
          ),
          nodeKey: readNodeKey(payload),
          summary:
            readString(payload, 'summary') ??
            readString(payload, 'publicStatus') ??
            '模型调用完成',
          outputSummary: readObject(payload, 'outputSummary'),
          metrics: readMetrics(payload),
          metadata: safeMetadata(payload),
          endedAt: new Date(),
        },
      };

    case StreamTaskEventType.ToolCallStart:
      return {
        action: 'start',
        input: {
          ...context,
          traceKey: toolTraceKey(payload),
          type: ConversationTraceItemType.TOOL_CALL,
          title: `调用工具${formatNameSuffix(readToolName(payload))}`,
          summary:
            readString(payload, 'summary') ??
            readString(payload, 'publicStatus'),
          nodeKey: readNodeKey(payload),
          toolName: readToolName(payload),
          inputSummary:
            readObject(payload, 'inputSummary') ??
            readObject(payload, 'argsSummary'),
          metadata: safeMetadata(payload),
          startedAt: new Date(),
        },
      };

    case StreamTaskEventType.ToolCallDelta:
      return {
        action: 'start',
        input: {
          ...context,
          traceKey: toolTraceKey(payload),
          type: ConversationTraceItemType.TOOL_CALL,
          title: `准备调用工具${formatNameSuffix(readToolName(payload))}`,
          summary: '模型已生成工具调用请求',
          nodeKey: readNodeKey(payload),
          toolName: readToolName(payload),
          inputSummary: summarizeToolArgs(payload),
          metadata: safeMetadata(payload, ['args']),
          startedAt: new Date(),
        },
      };

    case StreamTaskEventType.ToolCallDone:
      return {
        action: 'complete',
        input: {
          taskId: input.taskId,
          traceKey: toolTraceKey(payload),
          nodeKey: readNodeKey(payload),
          title: `工具调用完成${formatNameSuffix(readToolName(payload))}`,
          summary:
            readString(payload, 'summary') ??
            readString(payload, 'publicStatus') ??
            '工具调用完成',
          outputSummary:
            readObject(payload, 'outputSummary') ??
            readObject(payload, 'resultSummary'),
          metrics: readMetrics(payload),
          metadata: safeMetadata(payload),
          endedAt: new Date(),
        },
      };

    case StreamTaskEventType.ToolCallError:
      return {
        action: 'fail',
        input: {
          ...context,
          traceKey: toolTraceKey(payload),
          type: ConversationTraceItemType.TOOL_CALL,
          title: `工具调用失败${formatNameSuffix(readToolName(payload))}`,
          summary:
            readString(payload, 'summary') ??
            readString(payload, 'publicStatus'),
          nodeKey: readNodeKey(payload),
          toolName: readToolName(payload),
          error: readObject(payload, 'error') ?? {
            message: readString(payload, 'message') ?? '工具调用失败',
          },
          metadata: safeMetadata(payload),
          endedAt: new Date(),
        },
      };

    case StreamTaskEventType.MessageDone:
      return {
        action: 'create-success',
        input: {
          ...context,
          traceKey: readTraceKey(payload, 'message:done'),
          type: ConversationTraceItemType.MESSAGE_FINALIZE,
          title: '生成最终回复',
          summary: readString(payload, 'warning') ?? '助手回复已生成完成',
          metrics: {
            ...readMetrics(payload),
            contentLength: readString(payload, 'content')?.length ?? 0,
          },
          metadata: safeMetadata(payload, ['content']),
        },
      };

    case StreamTaskEventType.TaskError:
      return {
        action: 'fail',
        input: {
          ...context,
          traceKey: readTraceKey(payload, 'task:error'),
          type: ConversationTraceItemType.ERROR,
          title: '任务执行失败',
          summary:
            input.errorMessage ??
            readString(payload, 'message') ??
            '任务执行失败',
          error: {
            message:
              input.errorMessage ??
              readString(payload, 'message') ??
              '任务执行失败',
          },
          metadata: safeMetadata(payload),
          endedAt: new Date(),
        },
      };

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

function workflowTraceKey(payload: Record<string, unknown>) {
  return readTraceKey(
    payload,
    `workflow:${readNodeKey(payload) ?? readString(payload, 'step') ?? 'step'}`,
  );
}

function toolTraceKey(payload: Record<string, unknown>) {
  return readTraceKey(
    payload,
    `tool:${readString(payload, 'toolCallId') ?? readString(payload, 'callId') ?? readToolName(payload) ?? 'call'}`,
  );
}

function readTraceKey(payload: Record<string, unknown>, fallback: string) {
  return readString(payload, 'traceKey') ?? fallback;
}

function readNodeKey(payload: Record<string, unknown>) {
  return (
    readString(payload, 'nodeKey') ??
    readString(payload, 'stepKey') ??
    readString(payload, 'step') ??
    readString(payload, 'node')
  );
}

function readToolName(payload: Record<string, unknown>) {
  return readString(payload, 'toolName') ?? readString(payload, 'name');
}

function resolveWorkflowTraceType(payload: Record<string, unknown>) {
  const mode =
    readString(payload, 'mode') ??
    readString(payload, 'strategy') ??
    readString(payload, 'graph');
  if (mode === 'react') {
    return ConversationTraceItemType.REACT_NODE;
  }
  if (mode === 'hybrid') {
    return ConversationTraceItemType.HYBRID_NODE;
  }
  if (mode === 'plan_execute') {
    return ConversationTraceItemType.PLAN_NODE;
  }
  return ConversationTraceItemType.WORKFLOW_STEP;
}

function readMetrics(payload: Record<string, unknown>) {
  return (
    readObject(payload, 'metrics') ??
    readObject(payload, 'usage') ??
    readObject(payload, 'tokenUsage')
  );
}

function readString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length > MAX_SUMMARY_LENGTH
    ? `${value.slice(0, MAX_SUMMARY_LENGTH)}...`
    : value;
}

function readObject(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value;
}

function safeMetadata(
  payload: Record<string, unknown>,
  omitKeys: string[] = [],
) {
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
    Object.entries(payload).filter(([key]) => !blockedKeys.has(key)),
  );
}

function summarizeToolArgs(payload: Record<string, unknown>) {
  const args = readString(payload, 'args');
  if (!args) {
    return undefined;
  }
  return { args };
}

function formatNameSuffix(name: string | undefined) {
  return name ? `：${name}` : '';
}
