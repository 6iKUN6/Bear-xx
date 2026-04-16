import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { LlmModelRegistryService } from './llm-model-registry.service';
import { OpenAiCompatibleLlmProvider } from './providers/openai-compatible-llm.provider';
import type {
  LlmMessage,
  LlmTextRequest,
  LlmStreamOptions,
  ResolvedLlmTextRequest,
} from './llm.types';

@Injectable()
export class LlmService {
  constructor(
    private readonly modelRegistry: LlmModelRegistryService,
    private readonly openAiCompatibleProvider: OpenAiCompatibleLlmProvider,
  ) {}

  /**
   * 流式生成聊天文本
   * @param messages 聊天消息列表
   * @param request 文本生成请求配置
   * @param options 流式运行时附加参数
   * @returns 返回文本分片异步迭代器
   * @description 解析模型选择配置后，使用 LangChain ChatOpenAI 流式生成文本，并仅向上层暴露纯文本分片。
   */
  async *streamChatText(
    messages: LlmMessage[],
    request?: LlmTextRequest | ResolvedLlmTextRequest,
    options?: LlmStreamOptions,
  ): AsyncGenerator<string> {
    const resolvedRequest = this.modelRegistry.resolveTextRequest(request);
    const chatModel = this.createChatModel(resolvedRequest);
    const langChainMessages = this.toLangChainMessages(messages);
    const stream = await chatModel.stream(langChainMessages, {
      signal: options?.abortSignal,
    });

    for await (const chunk of stream) {
      const delta = this.readChunkText(chunk.content);
      if (delta) {
        yield delta;
      }
    }
  }

  /**
   * 解析文本生成请求
   * @param request 文本生成请求配置
   * @returns 返回已解析完成的模型与生成参数配置
   * @description 统一处理 modelId、provider、platform、model 等选择条件，并合并预设默认参数与调用方覆盖参数。
   */
  resolveTextRequest(
    request?: LlmTextRequest | ResolvedLlmTextRequest,
  ): ResolvedLlmTextRequest {
    return this.modelRegistry.resolveTextRequest(request);
  }

  /**
   * 获取可用模型列表
   * @returns 返回当前可用的模型预设列表
   * @description 汇总内置模型预设与环境变量扩展配置，并过滤掉显式禁用的模型。
   */
  listAvailableModels() {
    return this.modelRegistry.listAvailableModels();
  }

  /**
   * 创建聊天模型实例
   * @param request 已解析的文本生成请求配置
   * @returns 返回可执行流式生成的 LangChain 聊天模型实例
   * @description 根据已解析的 provider 选择对应运行时实现；当前仅支持 OpenAI 兼容协议模型，因此统一委托给 OpenAI 兼容 provider 创建实例。
   */
  private createChatModel(request: ResolvedLlmTextRequest) {
    if (request.model.provider === 'openai') {
      return this.openAiCompatibleProvider.createChatModel(request);
    }

    throw new BadRequestException(
      `未找到对应的 LLM Provider: ${String(request.model.provider)}`,
    );
  }

  /**
   * 转换为 LangChain 消息列表
   * @param messages 通用聊天消息列表
   * @returns 返回 LangChain BaseMessage 数组
   * @description 将系统内部统一的消息结构转换为 LangChain 消费的消息对象，避免在业务层直接耦合 LangChain 消息类型。
   */
  private toLangChainMessages(messages: LlmMessage[]) {
    return messages.map((message) => {
      if (message.role === 'system') {
        return new SystemMessage(message.content);
      }

      if (message.role === 'assistant') {
        return new AIMessage(message.content);
      }

      return new HumanMessage(message.content);
    });
  }

  /**
   * 读取流式分片中的文本内容
   * @param content LangChain 返回的消息内容
   * @returns 返回当前分片中的纯文本内容
   * @description 兼容字符串和内容块数组两种返回结构，仅提取可直接用于 SSE delta 推送的文本部分。
   */
  private readChunkText(content: unknown): string {
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
        if (record.type !== 'text' || typeof record.text !== 'string') {
          return '';
        }

        return record.text;
      })
      .join('');
  }
}
