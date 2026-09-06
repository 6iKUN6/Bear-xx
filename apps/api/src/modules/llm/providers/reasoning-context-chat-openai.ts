import { AsyncLocalStorage } from 'node:async_hooks';

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { ChatOpenAICompletions } from '@langchain/openai';
import type { OpenAI } from 'openai';

type StreamingRequest = OpenAI.Chat.ChatCompletionCreateParamsStreaming;
type NonStreamingRequest = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

/**
 * 为 OpenAI-compatible Chat Completions 补回 assistant.reasoning_content。
 * @description LangChain 会读取上游 reasoning_content 到 AIMessage.additional_kwargs，
 * 但默认输入转换器不会在下一轮发回。这里只补该受控字段，其余请求构造、流解析、
 * 重试和工具调用仍完全复用官方 ChatOpenAICompletions。
 */
export class ReasoningContextChatOpenAICompletions extends ChatOpenAICompletions {
  private readonly inputMessages = new AsyncLocalStorage<BaseMessage[]>();

  override _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return this.inputMessages.run(messages, () =>
      super._generate(messages, options, runManager),
    );
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const iterator = super._streamResponseChunks(messages, options, runManager);
    while (true) {
      const next = await this.inputMessages.run(messages, () =>
        iterator.next(),
      );
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }

  override completionWithRetry(
    request: StreamingRequest,
    requestOptions?: OpenAI.RequestOptions,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
  override completionWithRetry(
    request: NonStreamingRequest,
    requestOptions?: OpenAI.RequestOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
  override completionWithRetry(
    request: StreamingRequest | NonStreamingRequest,
    requestOptions?: OpenAI.RequestOptions,
  ):
    | Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>
    | Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const messages = this.inputMessages.getStore();
    const mapped = messages
      ? {
          ...request,
          messages: addReasoningContent(request.messages, messages),
        }
      : request;
    return mapped.stream
      ? super.completionWithRetry(mapped, requestOptions)
      : super.completionWithRetry(mapped, requestOptions);
  }
}

export function addReasoningContent(
  requestMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  sourceMessages: BaseMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  let sourceIndex = 0;
  return requestMessages.map((requestMessage) => {
    const source = sourceMessages[sourceIndex];
    sourceIndex += 1;
    if (requestMessage.role !== 'assistant' || source?.type !== 'ai') {
      return requestMessage;
    }
    const reasoningContent = source.additional_kwargs.reasoning_content;
    if (typeof reasoningContent !== 'string' || !reasoningContent) {
      return requestMessage;
    }
    return { ...requestMessage, reasoning_content: reasoningContent };
  });
}
