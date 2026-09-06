import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';

import {
  isCompatibleModelContext,
  modelContextEnvelopeSchema,
  parseModelContextEnvelope,
  type ModelContextEnvelope,
  type ModelContextIdentity,
} from './model-context.schema';

const GEMINI_TOOL_SIGNATURES_KEY =
  '__gemini_function_call_thought_signatures__';

interface ToolCallContext {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolResultContext {
  role: 'tool';
  content: string;
  toolCallId: string;
  name?: string;
  status?: 'success' | 'error';
}

interface OpenAiAssistantContext {
  role: 'assistant';
  content: string;
  reasoningContent?: string;
  toolCalls: ToolCallContext[];
}

type AnthropicContentContext =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

interface AnthropicAssistantContext {
  role: 'assistant';
  content: AnthropicContentContext[];
  toolCalls: ToolCallContext[];
}

type GeminiContentContext =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string };

interface GeminiAssistantContext {
  role: 'assistant';
  content: GeminiContentContext[];
  toolCalls: ToolCallContext[];
  thoughtSignatures: Record<string, string>;
}

/** 从一轮 Agent 原始消息中提取供应商要求回传的最小上下文。 */
export function extractModelContext(
  messages: BaseMessage[],
  identity: ModelContextIdentity,
): ModelContextEnvelope | undefined {
  if (identity.policy === 'assistant-reasoning') {
    return extractAnthropicContext(messages, identity);
  }
  if (identity.policy === 'full-tool-transcript') {
    return extractOpenAiCompatibleContext(messages, identity);
  }
  return extractGeminiContext(messages, identity);
}

/**
 * 将数据库中的兼容上下文恢复为 LangChain 消息。
 * @returns 不兼容时返回 undefined；schema 损坏时抛出，由调用方安全降级并记录元数据告警。
 */
export function replayModelContext(
  value: unknown,
  identity: ModelContextIdentity,
): BaseMessage[] | undefined {
  const context = parseModelContextEnvelope(value);
  if (!isCompatibleModelContext(context, identity)) {
    return undefined;
  }

  if (context.policy === 'full-tool-transcript') {
    return context.payload.messages.map((message) =>
      message.role === 'tool'
        ? toToolMessage(message)
        : new AIMessage({
            content: message.content,
            tool_calls: message.toolCalls,
            additional_kwargs: message.reasoningContent
              ? { reasoning_content: message.reasoningContent }
              : {},
          }),
    );
  }

  if (context.policy === 'assistant-reasoning') {
    return context.payload.messages.map((message) =>
      message.role === 'tool'
        ? toToolMessage(message)
        : new AIMessage({
            content: message.content,
            tool_calls: message.toolCalls,
          }),
    );
  }

  return context.payload.messages.map((message) =>
    message.role === 'tool'
      ? toToolMessage(message)
      : new AIMessage({
          content: message.content,
          tool_calls: message.toolCalls,
          additional_kwargs: {
            [GEMINI_TOOL_SIGNATURES_KEY]: message.thoughtSignatures,
          },
        }),
  );
}

function extractOpenAiCompatibleContext(
  messages: BaseMessage[],
  identity: ModelContextIdentity,
): ModelContextEnvelope | undefined {
  const payloadMessages: Array<OpenAiAssistantContext | ToolResultContext> = [];
  for (const message of messages) {
    if (message.type === 'ai') {
      const reasoningContent = readOptionalString(
        message.additional_kwargs.reasoning_content,
      );
      payloadMessages.push({
        role: 'assistant',
        content: readTextContent(message.content),
        ...(reasoningContent ? { reasoningContent } : {}),
        toolCalls: extractToolCalls(message),
      });
      continue;
    }
    const toolResult = extractToolResult(message);
    if (toolResult) payloadMessages.push(toolResult);
  }

  const hasPrivateContext = payloadMessages.some(
    (message) =>
      message.role === 'tool' ||
      Boolean(message.reasoningContent) ||
      message.toolCalls.length > 0,
  );
  if (!hasPrivateContext) {
    return undefined;
  }

  return modelContextEnvelopeSchema.parse({
    version: 1,
    ...identity,
    payload: { messages: payloadMessages },
  });
}

function extractAnthropicContext(
  messages: BaseMessage[],
  identity: ModelContextIdentity,
): ModelContextEnvelope | undefined {
  const payloadMessages: Array<AnthropicAssistantContext | ToolResultContext> =
    [];
  for (const message of messages) {
    if (message.type === 'ai') {
      payloadMessages.push({
        role: 'assistant',
        content: extractAnthropicContent(message.content),
        toolCalls: extractToolCalls(message),
      });
      continue;
    }
    const toolResult = extractToolResult(message);
    if (toolResult) payloadMessages.push(toolResult);
  }

  const hasPrivateContext = payloadMessages.some(
    (message) =>
      message.role === 'tool' ||
      message.toolCalls.length > 0 ||
      message.content.some(
        (block) =>
          block.type === 'thinking' || block.type === 'redacted_thinking',
      ),
  );
  if (!hasPrivateContext) {
    return undefined;
  }

  return modelContextEnvelopeSchema.parse({
    version: 1,
    ...identity,
    payload: { messages: payloadMessages },
  });
}

function extractGeminiContext(
  messages: BaseMessage[],
  identity: ModelContextIdentity,
): ModelContextEnvelope | undefined {
  const payloadMessages: Array<GeminiAssistantContext | ToolResultContext> = [];
  for (const message of messages) {
    if (message.type === 'ai') {
      payloadMessages.push({
        role: 'assistant',
        content: extractGeminiContent(message.content),
        toolCalls: extractToolCalls(message),
        thoughtSignatures: extractStringMap(
          message.additional_kwargs[GEMINI_TOOL_SIGNATURES_KEY],
        ),
      });
      continue;
    }
    const toolResult = extractToolResult(message);
    if (toolResult) payloadMessages.push(toolResult);
  }

  const hasPrivateContext = payloadMessages.some(
    (message) =>
      message.role === 'tool' ||
      message.toolCalls.length > 0 ||
      Object.keys(message.thoughtSignatures).length > 0 ||
      message.content.some((block) => block.type === 'thinking'),
  );
  if (!hasPrivateContext) {
    return undefined;
  }

  return modelContextEnvelopeSchema.parse({
    version: 1,
    ...identity,
    payload: { messages: payloadMessages },
  });
}

function extractToolCalls(message: BaseMessage): ToolCallContext[] {
  if (!AIMessage.isInstance(message)) {
    return [];
  }
  return (message.tool_calls ?? []).flatMap((toolCall) => {
    if (!toolCall.id || !toolCall.name || !isRecord(toolCall.args)) {
      return [];
    }
    return [
      {
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
      },
    ];
  });
}

function extractToolResult(
  message: BaseMessage,
): ToolResultContext | undefined {
  if (!ToolMessage.isInstance(message) || !message.tool_call_id) {
    return undefined;
  }
  return {
    role: 'tool' as const,
    content: serializeContent(message.content),
    toolCallId: message.tool_call_id,
    ...(message.name ? { name: message.name } : {}),
    ...(message.status ? { status: message.status } : {}),
  };
}

function extractAnthropicContent(content: unknown): AnthropicContentContext[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text' as const, text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: AnthropicContentContext[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text });
      continue;
    }
    if (
      item.type === 'thinking' &&
      typeof item.thinking === 'string' &&
      typeof item.signature === 'string' &&
      item.signature
    ) {
      blocks.push({
        type: 'thinking',
        thinking: item.thinking,
        signature: item.signature,
      });
      continue;
    }
    if (
      item.type === 'redacted_thinking' &&
      typeof item.data === 'string' &&
      item.data
    ) {
      blocks.push({ type: 'redacted_thinking', data: item.data });
    }
  }
  return blocks;
}

function extractGeminiContent(content: unknown): GeminiContentContext[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text' as const, text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: GeminiContentContext[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text });
      continue;
    }
    if (item.type === 'thinking' && typeof item.thinking === 'string') {
      blocks.push({
        type: 'thinking',
        thinking: item.thinking,
        ...(typeof item.signature === 'string' && item.signature
          ? { signature: item.signature }
          : {}),
      });
    }
  }
  return blocks;
}

function toToolMessage(message: {
  content: string;
  toolCallId: string;
  name?: string;
  status?: 'success' | 'error';
}) {
  return new ToolMessage({
    content: message.content,
    tool_call_id: message.toolCallId,
    ...(message.name ? { name: message.name } : {}),
    ...(message.status ? { status: message.status } : {}),
  });
}

function readTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .flatMap((item) =>
      isRecord(item) && item.type === 'text' && typeof item.text === 'string'
        ? [item.text]
        : [],
    )
    .join('');
}

function serializeContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  const serialized = JSON.stringify(content);
  if (serialized === undefined) {
    throw new Error('工具结果不是可序列化 JSON');
  }
  return serialized;
}

function extractStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  );
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
