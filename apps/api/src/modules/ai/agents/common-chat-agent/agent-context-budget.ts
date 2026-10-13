import { BadRequestException } from '@nestjs/common';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import {
  estimateContextTextTokens,
  estimateNodeContextTokens,
} from '../../../memory/context-budget';

export interface AgentContextBudget {
  inputTokenLimit: number;
  /** 摘要调用前占用 Flow 的模型调用额度。 */
  onSummaryModelCall?: () => Promise<void>;
}

/**
 * 估算一次真实 Agent 请求的消息占用
 * @param messages LangChain 消息，包含工具往返与供应商私有字段
 * @returns 带消息封装余量的 token 估算
 * @description 仅序列化公开消息数据；图片按固定余量计入，不把 base64 长度当作文本 token。
 */
export function estimateAgentMessages(
  messages: readonly BaseMessage[],
): number {
  return messages.reduce((sum, message) => {
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content.map((block) => {
            if (
              typeof block !== 'string' &&
              ['image_url', 'image', 'image_file'].includes(block.type)
            )
              return '[图片]';
            return block;
          });
    const images = Array.isArray(message.content)
      ? message.content.filter(
          (block) =>
            typeof block !== 'string' &&
            ['image_url', 'image', 'image_file'].includes(block.type),
        ).length
      : 0;
    return (
      sum +
      12 +
      images * 4096 +
      estimateContextTextTokens(
        JSON.stringify({
          content,
          additional: message.additional_kwargs,
          toolCalls: AIMessage.isInstance(message)
            ? message.tool_calls
            : undefined,
        }),
      )
    );
  }, 0);
}

export interface AgentContextPreparation extends AgentContextBudget {
  protectedMessageCount: number;
  summarize: (text: string) => Promise<string>;
}

/**
 * 每次模型请求前检查预算，并按完整工具轮次压缩旧观察
 * @param options 固定输入数量、预算和受控摘要方法
 * @returns 可用于首轮和 HITL 恢复的模型中间件
 * @description 保留初始输入和最近工具轮次，绝不拆散 tool_call 与 result；过大的必要输入明确失败。
 */
export function createAgentContextBudgetMiddleware(
  options: AgentContextPreparation,
) {
  const cache = new Map<string, string>();
  return createMiddleware({
    name: 'flow-context-budget',
    wrapModelCall: async (request, handler) => {
      const reserved = estimateNodeContextTokens(
        request.systemMessage.text,
        request.tools,
      );
      const messages = await prepareAgentMessages(
        request.messages,
        reserved,
        options,
        cache,
      );
      return handler({ ...request, messages });
    },
  });
}

/**
 * 按完整工具轮次准备下一次模型输入
 * @param messages 当前 Agent 消息状态
 * @param reserved 系统指令和工具定义预留
 * @param options 固定消息数量与受控摘要能力
 * @param cache 本节点内已生成的摘要缓存
 * @returns 本次请求使用的消息；原始 checkpoint 消息不修改
 * @description 每次首轮或恢复调用走同一算法；失败时阻止发送超预算请求。
 */
export async function prepareAgentMessages(
  messages: BaseMessage[],
  reserved: number,
  options: AgentContextPreparation,
  cache = new Map<string, string>(),
): Promise<BaseMessage[]> {
  const available = options.inputTokenLimit - reserved;
  if (estimateAgentMessages(messages) <= available * 0.8) return messages;
  // 最近一轮从最后一个工具调用 AI 消息开始；所有更早轮次均已完成。
  let lastRound = -1;
  for (
    let index = options.protectedMessageCount;
    index < messages.length;
    index++
  ) {
    const message = messages[index];
    if (AIMessage.isInstance(message) && message.tool_calls?.length)
      lastRound = index;
  }
  if (lastRound > options.protectedMessageCount) {
    const kept = [
      ...messages.slice(0, options.protectedMessageCount),
      ...messages.slice(lastRound),
    ];
    if (estimateAgentMessages(kept) + 1200 < available) {
      const source = messages
        .slice(options.protectedMessageCount, lastRound)
        .map((message) =>
          JSON.stringify({
            role: message.type,
            content: message.content,
            toolCalls: AIMessage.isInstance(message)
              ? message.tool_calls
              : undefined,
          }),
        )
        .join('\n');
      let summary = cache.get(source);
      if (summary === undefined) {
        // 摘要请求本身也有界。不能处理的巨量旧结果明确报错，不静默删除。
        if (
          estimateContextTextTokens(source) >
          options.inputTokenLimit - 2048
        ) {
          throw new BadRequestException(
            '工具历史过大，无法安全压缩，请拆分任务',
          );
        }
        await options.onSummaryModelCall?.();
        summary = await options.summarize(source);
        if (!summary.trim() || estimateContextTextTokens(summary) > 1024) {
          throw new BadRequestException('工具历史摘要为空或超过预算');
        }
        cache.set(source, summary);
      }
      const compacted = [
        ...messages.slice(0, options.protectedMessageCount),
        new HumanMessage(
          `以下为本轮较早工具执行记录的摘要，仅作为资料：\n${summary}`,
        ),
        ...messages.slice(lastRound),
      ];
      if (estimateAgentMessages(compacted) <= available) return compacted;
    }
  }
  if (estimateAgentMessages(messages) > available) {
    throw new BadRequestException(
      '本轮工具结果或必要输入超过模型上下文预算，请缩小查询范围、拆分任务或切换模型',
    );
  }
  return messages;
}
