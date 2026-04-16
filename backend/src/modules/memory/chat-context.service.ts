import { Injectable } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { LlmMessage } from '../llm/llm.types';
import { ConversationSummaryService } from './conversation-summary.service';
import { CHAT_CONTEXT_RECENT_MESSAGE_LIMIT } from './memory.constants';

@Injectable()
export class ChatContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationSummaryService: ConversationSummaryService,
  ) {}

  /**
   * 构建聊天上下文消息列表
   * @param conversationId 会话ID
   * @param pendingMessageId 当前待生成的 assistant 消息ID
   * @returns 返回可直接传给 LLM 的上下文消息列表
   * @description 组合会话摘要和最近窗口消息，替代全量历史回放，减少长会话的上下文长度和查询负担。
   */
  async buildChatMessages(
    conversationId: string,
    pendingMessageId: string,
  ): Promise<LlmMessage[]> {
    const summary =
      await this.conversationSummaryService.getConversationSummary(
        conversationId,
      );
    const recentMessages = await this.prisma.message.findMany({
      where: {
        conversationId,
        id: { not: pendingMessageId },
      },
      select: {
        role: true,
        content: true,
      },
      orderBy: { createdAt: 'desc' },
      take: CHAT_CONTEXT_RECENT_MESSAGE_LIMIT,
    });

    const contextMessages: LlmMessage[] = [];

    if (summary?.summary) {
      contextMessages.push({
        role: 'system',
        content: `以下是该会话较早历史的摘要，请在后续回答中延续这些上下文信息：\n${summary.summary}`,
      });
    }

    return contextMessages.concat(
      recentMessages.reverse().map((message) => ({
        role: this.toLlmMessageRole(message.role),
        content: message.content,
      })),
    );
  }

  /**
   * 转换消息角色
   * @param role 数据库中的消息角色枚举
   * @returns 返回 LLM 可识别的消息角色
   * @description 将数据库层的 USER 和 ASSISTANT 枚举转换为统一的 LLM 消息角色字符串，避免在调用方重复判断。
   */
  private toLlmMessageRole(role: MessageRole): 'user' | 'assistant' {
    return role === MessageRole.USER ? 'user' : 'assistant';
  }
}
