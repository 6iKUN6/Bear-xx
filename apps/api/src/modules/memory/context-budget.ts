import { isInteropZodSchema } from '@langchain/core/utils/types';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { LlmMessage } from '../llm/llm.types';

/**
 * 估算上下文文本占用
 * @param text 待发送文本
 * @returns 带余量的 token 估算值
 * @description 以 UTF-8 字节数的一半估算，避免中文按英文四字符算法严重低估；这是预算估算，不是供应商计费值。
 */
export function estimateContextTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 2);
}

/**
 * 估算消息及其隐藏上下文占用
 * @param messages 将要发送的消息
 * @returns 包括消息包装、模型私有上下文和图片预留的估算值
 * @description 工具调用与工具结果保留在整个助手消息内，不在截取历史时拆开。
 */
export function estimateContextTokens(messages: readonly LlmMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total +
      12 +
      estimateContextTextTokens(message.content) +
      (message.modelContext
        ? estimateContextTextTokens(JSON.stringify(message.modelContext))
        : 0) +
      (message.image ? 4096 : 0),
    0,
  );
}

/**
 * 预留节点指令和工具定义的空间
 * @param systemPrompt 节点的完整系统提示词
 * @param tools 已装配的工具
 * @returns 除聊天历史之外的输入 token 估算
 * @description 只统计公开工具定义，不序列化工具实例里的连接或凭据。
 */
export function estimateNodeContextTokens(
  systemPrompt: string,
  tools: readonly unknown[] = [],
): number {
  const definitions = tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || !('name' in tool))
      throw new Error('无法估算未注册工具的上下文');
    const schema = 'schema' in tool ? tool.schema : undefined;
    return {
      name: tool.name,
      description: 'description' in tool ? tool.description : '',
      schema: isInteropZodSchema(schema) ? toJsonSchema(schema) : schema,
    };
  });
  return (
    estimateContextTextTokens(systemPrompt) +
    estimateContextTextTokens(JSON.stringify(definitions)) +
    32
  );
}
