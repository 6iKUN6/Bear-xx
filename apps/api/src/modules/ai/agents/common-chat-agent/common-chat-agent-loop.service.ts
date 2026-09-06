import { Injectable } from '@nestjs/common';
import { Command } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { ApprovalDecision } from '@litter-bear/types/protocol';
import {
  type CommonChatAgentLoopRequest,
  type CommonChatAgentStreamEvent,
} from './common-chat-agent.types';
import { CommonChatAgentFactory } from './common-chat-agent.factory';
import { AgentCheckpointerService } from './agent-checkpointer.service';
import {
  buildHitlMiddleware,
  buildHitlResponse,
  emitApprovalFromValue,
  readInterruptValue,
  type InterruptReadable,
} from './agent-hitl';
import {
  mapMessagesStream,
  type MessagesModeChunk,
} from './agent-message-stream.mapper';

/** 运行时可流式 + 可读状态的最小 agent 接口（绕开 langchain 重型泛型） */
interface StreamableAgent extends InterruptReadable {
  stream(
    input: unknown,
    config: Record<string, unknown>,
  ): Promise<AsyncIterable<MessagesModeChunk>>;
}

/** approval.required 的节点标识（ReAct 链路） */
const APPROVAL_NODE_KEY = 'common_chat_approval';

@Injectable()
export class CommonChatAgentLoopService {
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

    const runnable = agent as unknown as StreamableAgent;
    const collected = new CompletedMessageCollector();
    const stream = await runnable.stream(
      { messages: request.messages },
      config,
    );
    for await (const { event } of mapMessagesStream(
      stream,
      request.onModelTurn,
      (chunk, namespace) => collected.add(chunk, namespace),
    )) {
      yield event;
    }

    if (hitlTools.length > 0 && request.threadId) {
      const interrupt = await readInterruptValue(runnable, request.threadId);
      if (interrupt) {
        yield* emitApprovalFromValue(interrupt, APPROVAL_NODE_KEY);
        return;
      }
      await request.onCompletedMessages?.(
        await this.readNewStateMessages(
          runnable,
          request.threadId,
          request.messages.length,
        ),
      );
      return;
    }
    await request.onCompletedMessages?.(collected.finish());
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
      (await readInterruptValue(runnable, request.threadId))?.actionRequests ??
      [];
    const resumeValue = buildHitlResponse(request.decision, actionRequests);

    const stream = await runnable.stream(
      new Command({ resume: resumeValue }),
      this.buildStreamConfig(request, true),
    );
    for await (const { event } of mapMessagesStream(
      stream,
      request.onModelTurn,
    )) {
      yield event;
    }

    const interrupt = await readInterruptValue(runnable, request.threadId);
    if (interrupt) {
      yield* emitApprovalFromValue(interrupt, APPROVAL_NODE_KEY);
      return;
    }
    await request.onCompletedMessages?.(
      await this.readNewStateMessages(
        runnable,
        request.threadId,
        request.messages.length,
      ),
    );
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
      middleware: useHitl ? buildHitlMiddleware(hitlTools) : [],
      checkpointer: useHitl ? this.checkpointer.get() : undefined,
    });
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

  private async readNewStateMessages(
    agent: StreamableAgent,
    threadId: string,
    inputMessageCount: number,
  ): Promise<BaseMessage[]> {
    const state = await agent.getState({
      configurable: { thread_id: threadId },
    });
    return (state.values?.messages ?? []).slice(inputMessageCount);
  }
}

/** 普通无 checkpoint 流中按模型轮次合并 AI chunk，并保留工具结果顺序。 */
class CompletedMessageCollector {
  private readonly messages: BaseMessage[] = [];
  private pendingAi?: { turnKey?: string; message: AIMessageChunk };

  add([message, metadata]: MessagesModeChunk, namespace: string[]): void {
    if (AIMessageChunk.isInstance(message)) {
      const turnKey = createTurnKey(metadata, namespace);
      if (
        this.pendingAi &&
        (this.pendingAi.turnKey === turnKey ||
          (!this.pendingAi.turnKey && !turnKey))
      ) {
        this.pendingAi.message = this.pendingAi.message.concat(message);
        return;
      }
      this.flushAi();
      this.pendingAi = { turnKey, message };
      return;
    }

    this.flushAi();
    if (message.type === 'tool') {
      this.messages.push(message);
    }
  }

  finish(): BaseMessage[] {
    this.flushAi();
    return [...this.messages];
  }

  private flushAi(): void {
    if (!this.pendingAi) {
      return;
    }
    this.messages.push(this.pendingAi.message);
    this.pendingAi = undefined;
  }
}

function createTurnKey(
  metadata: Record<string, unknown>,
  namespace: string[],
): string | undefined {
  const node = metadata.langgraph_node;
  const step = metadata.langgraph_step;
  return typeof node === 'string' && typeof step === 'number'
    ? `${namespace.join('/')}#${node}#${step}`
    : undefined;
}
