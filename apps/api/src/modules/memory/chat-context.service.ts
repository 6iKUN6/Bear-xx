import { Injectable } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { LlmMessage } from '../llm/llm.types';
import { ConversationSummaryService } from './conversation-summary.service';
import { CHAT_CONTEXT_RECENT_MESSAGE_LIMIT } from './memory.constants';

export interface ChatContextBundle {
  messages: LlmMessage[];
  summary?: {
    content: string;
    latestMessageId?: string;
    messageCount: number;
  };
  recentWindow: {
    limit: number;
    messageCount: number;
  };
}

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
    const bundle = await this.buildContextBundle(
      conversationId,
      pendingMessageId,
    );
    return bundle.messages;
  }

  /**
   * 构建聊天上下文包
   * @param conversationId 会话ID
   * @param pendingMessageId 当前待生成的 assistant 消息ID
   * @returns 返回包含 LLM 消息、摘要信息和最近窗口信息的上下文包
   * @description 第一版上下文管理以“较早历史摘要 + 最近消息窗口”为核心，集中记录上下文来源，便于后续加入 token 预算和长期记忆。
   */
  async buildContextBundle(
    conversationId: string,
    pendingMessageId: string,
  ): Promise<ChatContextBundle> {
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
        content: this.formatSummaryContextMessage(summary.summary),
      });
    }

    const messages = contextMessages.concat(
      recentMessages.reverse().map((message) => ({
        role: this.toLlmMessageRole(message.role),
        content: message.content,
      })),
    );

    return {
      messages,
      summary: summary?.summary
        ? {
            content: summary.summary,
            latestMessageId: summary.latestMessageId ?? undefined,
            messageCount: summary.messageCount,
          }
        : undefined,
      recentWindow: {
        limit: CHAT_CONTEXT_RECENT_MESSAGE_LIMIT,
        messageCount: recentMessages.length,
      },
    };
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

  /**
   * 格式化摘要上下文消息
   * @param summary 会话较早历史摘要
   * @returns 返回注入 LLM 的 system 上下文消息
   * @description 明确摘要只用于延续上下文，并要求最近消息优先于摘要，降低旧摘要和最新对话冲突时的误用风险。
   */
  private formatSummaryContextMessage(summary: string) {
    return [
      '以下是当前会话较早历史的压缩摘要，只用于延续上下文，不要向用户暴露摘要本身。',
      '如果摘要与最近消息冲突，优先相信最近消息。',
      '',
      summary,
    ].join('\n');
  }
}
