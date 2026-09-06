/**
 * LangGraph messages 流 → 统一事件的映射
 *
 * 抽成纯函数模块而非 Nest service：这里没有任何依赖与状态，
 * 而 plan/hybrid 的编排图与 ReAct 链路都要用同一套解析——重复一遍会立刻漂移。
 *
 * 三种入流形状：
 * - `[message, metadata]`                    单图 `streamMode:'messages'`（ReAct 链路）
 * - `[namespace, [message, metadata]]`       单模式 + `subgraphs:true`
 * - `[namespace, mode, payload]`             多模式 + `subgraphs:true`（编排图）
 *
 * 前两种走 `mapMessagesStream`，第三种走 `mapGraphStream`；两者共用同一份块解析。
 *
 * messages 的命名空间首段标明来源（子图是两段、外层节点直接调模型是单段），
 * 编排图据此区分「步骤过程文本（收集为观察）」与「最终答案（下发 delta）」。
 * 结论由 `scripts/debug-subgraph-interrupt.cjs` 与 `scripts/debug-graph-events.cjs` 实测得出。
 */

import type { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import type { BaseMessageChunk } from '@langchain/core/messages';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';
import {
  buildToolDoneSummary,
  buildToolErrorSummary,
} from '../../agent-loop/trace/trace-summary.builder';
import type { AgentLoopStreamEvent } from '../../agent-loop/agent-loop.types';
import type { CommonChatAgentStreamEvent } from './common-chat-agent.types';

/** 单图 messages 模式的块 */
export type MessagesModeChunk = [BaseMessageChunk, Record<string, unknown>];

/** 带子图时的块：外层再包一层命名空间 */
export type SubgraphMessagesModeChunk = [string[], MessagesModeChunk];

/**
 * 多模式流的块：`[命名空间, 模式, 载荷]`
 * @description `streamMode: ['messages','custom'] + subgraphs:true` 的形状。
 * custom 的载荷就是编排节点用 `config.writer()` 推出的成品事件，无需再解析。
 */
export type GraphModeChunk =
  | [string[], 'messages', MessagesModeChunk]
  | [string[], 'custom', AgentLoopStreamEvent];

/** 映射产出：事件 + 它来自哪个命名空间（单图流下为空数组） */
export interface MappedAgentEvent {
  event: CommonChatAgentStreamEvent;
  namespace: string[];
}

/** 编排图的映射产出：事件集比 agent 层多出编排事件 */
export interface MappedGraphEvent {
  event: AgentLoopStreamEvent;
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
 * 创建有状态的 messages 块解析器
 * @returns 返回「单块 → 事件数组」的解析函数
 * @description ai 文本 → message.delta；tool_call_chunks → tool.call.start/delta；
 * ToolMessage → tool.call.done/error。工具的 args 分片跨块累积，故解析必须有状态。
 * 抽成工厂而非直接写在生成器里：单模式流与多模式流两个入口要共用同一份解析，
 * 复制一遍就会立刻漂移。
 */
function createMessageChunkParser() {
  const tools = createToolCallAccumulator();

  return ([message]: MessagesModeChunk): CommonChatAgentStreamEvent[] => {
    const messageType = message.type;

    if (messageType === 'tool') {
      return [buildToolResultEvent(message as unknown as ToolMessage, tools)];
    }

    // 编排节点写进 state 的消息（remove/system/human）也会混进 messages 流，
    // 这里一并滤掉，否则前端会多出一堆空 delta。
    if (messageType !== 'ai') {
      return [];
    }

    const aiChunk = message as AIMessageChunk;
    const events: CommonChatAgentStreamEvent[] = [];

    const text = readMessageText(aiChunk.content);
    if (text) {
      events.push({ type: StreamTaskEventType.MessageDelta, delta: text });
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
        events.push({
          type: StreamTaskEventType.ToolCallStart,
          payload: buildToolPayload(callId, name, index, {
            publicStatus: `正在调用工具${formatNameSuffix(name)}`,
          }),
        });
      }

      const argsChunk = readOptionalString(chunk.args);
      if (argsChunk) {
        tools.argsById.set(
          callId,
          (tools.argsById.get(callId) ?? '') + argsChunk,
        );
      }

      events.push({
        type: StreamTaskEventType.ToolCallDelta,
        toolCallId: callId,
        name: tools.nameById.get(callId),
        args: argsChunk,
        index: tools.indexById.get(callId),
      });
    }

    return events;
  };
}

/**
 * 映射 messages 流为统一事件
 * @param stream `streamMode:'messages'` 的产出（可带 `subgraphs:true`）
 * @param onModelTurn 每识别到一次新的模型调用时回调
 * @returns 返回事件与其来源命名空间
 * @description onModelTurn 按 chunk 而不是按事件判定：一次模型调用可能只产出工具调用、
 * 甚至不产出任何事件，挂在事件上会漏计。
 */
export async function* mapMessagesStream(
  stream: AsyncIterable<MessagesModeChunk | SubgraphMessagesModeChunk>,
  onModelTurn?: () => void,
  onMessageChunk?: (chunk: MessagesModeChunk, namespace: string[]) => void,
): AsyncGenerator<MappedAgentEvent, void, unknown> {
  const parse = createMessageChunkParser();
  const countTurn = createModelTurnCounter(onModelTurn);

  for await (const rawChunk of stream) {
    const [namespace, messageChunk] = isSubgraphChunk(rawChunk)
      ? rawChunk
      : ([[], rawChunk] as [string[], MessagesModeChunk]);

    onMessageChunk?.(messageChunk, namespace);
    countTurn(namespace, messageChunk);
    for (const event of parse(messageChunk)) {
      yield { event, namespace };
    }
  }
}

/**
 * 创建按 LangGraph 步骤去重的模型调用计数器
 * @param onModelTurn 识别到新模型调用时的回调；缺省则整个计数器为空操作
 * @returns 返回「单块 → 是否新模型调用」的判定函数
 * @description LangGraph 在每个 chunk 的 metadata 上给出 `langgraph_node` 与
 * `langgraph_step`（见 `@langchain/langgraph` 的 pregel/algo）。一次模型调用会产出多个
 * AIMessageChunk，但它们共享同一个 (node, step)，所以按该组合去重即等于模型调用次数。
 * 只计 ai 消息：tool 消息属于工具执行，不是模型调用。命名空间要一起参与去重，
 * 否则子图与外层图的同名节点在同一 step 上会互相吞掉。
 */
function createModelTurnCounter(
  onModelTurn: (() => void) | undefined,
): (namespace: string[], chunk: MessagesModeChunk) => void {
  if (!onModelTurn) {
    return () => undefined;
  }
  const seenTurns = new Set<string>();
  return (namespace, [message, metadata]) => {
    if (message.type !== 'ai') {
      return;
    }
    const node = metadata.langgraph_node;
    const step = metadata.langgraph_step;
    if (typeof node !== 'string' || typeof step !== 'number') {
      // 元数据缺失（例如 LangGraph 升级改了形状）时无法去重，此处宁可多计也不能不计：
      // 不计会让预算护栏静默失效变成无限预算，多计只会让 Flow 提前撞上预算并明确报错。
      onModelTurn();
      return;
    }
    const turnKey = `${namespace.join('/')}#${node}#${step}`;
    if (seenTurns.has(turnKey)) {
      return;
    }
    seenTurns.add(turnKey);
    onModelTurn();
  };
}

/**
 * 映射编排图的多模式流为统一事件
 * @param stream `streamMode: ['messages','custom'] + subgraphs:true` 的产出
 * @returns 返回事件与其来源命名空间
 * @description custom 块是编排节点用 `config.writer()` 推出的成品事件，原样透传；
 * messages 块走与 ReAct 链路完全相同的解析。
 *
 * ⚠️ custom 块的命名空间**恒为空数组**（实测，见 `scripts/debug-graph-events.cjs`），
 * 与 messages 的「外层节点 1 段、子图内 2 段」不是一套语义。消费侧要先按事件类型
 * 分支，再在模型输出上用段数区分「步骤过程文本」与「最终答案」，
 * 不能直接拿 `namespace.length` 判断所有事件。
 */
export async function* mapGraphStream(
  stream: AsyncIterable<GraphModeChunk>,
): AsyncGenerator<MappedGraphEvent, void, unknown> {
  const parse = createMessageChunkParser();

  // 不解构成三个变量：解构后 TS 无法把 mode 的判别收窄到 payload 上，
  // 保留元组按下标判别才能让 custom 分支拿到成品事件类型。
  for await (const chunk of stream) {
    const namespace = chunk[0];

    if (chunk[1] === 'custom') {
      yield { event: chunk[2], namespace };
      continue;
    }

    for (const event of parse(chunk[2])) {
      yield { event, namespace };
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
