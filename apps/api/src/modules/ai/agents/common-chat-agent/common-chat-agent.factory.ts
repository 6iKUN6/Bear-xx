import { Injectable } from '@nestjs/common';
import {
  createAgent,
  type AgentTypeConfig,
  type AnyAgentMiddleware,
  type AnyAnnotationRoot,
  type ReactAgent,
  type ResponseFormatUndefined,
} from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ClientTool, ServerTool } from '@langchain/core/tools';

type CommonChatAgent = ReactAgent<
  AgentTypeConfig<
    ResponseFormatUndefined,
    undefined,
    AnyAnnotationRoot,
    readonly AnyAgentMiddleware[],
    readonly (ClientTool | ServerTool)[],
    readonly []
  >
>;

export interface CreateCommonChatAgentOptions {
  model: BaseChatModel;
  systemPrompt?: string;
  tools?: unknown[];
  middleware?: readonly AnyAgentMiddleware[];
}

@Injectable()
export class CommonChatAgentFactory {
  /**
   * 创建通用聊天 LangChain agent
   * @param options agent 创建参数
   * @returns 返回可执行 LangChain agent loop 的实例
   * @description 将 createAgent 收敛到 factory 中，后续接入 middleware、checkpointer 和其他智能体时避免业务层直接散落 LangChain 创建细节。
   */
  createAgent(options: CreateCommonChatAgentOptions): CommonChatAgent {
    return createAgent<
      undefined,
      AnyAnnotationRoot,
      readonly AnyAgentMiddleware[],
      readonly (ClientTool | ServerTool)[],
      readonly []
    >({
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools: this.toAgentTools(options.tools),
      middleware: options.middleware ?? [],
      name: 'common-chat-agent',
    });
  }

  private toAgentTools(
    tools: unknown[] | undefined,
  ): (ServerTool | ClientTool)[] {
    return (tools ?? []) as (ServerTool | ClientTool)[];
  }
}
