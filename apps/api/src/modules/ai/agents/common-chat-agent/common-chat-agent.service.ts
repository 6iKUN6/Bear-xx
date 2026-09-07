import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApprovalDecision } from '@litter-bear/types/protocol';
import type { ReasoningSelection } from '@litter-bear/types';
import type { BaseMessage } from '@langchain/core/messages';
import { LlmService } from '../../../llm/llm.service';
import type {
  LlmGenerationConfig,
  LlmMessage,
  LlmModelPreset,
  LlmTextRequest,
  LlmVisionRequestTransform,
  ResolvedLlmTextRequest,
} from '../../../llm/llm.types';
import {
  createReasoningFingerprint,
  findModelReasoningCapability,
} from '../../../llm/model-reasoning.catalog';
import { extractModelContext } from '../../../llm/model-context';
import type {
  ModelContextEnvelope,
  ModelContextIdentity,
} from '../../../llm/model-context.schema';
import { CommonChatAgentLoopService } from './common-chat-agent-loop.service';
import type { CommonChatAgentStreamEvent } from './common-chat-agent.types';
import { toLangChainMessages } from './llm-message.mapper';

export interface CommonChatAgentRequest {
  modelPreset?: string | LlmModelPreset;
  llm?: LlmTextRequest | ResolvedLlmTextRequest;
  messages: LlmMessage[];
  systemPrompt?: string;
  generation?: LlmGenerationConfig;
  reasoning?: ReasoningSelection;
  tools?: unknown[];
  /** HITL 会话标识（checkpointer thread_id）；= taskId */
  threadId?: string;
  /** 需要人工审批的工具名，驱动 HITL 中间件 interruptOn */
  approvalToolNames?: string[];
  abortSignal?: AbortSignal;
  /** 底层模型每被真实调用一次回调一次；见 CommonChatAgentLoopRequest.onModelTurn */
  onModelTurn?: () => void;
  /** 仅最终回答节点传入；正常完成后接收严格校验的隐藏模型上下文。 */
  onCompletedModelContext?: (
    context: ModelContextEnvelope,
  ) => void | Promise<void>;
  /** K3 等不接受公网图片 URL 时使用；仅存在于当前 Worker 内存。 */
  visionTransform?: LlmVisionRequestTransform;
}

@Injectable()
export class CommonChatAgentService {
  constructor(
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
    private readonly commonChatAgentLoopService: CommonChatAgentLoopService,
  ) {}

  /**
   * 流式执行通用聊天智能体并返回结构化事件
   * @param request 通用聊天智能体请求配置
   * @returns 返回智能体结构化事件流
   * @description 在 agent 层完成消息组装、模型创建、可选工具绑定和 chunk 解析，为后续工具调用链保留独立事件通道。
   */
  streamEvents(
    request: CommonChatAgentRequest,
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const llmRequest = this.buildLlmRequest(request);

    return this.createEventStream(request, llmRequest);
  }

  /**
   * 恢复被人工审批挂起的智能体（HITL）
   * @param request 通用聊天请求 + 人工审批决定
   * @returns 返回续跑的结构化事件流
   * @description 用与首轮一致的模型/工具/thread_id 重建 agent，把人工决定通过 Command 送回中断处续跑。
   */
  resumeEvents(
    request: CommonChatAgentRequest & { decision: ApprovalDecision },
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const llmRequest = this.buildLlmRequest(request);

    return this.createResumeStream(request, llmRequest);
  }

  /**
   * 解析文本生成请求
   * @param request 文本生成请求配置
   * @returns 返回已解析完成的模型与生成参数配置
   * @description 对外暴露 agent 使用的模型解析能力，让聊天任务模块不需要直接依赖 LLM 模块。
   */
  resolveTextRequest(
    request?: LlmTextRequest | ResolvedLlmTextRequest,
  ): ResolvedLlmTextRequest {
    return this.llmService.resolveTextRequest(request);
  }

  /**
   * 构建模型请求配置
   * @param request 通用聊天智能体请求配置
   * @returns 返回 llm 模块可直接消费的模型请求配置
   * @description 支持传入模型预设 ID 或完整模型预设对象；若为完整预设对象，则直接构造已解析请求，避免依赖预注册模型列表。
   */
  private buildLlmRequest(
    request: CommonChatAgentRequest,
  ): LlmTextRequest | ResolvedLlmTextRequest {
    if (request.llm) {
      return request.llm;
    }

    if (typeof request.modelPreset === 'string') {
      return {
        model: {
          modelId: request.modelPreset,
        },
        generation: request.generation,
        reasoning: request.reasoning,
      };
    }

    if (!request.modelPreset) {
      return {
        generation: request.generation,
        reasoning: request.reasoning,
      };
    }

    return {
      model: {
        id: request.modelPreset.id,
        provider: request.modelPreset.provider,
        platform: request.modelPreset.platform,
        model: request.modelPreset.model,
        apiKey: request.modelPreset.apiKey,
        baseURL: request.modelPreset.baseURL,
      },
      generation: {
        temperature:
          request.generation?.temperature ?? request.modelPreset.temperature,
        maxOutputTokens:
          request.generation?.maxOutputTokens ??
          request.modelPreset.maxOutputTokens,
        topP: request.generation?.topP ?? request.modelPreset.topP,
      },
      reasoning: request.reasoning,
    };
  }

  /**
   * 创建智能体事件流
   * @param messages 聊天消息列表
   * @param llmRequest 模型请求配置
   * @param tools 可选工具列表
   * @param abortSignal 中断信号
   * @returns 返回智能体结构化事件异步迭代器
   * @description 在 agent 层消费模型原始 chunk，并拆分成文本增量和工具调用增量事件。
   */
  private async *createEventStream(
    request: CommonChatAgentRequest,
    llmRequest: LlmTextRequest | ResolvedLlmTextRequest,
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const resolvedRequest = this.llmService.resolveTextRequest(llmRequest);
    const chatModel = this.llmService.createChatModel(
      resolvedRequest,
      request.visionTransform,
    );
    const modelContext = this.prepareModelContext(request, resolvedRequest);

    this.debugLog('agent.common_chat.request', {
      model: this.toSafeModelLog(resolvedRequest),
      messageCount: request.messages.length,
      generation: resolvedRequest.generation,
      toolCount: request.tools?.length ?? 0,
      hasSystemPrompt: Boolean(request.systemPrompt),
      hasAbortSignal: Boolean(request.abortSignal),
      approvalToolCount: request.approvalToolNames?.length ?? 0,
    });

    for await (const event of this.commonChatAgentLoopService.stream({
      model: chatModel,
      messages: modelContext.messages,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      threadId: request.threadId,
      approvalToolNames: request.approvalToolNames,
      abortSignal: request.abortSignal,
      onModelTurn: request.onModelTurn,
      onCompletedMessages: modelContext.onCompletedMessages,
    })) {
      yield event;
    }
  }

  /**
   * 创建恢复事件流
   * @param request 通用聊天请求 + 人工审批决定
   * @param llmRequest 模型请求配置
   * @returns 返回续跑的结构化事件异步迭代器
   * @description 重建模型后委托 loop.resume 用 Command 从中断处续跑。
   */
  private async *createResumeStream(
    request: CommonChatAgentRequest & { decision: ApprovalDecision },
    llmRequest: LlmTextRequest | ResolvedLlmTextRequest,
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const resolvedRequest = this.llmService.resolveTextRequest(llmRequest);
    const chatModel = this.llmService.createChatModel(
      resolvedRequest,
      request.visionTransform,
    );
    const modelContext = this.prepareModelContext(request, resolvedRequest);

    for await (const event of this.commonChatAgentLoopService.resume({
      model: chatModel,
      messages: modelContext.messages,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      threadId: request.threadId,
      approvalToolNames: request.approvalToolNames,
      decision: request.decision,
      abortSignal: request.abortSignal,
      onModelTurn: request.onModelTurn,
      onCompletedMessages: modelContext.onCompletedMessages,
    })) {
      yield event;
    }
  }

  private prepareModelContext(
    request: CommonChatAgentRequest,
    resolvedRequest: ResolvedLlmTextRequest,
  ): {
    messages: BaseMessage[];
    onCompletedMessages?: (messages: BaseMessage[]) => Promise<void>;
  } {
    const identity = this.createModelContextIdentity(resolvedRequest);
    let invalidContextCount = 0;
    const messages = toLangChainMessages(request.messages, identity, () => {
      invalidContextCount += 1;
    });
    if (invalidContextCount > 0) {
      this.warnModelContext('model_context.replay_rejected', resolvedRequest, {
        count: invalidContextCount,
      });
    }

    if (!identity || !request.onCompletedModelContext) {
      return { messages };
    }
    return {
      messages,
      onCompletedMessages: async (completedMessages) => {
        try {
          const context = extractModelContext(completedMessages, identity);
          if (context) {
            await request.onCompletedModelContext?.(context);
          }
        } catch {
          this.warnModelContext(
            'model_context.extraction_failed',
            resolvedRequest,
            { messageCount: completedMessages.length },
          );
        }
      },
    };
  }

  private createModelContextIdentity(
    request: ResolvedLlmTextRequest,
  ): ModelContextIdentity | undefined {
    const capability = findModelReasoningCapability(
      request.model.platform,
      request.model.upstreamFormat,
      request.model.model,
    );
    if (!capability || capability.contextPolicy === 'none') {
      return undefined;
    }
    return {
      providerKey: request.model.platform,
      upstreamFormat: request.model.upstreamFormat,
      model: request.model.model,
      reasoningFingerprint: createReasoningFingerprint(
        request.model.platform,
        request.model.upstreamFormat,
        request.model.model,
        request.reasoning,
      ),
      policy: capability.contextPolicy,
    };
  }

  private warnModelContext(
    event: string,
    request: ResolvedLlmTextRequest,
    detail: Record<string, number>,
  ): void {
    const capability = findModelReasoningCapability(
      request.model.platform,
      request.model.upstreamFormat,
      request.model.model,
    );
    Logger.warn(
      this.formatLog(event, {
        version: 1,
        providerKey: request.model.platform,
        upstreamFormat: request.model.upstreamFormat,
        model: request.model.model,
        policy: capability?.contextPolicy ?? 'none',
        ...detail,
      }),
      CommonChatAgentService.name,
    );
  }

  private toSafeModelLog(request: ResolvedLlmTextRequest) {
    return {
      id: request.model.id,
      provider: request.model.provider,
      platform: request.model.platform,
      model: request.model.model,
      baseURL: this.toSafeBaseUrl(request.model.baseURL),
      hasApiKey: Boolean(request.model.apiKey),
    };
  }

  private toSafeBaseUrl(baseURL: string | undefined) {
    if (!baseURL) {
      return undefined;
    }

    try {
      const url = new URL(baseURL);
      return url.origin;
    } catch {
      return '[invalid-url]';
    }
  }

  private formatLog(event: string, payload: Record<string, unknown>) {
    return JSON.stringify({
      event,
      ...payload,
    });
  }

  private debugLog(event: string, payload: Record<string, unknown>) {
    if (!this.isDebugEnabled()) {
      return;
    }

    Logger.log(this.formatLog(event, payload), CommonChatAgentService.name);
  }

  private isDebugEnabled() {
    return this.readBooleanConfig('LLM_DEBUG');
  }

  private readBooleanConfig(key: string) {
    const value = this.configService.get<string>(key);
    return value === 'true' || value === '1';
  }
}
