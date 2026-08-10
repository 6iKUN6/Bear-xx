/**
 * LangGraph messages 流 → 统一事件的映射
 *
 * 抽成纯函数模块而非 Nest service：这里没有任何依赖与状态，
 * 而 plan/hybrid 的编排图与 ReAct 链路都要用同一套解析——重复一遍会立刻漂移。
 *
 * 两种入流形状都支持：
 * - `[message, metadata]`                   单图 `streamMode:'messages'`
 * - `[namespace, [message, metadata]]`      带子图 `subgraphs:true`
 *
 * 后者的命名空间首段标明来源（子图是两段、外层节点直接调模型是单段），
 * 编排图据此区分「步骤过程文本（收集为观察）」与「最终答案（下发 delta）」。
 * 结论由 `scripts/debug-subgraph-interrupt.cjs` 实测得出。
 */

import type { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import type { BaseMessageChunk } from '@langchain/core/messages';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';
import {
  buildToolDoneSummary,
  buildToolErrorSummary,
} from '../../agent-loop/trace/trace-summary.builder';
import type { CommonChatAgentStreamEvent } from './common-chat-agent.types';

/** 单图 messages 模式的块 */
export type MessagesModeChunk = [BaseMessageChunk, Record<string, unknown>];

/** 带子图时的块：外层再包一层命名空间 */
export type SubgraphMessagesModeChunk = [string[], MessagesModeChunk];

/** 映射产出：事件 + 它来自哪个命名空间（单图流下为空数组） */
export interface MappedAgentEvent {
  event: CommonChatAgentStreamEvent;
  namespace: string[];
}

/** 工具调用的跨块累积状态（args 分片、序号、名称都要跨块拼） */
interface ToolCallAccumulator {
  indexById: Map<string, number>;
  nameById: Map<string, string>;
  argsById: Map<string, string>;
  nextIndex: number;
  lastToolCallId?: string;
}

function createToolCallAccumulator(): ToolCallAccumulator {
  return {
    indexById: new Map(),
    nameById: new Map(),
    argsById: new Map(),
    nextIndex: 0,
  };
}

/**
 * 判断是否为带子图的块
 * @description 子图形状的首元素是命名空间字符串数组，单图形状的首元素是消息对象。
 */
function isSubgraphChunk(
  chunk: MessagesModeChunk | SubgraphMessagesModeChunk,
): chunk is SubgraphMessagesModeChunk {
  return Array.isArray(chunk[0]);
}

/**
 * 映射 messages 流为统一事件
 * @param stream `streamMode:'messages'` 的产出（可带 `subgraphs:true`）
 * @returns 返回事件与其来源命名空间
 * @description ai 文本 → message.delta；tool_call_chunks → tool.call.start/delta；
 * ToolMessage → tool.call.done/error。工具的 args 分片跨块累积，故解析必须是有状态的单次遍历。
 */
export async function* mapMessagesStream(
  stream: AsyncIterable<MessagesModeChunk | SubgraphMessagesModeChunk>,
): AsyncGenerator<MappedAgentEvent, void, unknown> {
  const tools = createToolCallAccumulator();

  for await (const rawChunk of stream) {
    const [namespace, [message]] = isSubgraphChunk(rawChunk)
      ? rawChunk
      : ([[], rawChunk] as [string[], MessagesModeChunk]);

    const messageType = message.getType();

    if (messageType === 'tool') {
      yield {
        namespace,
        event: buildToolResultEvent(message as unknown as ToolMessage, tools),
      };
      continue;
    }

    if (messageType !== 'ai') {
      continue;
    }

    const aiChunk = message as AIMessageChunk;

    const text = readMessageText(aiChunk.content);
    if (text) {
      yield {
        namespace,
        event: { type: StreamTaskEventType.MessageDelta, delta: text },
      };
    }

    for (const chunk of aiChunk.tool_call_chunks ?? []) {
      const callId = readOptionalString(chunk.id) ?? tools.lastToolCallId;
      if (!callId) {
        continue;
      }
      tools.lastToolCallId = callId;

      const chunkName = readOptionalString(chunk.name);
      if (chunkName && !tools.nameById.has(callId)) {
        tools.nameById.set(callId, chunkName);
      }

      if (!tools.indexById.has(callId)) {
        const index = tools.nextIndex;
        tools.nextIndex += 1;
        tools.indexById.set(callId, index);

        const name = tools.nameById.get(callId);
        yield {
          namespace,
          event: {
            type: StreamTaskEventType.ToolCallStart,
            payload: buildToolPayload(callId, name, index, {
              publicStatus: `正在调用工具${formatNameSuffix(name)}`,
            }),
          },
        };
      }

      const argsChunk = readOptionalString(chunk.args);
      if (argsChunk) {
        tools.argsById.set(
          callId,
          (tools.argsById.get(callId) ?? '') + argsChunk,
        );
      }

      yield {
        namespace,
        event: {
          type: StreamTaskEventType.ToolCallDelta,
          toolCallId: callId,
          name: tools.nameById.get(callId),
          args: argsChunk,
          index: tools.indexById.get(callId),
        },
      };
    }
  }
}

/** 构建工具执行结果事件 */
function buildToolResultEvent(
  message: ToolMessage,
  tools: ToolCallAccumulator,
): CommonChatAgentStreamEvent {
  const callId = readOptionalString(message.tool_call_id);
  const index = callId ? (tools.indexById.get(callId) ?? -1) : -1;
  const name = callId ? tools.nameById.get(callId) : undefined;
  const rawArgs = callId ? tools.argsById.get(callId) : undefined;
  const content = readMessageText(message.content);

  if (readOptionalString(message.status) === 'error') {
    const errorMessage = content || '工具调用失败';
    return {
      type: StreamTaskEventType.ToolCallError,
      payload: buildToolPayload(callId, name, index, {
        publicStatus: `工具调用失败${formatNameSuffix(name)}`,
        summary: buildToolErrorSummary(name, { message: errorMessage }),
        message: errorMessage,
        error: { message: errorMessage },
      }),
    };
  }

  const outputSummary = toJsonSummary(message.content);
  return {
    type: StreamTaskEventType.ToolCallDone,
    payload: buildToolPayload(callId, name, index, {
      publicStatus: `工具调用完成${formatNameSuffix(name)}`,
      summary: buildToolDoneSummary(name, rawArgs, outputSummary),
      outputSummary,
    }),
  };
}

/**
 * 拼装工具事件的公共载荷
 * @description extra 用泛型而非 `Record<string, unknown>`：后者会让展开后的字段
 * 从返回类型里消失，调用点就无法校验是否补齐了 summary / message 等必填项。
 */
function buildToolPayload<TExtra extends object>(
  callId: string | undefined,
  name: string | undefined,
  index: number,
  extra: TExtra,
) {
  return {
    toolCallId: callId,
    name,
    toolName: name,
    index,
    nodeKey: 'common_chat_tool',
    traceKey: `tool:${callId ?? name ?? index}`,
    ...extra,
  };
}

function formatNameSuffix(value: unknown) {
  const name = readOptionalString(value);
  return name ? `：${name}` : '';
}

export function readOptionalString(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

/** 读取消息内容中的纯文本 */
export function readMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string'
        ? record.text
        : '';
    })
    .join('');
}

function toJsonSummary(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return { text: value };
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return { value: value.toString() };
  }

  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch {
      // 出参不可序列化（含循环引用等）时不阻断链路，落一个占位值即可；
      // 这里刻意不接 logger：纯函数模块不引 Nest 依赖。
      return { value: '[unserializable]' };
    }
  }

  return { value: '[unsupported]' };
}
