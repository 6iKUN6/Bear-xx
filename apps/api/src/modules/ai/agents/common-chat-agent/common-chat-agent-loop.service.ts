import { Injectable, Logger } from '@nestjs/common';
import { humanInTheLoopMiddleware, type AnyAgentMiddleware } from 'langchain';
import { Command } from '@langchain/langgraph';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type {
  AIMessageChunk,
  BaseMessage,
  BaseMessageChunk,
  ToolMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  ApprovalDecision,
  ApprovalDecisionType,
} from '@litter-bear/types/protocol';
import type { LlmMessage } from '../../../llm/llm.types';
import {
  type CommonChatAgentLoopRequest,
  type CommonChatAgentStreamEvent,
} from './common-chat-agent.types';
import { CommonChatAgentFactory } from './common-chat-agent.factory';
import { AgentCheckpointerService } from './agent-checkpointer.service';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';

type MessagesModeChunk = [BaseMessageChunk, Record<string, unknown>];

/** 运行时可流式 + 可读状态的最小 agent 接口（绕开 langchain 重型泛型） */
interface StreamableAgent {
  stream(
    input: unknown,
    config: Record<string, unknown>,
  ): Promise<AsyncIterable<MessagesModeChunk>>;
  getState(config: Record<string, unknown>): Promise<AgentStateLike>;
}

interface AgentStateLike {
  tasks?: Array<{ interrupts?: Array<{ value?: unknown }> }>;
  next?: readonly string[];
}

/** HITL 中断值（humanInTheLoopMiddleware 通过 interrupt() 抛出的 HITLRequest） */
interface HitlActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}
interface HitlReviewConfig {
  actionName: string;
  allowedDecisions: ApprovalDecisionType[];
}
interface HitlRequestValue {
  actionRequests?: HitlActionRequest[];
  reviewConfigs?: HitlReviewConfig[];
}
/** HITL 恢复值（Command.resume 回传的 HITLResponse.decisions 元素） */
type HitlDecision =
  | { type: 'approve' }
  | {
      type: 'edit';
      editedAction: { name: string; args: Record<string, unknown> };
    }
  | { type: 'reject'; message?: string };

@Injectable()
export class CommonChatAgentLoopService {
  private readonly logger = new Logger(CommonChatAgentLoopService.name);

  constructor(
    private readonly agentFactory: CommonChatAgentFactory,
    private readonly checkpointer: AgentCheckpointerService,
  ) {}

  /**
   * 执行通用聊天 agent loop（首轮）
   * @param request agent loop 请求参数
   * @returns 返回项目内部统一的 agent 结构化事件流
   * @description 用 stream({ streamMode: 'messages' }) 消费单条有序消息流映射为 message.delta / tool.call.* 事件。
   * 当存在需审批工具且带 threadId 时启用 HITL：挂 checkpointer + humanInTheLoopMiddleware，工具执行前中断，
   * 流结束后检测挂起中断并发出 approval.required 事件（任务转入等待人工审批）。
   */
  async *stream(
    request: CommonChatAgentLoopRequest & { model: BaseChatModel },
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const hitlTools = this.resolveHitlTools(request);
    const agent = this.buildAgent(request, hitlTools);
    const config = this.buildStreamConfig(request, hitlTools.length > 0);

    const stream = await (agent as unknown as StreamableAgent).stream(
      { messages: this.toLangChainMessages(request.messages) },
      config,
    );
    yield* this.mapMessagesStream(stream);

    if (hitlTools.length > 0 && request.threadId) {
      yield* this.emitPendingApproval(agent, request.threadId);
    }
  }

  /**
   * 恢复被人工审批挂起的 agent loop
   * @param request 恢复请求（需 threadId + 与首轮一致的 model/tools/systemPrompt + 人工决定）
   * @returns 返回续跑的结构化事件流
   * @description 用同一 checkpointer + thread_id 重建 agent，把人工决定映射为 HITLResponse，
   * 通过 Command({ resume }) 从中断处续跑（approve 执行工具 / reject 回注拒绝 / edit 用改后入参执行）。
   */
  async *resume(
    request: CommonChatAgentLoopRequest & {
      model: BaseChatModel;
      decision: ApprovalDecision;
    },
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    if (!request.threadId) {
      throw new Error('resume requires threadId');
    }

    const hitlTools = request.approvalToolNames ?? [];
    const agent = this.buildAgent(request, hitlTools);
    const runnable = agent as unknown as StreamableAgent;

    const actionRequests =
      (await this.readInterruptValue(runnable, request.threadId))
        ?.actionRequests ?? [];
    const resumeValue = this.buildHitlResponse(
      request.decision,
      actionRequests,
    );

    const stream = await runnable.stream(
      new Command({ resume: resumeValue }),
      this.buildStreamConfig(request, true),
    );
    yield* this.mapMessagesStream(stream);

    yield* this.emitPendingApproval(agent, request.threadId);
  }

  private resolveHitlTools(request: CommonChatAgentLoopRequest): string[] {
    if (!request.threadId) {
      return [];
    }
    return request.approvalToolNames ?? [];
  }

  private buildAgent(
    request: CommonChatAgentLoopRequest & { model: BaseChatModel },
    hitlTools: string[],
  ) {
    const useHitl = hitlTools.length > 0;
    return this.agentFactory.createAgent({
      model: request.model,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      middleware: useHitl ? this.buildHitlMiddleware(hitlTools) : [],
      checkpointer: useHitl ? this.checkpointer.get() : undefined,
    });
  }

  private buildHitlMiddleware(hitlTools: string[]): AnyAgentMiddleware[] {
    const interruptOn: Record<
      string,
      { allowedDecisions: ApprovalDecisionType[]; description: string }
    > = {};
    for (const name of hitlTools) {
      interruptOn[name] = {
        allowedDecisions: ['approve', 'edit', 'reject'],
        description: `请确认是否执行工具「${name}」`,
      };
    }
    return [humanInTheLoopMiddleware({ interruptOn })];
  }

  private buildStreamConfig(
    request: CommonChatAgentLoopRequest,
    useHitl: boolean,
  ): Record<string, unknown> {
    return {
      streamMode: 'messages',
      signal: request.abortSignal,
      configurable:
        useHitl && request.threadId ? { thread_id: request.threadId } : {},
    };
  }

  /**
   * 检测挂起的人工审批中断并发出 approval.required
   * @param agent 已运行到中断的 agent
   * @param threadId 会话标识
   */
  private async *emitPendingApproval(
    agent: unknown,
    threadId: string,
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const value = await this.readInterruptValue(
      agent as StreamableAgent,
      threadId,
    );
    if (!value) {
      return;
    }

    const reviewConfigs = value.reviewConfigs ?? [];
    const actionRequests = value.actionRequests ?? [];
    for (let index = 0; index < actionRequests.length; index++) {
      const action = actionRequests[index];
      const review = reviewConfigs.find((r) => r.actionName === action.name);
      yield {
        type: StreamTaskEventType.ApprovalRequired,
        payload: {
          toolName: action.name,
          args: this.stringifyArgs(action.args),
          description: action.description,
          allowedDecisions: review?.allowedDecisions ?? ['approve', 'reject'],
          index,
          nodeKey: 'common_chat_approval',
          traceKey: `approval:${action.name}:${index}`,
          publicStatus: '待人工确认',
        },
      };
    }
  }

  /**
   * 从 checkpointer 状态读取挂起的 HITL 中断值
   * @returns 中断的 HITLRequest 值；无挂起则返回 undefined
   */
  private async readInterruptValue(
    agent: StreamableAgent,
    threadId: string,
  ): Promise<HitlRequestValue | undefined> {
    const state = await agent.getState({
      configurable: { thread_id: threadId },
    });
    const interrupts = (state.tasks ?? []).flatMap(
      (task) => task.interrupts ?? [],
    );
    const value = interrupts[0]?.value;
    if (value && typeof value === 'object') {
      return value;
    }
    return undefined;
  }

  /**
   * 把人工决定映射为 HITLResponse
   * @description approve → 执行；reject → 回注拒绝说明；edit → 用改后入参执行。每个 action 对应一个决定。
   */
  private buildHitlResponse(
    decision: ApprovalDecision,
    actionRequests: HitlActionRequest[],
  ): { decisions: HitlDecision[] } {
    const count = Math.max(1, actionRequests.length);
    const decisions: HitlDecision[] = [];
    for (let index = 0; index < count; index++) {
      const action: HitlActionRequest | undefined = actionRequests[index];
      if (decision.decision === 'approve') {
        decisions.push({ type: 'approve' });
      } else if (decision.decision === 'reject') {
        decisions.push({ type: 'reject', message: decision.reason });
      } else {
        decisions.push({
          type: 'edit',
          editedAction: {
            name: action?.name ?? '',
            args: decision.editedArgs ?? action?.args ?? {},
          },
        });
      }
    }
    return { decisions };
  }

  private stringifyArgs(args: unknown): string | undefined {
    if (args === undefined || args === null) {
      return undefined;
    }
    try {
      return typeof args === 'string' ? args : JSON.stringify(args);
    } catch {
      return undefined;
    }
  }

  /**
   * 映射 messages 模式消息流为统一事件
   * @param stream agent.stream({ streamMode: 'messages' }) 的产出
   * @description ai 文本 → message.delta；tool_call_chunks → tool.call.start/delta；ToolMessage → done/error。
   */
  private async *mapMessagesStream(
    stream: AsyncIterable<MessagesModeChunk>,
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const toolIndexById = new Map<string, number>();
    const toolNameById = new Map<string, string>();
    let nextToolIndex = 0;
    let lastToolCallId: string | undefined;

    for await (const [message] of stream) {
      const messageType = message.getType();

      if (messageType === 'tool') {
        yield this.buildToolResultEvent(
          message as unknown as ToolMessage,
          toolIndexById,
          toolNameById,
        );
        continue;
      }

      if (messageType !== 'ai') {
        continue;
      }

      const aiChunk = message as AIMessageChunk;

      const text = this.readMessageText(aiChunk.content);
      if (text) {
        yield { type: StreamTaskEventType.MessageDelta, delta: text };
      }

      for (const chunk of aiChunk.tool_call_chunks ?? []) {
        const callId = this.readOptionalString(chunk.id) ?? lastToolCallId;
        if (!callId) {
          continue;
        }
        lastToolCallId = callId;

        const chunkName = this.readOptionalString(chunk.name);
        if (chunkName && !toolNameById.has(callId)) {
          toolNameById.set(callId, chunkName);
        }

        if (!toolIndexById.has(callId)) {
          const index = nextToolIndex;
          nextToolIndex += 1;
          toolIndexById.set(callId, index);

          const name = toolNameById.get(callId);
          yield {
            type: StreamTaskEventType.ToolCallStart,
            payload: this.buildToolPayload(callId, name, index, {
              publicStatus: `正在调用工具${this.formatNameSuffix(name)}`,
            }),
          };
        }

        yield {
          type: StreamTaskEventType.ToolCallDelta,
          toolCallId: callId,
          name: toolNameById.get(callId),
          args: this.readOptionalString(chunk.args),
          index: toolIndexById.get(callId),
        };
      }
    }
  }

  /**
   * 转换为 LangChain 消息列表
   * @param messages 通用聊天消息列表
   * @returns 返回 LangChain BaseMessage 数组
   */
  private toLangChainMessages(messages: LlmMessage[]): BaseMessage[] {
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
   * 构建工具执行结果事件
   */
  private buildToolResultEvent(
    message: ToolMessage,
    toolIndexById: Map<string, number>,
    toolNameById: Map<string, string>,
  ): CommonChatAgentStreamEvent {
    const callId = this.readOptionalString(message.tool_call_id);
    const index = callId ? (toolIndexById.get(callId) ?? -1) : -1;
    const name = callId ? toolNameById.get(callId) : undefined;
    const content = this.readMessageText(message.content);

    if (this.readOptionalString(message.status) === 'error') {
      const errorMessage = content || '工具调用失败';
      return {
        type: StreamTaskEventType.ToolCallError,
        payload: this.buildToolPayload(callId, name, index, {
          publicStatus: `工具调用失败${this.formatNameSuffix(name)}`,
          message: errorMessage,
          error: { message: errorMessage },
        }),
      };
    }

    return {
      type: StreamTaskEventType.ToolCallDone,
      payload: this.buildToolPayload(callId, name, index, {
        publicStatus: `工具调用完成${this.formatNameSuffix(name)}`,
        outputSummary: this.toJsonSummary(message.content),
      }),
    };
  }

  private buildToolPayload(
    callId: string | undefined,
    name: string | undefined,
    index: number,
    extra: Record<string, unknown>,
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

  private formatNameSuffix(value: unknown) {
    const name = this.readOptionalString(value);
    return name ? `：${name}` : '';
  }

  private readOptionalString(value: unknown) {
    return typeof value === 'string' && value ? value : undefined;
  }

  /**
   * 读取消息内容中的纯文本
   */
  private readMessageText(content: unknown): string {
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

  private toJsonSummary(value: unknown) {
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
      } catch (error) {
        this.logger.warn(
          `Serialize tool output failed: ${(error as Error).message}`,
        );
        return { value: '[unserializable]' };
      }
    }

    return { value: '[unsupported]' };
  }
}
