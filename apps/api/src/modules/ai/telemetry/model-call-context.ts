import { AsyncLocalStorage } from 'async_hooks';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import type { LlmTokenUsageMetrics } from '../../llm/llm.types';

interface ModelCallRecord {
  estimatedInputTokens: number;
  estimatedOutputTokens?: number;
  providerUsage?: ProviderTokenUsage;
}

interface ProviderTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens?: number;
}

/**
 * 单轮任务的模型调用计数上下文
 * @description ReAct/Plan 循环内的多次模型往返折叠在消息流里、不逐次发事件，
 * 靠 trace 会漏计。用 AsyncLocalStorage 在任务执行期建立上下文，模型构造处挂的
 * LangChain 回调（handleChatModelStart）在每次真实调用时 +1，任务完成时读取累计值。
 * ALS 跨 await 传播，能把并发任务的计数隔离在各自上下文，互不串扰。
 */
interface ModelCallContext {
  taskId: string;
  /** 任务归属用户：供工具（生图转存等）在执行期取归属，不用逐层传参 */
  userId?: string;
  counter: { model: number };
  modelCalls: Map<string, ModelCallRecord>;
}

const storage = new AsyncLocalStorage<ModelCallContext>();

/**
 * 在模型调用计数上下文中执行
 * @param taskId 任务标识
 * @param fn 任务执行体
 * @returns 返回 fn 的结果
 * @description 包裹任务的 agent 执行段；期间的模型调用回调都会累计到本上下文。
 */
export function runWithModelCallContext<T>(
  taskId: string,
  fn: () => Promise<T>,
  userId?: string,
): Promise<T> {
  return storage.run(
    { taskId, userId, counter: { model: 0 }, modelCalls: new Map() },
    fn,
  );
}

/**
 * 累加一次模型调用
 * @description 由 chat-model.factory 挂的 LangChain 回调在每次模型调用开始时触发；
 * 不在上下文中（如后台摘要任务）时静默忽略。
 */
export function incrementModelCall(): void {
  const context = storage.getStore();
  if (context) {
    context.counter.model += 1;
  }
}

/**
 * 记录模型调用开始时的估算输入
 * @param runId LangChain 本次模型调用运行ID
 * @param messages 实际发送给模型的消息
 * @param extraParams LangChain 回调透传的调用参数，包含工具 schema 等输入
 * @returns 无返回值
 * @description 每次模型调用先记录真实组装后的输入，若供应商结束时未返回 usage，
 * 再以此作为该次调用的估算兜底；runId 用于和结束回调一一配对。
 */
export function recordModelCallStart(
  runId: string,
  messages: BaseMessage[][],
  extraParams?: Record<string, unknown>,
): void {
  const context = storage.getStore();
  if (!context) {
    return;
  }

  context.counter.model += 1;
  context.modelCalls.set(runId, {
    estimatedInputTokens: estimateTextTokenCount(
      [
        ...messages.flatMap((group) => group.map(messageToText)),
        readInvocationTools(extraParams),
      ].join('\n'),
    ),
  });
}

/**
 * 记录模型调用结束时的供应商 usage
 * @param runId LangChain 本次模型调用运行ID
 * @param output LangChain 归一后的模型输出
 * @returns 无返回值
 * @description 优先从流式终态消息的 usage_metadata 读取 token；部分模型只在
 * llmOutput.tokenUsage 返回时也兼容读取。未返回 usage 时保留本次调用的估算输出。
 */
export function recordModelCallEnd(runId: string, output: LLMResult): void {
  const record = storage.getStore()?.modelCalls.get(runId);
  if (!record) {
    return;
  }

  record.providerUsage = readProviderUsage(output);
  record.estimatedOutputTokens = estimateTextTokenCount(
    output.generations.flat().map(generationToText).join('\n'),
  );
}

/**
 * 汇总当前任务内全部模型调用的 token 用量
 * @returns 有模型调用时返回汇总用量，否则返回 undefined
 * @description 对每次调用独立采用供应商真实 usage 或估算值，避免把 ReAct、Plan
 * 等多轮调用折叠为最终回答的一次估算；任意一次走估算时整体标记 estimated。
 */
export function getModelCallTokenUsage(): LlmTokenUsageMetrics | undefined {
  const records = storage.getStore()?.modelCalls.values();
  if (!records) {
    return undefined;
  }

  let callCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedInputTokens = 0;
  let reasoningTokens = 0;
  let estimated = false;

  for (const record of records) {
    callCount += 1;
    if (record.providerUsage) {
      inputTokens += record.providerUsage.inputTokens;
      outputTokens += record.providerUsage.outputTokens;
      totalTokens += record.providerUsage.totalTokens;
      cachedInputTokens += record.providerUsage.cachedInputTokens;
      reasoningTokens += record.providerUsage.reasoningTokens ?? 0;
      continue;
    }

    estimated = true;
    inputTokens += record.estimatedInputTokens;
    outputTokens += record.estimatedOutputTokens ?? 0;
    totalTokens +=
      record.estimatedInputTokens + (record.estimatedOutputTokens ?? 0);
  }

  if (callCount === 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    estimated,
  };
}

/**
 * 读取当前上下文累计的模型调用次数
 * @returns 返回次数；不在上下文中时返回 0
 */
export function getModelCallCount(): number {
  return storage.getStore()?.counter.model ?? 0;
}

/**
 * 读取当前任务上下文的归属用户
 * @returns 返回 userId；不在任务上下文中（如直调链路）返回 undefined
 */
export function getTaskUserId(): string | undefined {
  return storage.getStore()?.userId;
}

/**
 * 读取 LangChain 调用参数中的工具 schema
 * @param extraParams 模型开始回调透传的额外参数
 * @returns 返回工具 schema 的可估算文本；没有时返回空字符串
 * @description 工具定义不在消息数组中，单独纳入估算输入，避免供应商不返回 usage 时
 * 漏掉 ReAct 调用的 function schema 开销。
 */
function readInvocationTools(extraParams?: Record<string, unknown>): string {
  const params = toRecord(extraParams?.invocation_params);
  return safeJsonStringify(params?.tools);
}

/**
 * 将 LangChain 消息转换为可估算文本
 * @param message LangChain 消息对象
 * @returns 返回消息正文、附加字段与工具调用的序列化文本
 * @description 使用实际模型输入中的内容与工具调用参数，而不是会话原始消息，
 * 使估算路径覆盖 system prompt、工具结果与 ReAct 往返。
 */
function messageToText(message: BaseMessage): string {
  const record = toRecord(message);
  return [
    valueToText(message.content),
    safeJsonStringify(message.additional_kwargs),
    safeJsonStringify(record?.tool_calls),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 将 LangChain generation 转换为可估算文本
 * @param generation 模型输出 generation
 * @returns 返回文本与工具调用参数的序列化结果
 * @description 工具调用通常没有普通文本内容，因此同时读取 message 上的 tool_calls，
 * 以便在供应商没有 usage 时仍计算该次调用的输出开销。
 */
function generationToText(
  generation: LLMResult['generations'][number][number],
) {
  const record = toRecord(generation);
  const message = toRecord(record?.message);
  return [
    valueToText(record?.text),
    valueToText(message?.content),
    safeJsonStringify(message?.tool_calls),
    safeJsonStringify(message?.additional_kwargs),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 读取供应商返回的 usage
 * @param output LangChain 归一后的模型输出
 * @returns 字段完整时返回真实 usage，否则返回 undefined
 * @description 流式模型把 usage 放在终态 generation.message.usage_metadata；
 * 非流式或第三方实现可能只放在 llmOutput.tokenUsage，两种结构均支持。
 */
function readProviderUsage(output: LLMResult): ProviderTokenUsage | undefined {
  for (const generation of output.generations.flat()) {
    const message = toRecord(toRecord(generation)?.message);
    const usage = toRecord(message?.usage_metadata);
    const parsed = parseProviderUsage(usage, 'snake');
    if (parsed) {
      return parsed;
    }
  }

  return parseProviderUsage(
    toRecord(toRecord(output.llmOutput)?.tokenUsage),
    'camel',
  );
}

/**
 * 解析单次调用的 provider usage
 * @param usage LangChain 或 provider 返回的 usage 对象
 * @param naming usage 的字段命名风格
 * @returns 输入和输出 token 均存在时返回统一结构，否则返回 undefined
 * @description 只有输入和输出都返回时才视为真实 usage；避免把不完整的字段与估算值
 * 混合后错误标记为精确数据。
 */
function parseProviderUsage(
  usage: Record<string, unknown> | undefined,
  naming: 'snake' | 'camel',
): ProviderTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const inputTokens = readNumber(
    usage[naming === 'snake' ? 'input_tokens' : 'promptTokens'],
  );
  const outputTokens = readNumber(
    usage[naming === 'snake' ? 'output_tokens' : 'completionTokens'],
  );
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  const totalTokens =
    readNumber(usage[naming === 'snake' ? 'total_tokens' : 'totalTokens']) ??
    inputTokens + outputTokens;
  const inputDetails = toRecord(usage.input_token_details);
  const outputDetails = toRecord(usage.output_token_details);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens:
      readNumber(inputDetails?.cache_read) ??
      readNumber(inputDetails?.cached_tokens) ??
      0,
    reasoningTokens: readNumber(outputDetails?.reasoning),
  };
}

/**
 * 按中英混合文本粗略估算 token 数
 * @param text 待估算文本
 * @returns 返回估算 token 数
 * @description 与 LlmService 的降级规则保持一致：中文按约一 token，其他非空白字符按四字符一 token。
 */
function estimateTextTokenCount(text: string): number {
  if (!text) {
    return 0;
  }

  const cjkCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const nonWhitespaceCount = text.replace(/\s/g, '').length;
  const nonCjkCount = Math.max(0, nonWhitespaceCount - cjkCount);
  return Math.max(1, Math.ceil(cjkCount + nonCjkCount / 4));
}

/**
 * 将未知值转换为可估算文本
 * @param value 任意待转换值
 * @returns 字符串或稳定的 JSON 文本
 * @description 文本块数组、工具参数等结构化内容通过 JSON 保留字段，不依赖模型实例的内部序列化格式。
 */
function valueToText(value: unknown): string {
  return typeof value === 'string' ? value : safeJsonStringify(value);
}

/**
 * 安全序列化未知对象
 * @param value 待序列化值
 * @returns JSON 字符串；无法序列化时返回空字符串
 * @description 采集器只在内存中估算，序列化失败不影响模型调用与主任务。
 */
function safeJsonStringify(value: unknown): string {
  if (value === undefined) {
    return '';
  }

  try {
    const serialized = JSON.stringify(value) ?? '';
    return serialized === '{}' || serialized === '[]' || serialized === 'null'
      ? ''
      : serialized;
  } catch {
    return '';
  }
}

/**
 * 判断并转换普通对象
 * @param value 待判断值
 * @returns 是普通对象时返回记录类型，否则返回 undefined
 */
function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 读取非负数值字段
 * @param value 待读取值
 * @returns 有效数值时返回数字，否则返回 undefined
 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
