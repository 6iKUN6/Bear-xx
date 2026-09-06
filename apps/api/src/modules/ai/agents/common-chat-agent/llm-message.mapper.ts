/**
 * 项目内部消息 → LangChain 消息
 *
 * 抽成纯函数模块：ReAct 链路（agent loop service）与 plan/hybrid 编排图都要做这层转换，
 * 各写一份就会在新增角色时漏改一侧。
 */

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { LlmMessage } from '../../../llm/llm.types';
import type { ModelContextIdentity } from '../../../llm/model-context.schema';
import { replayModelContext } from '../../../llm/model-context';

/**
 * 转换为 LangChain 消息列表
 * @param messages 通用聊天消息列表
 * @returns 返回 LangChain BaseMessage 数组
 */
export function toLangChainMessages(
  messages: LlmMessage[],
  modelContextIdentity?: ModelContextIdentity,
  onInvalidModelContext?: () => void,
): BaseMessage[] {
  return messages.flatMap((message) => {
    if (message.role === 'system') {
      return [new SystemMessage(message.content)];
    }

    if (message.role === 'assistant') {
      if (modelContextIdentity && message.modelContext !== undefined) {
        try {
          const replayed = replayModelContext(
            message.modelContext,
            modelContextIdentity,
          );
          if (replayed) {
            return replayed;
          }
        } catch {
          onInvalidModelContext?.();
        }
      }
      return [new AIMessage(message.content)];
    }

    return [new HumanMessage(message.content)];
  });
}
