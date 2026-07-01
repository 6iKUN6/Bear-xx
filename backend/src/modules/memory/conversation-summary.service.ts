import { Injectable } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import {
  conversationSummaryFullPrompt,
  conversationSummaryIncrementalPrompt,
} from '../../prompts';
import {
  CHAT_CONTEXT_RECENT_MESSAGE_LIMIT,
  CONVERSATION_SUMMARY_MAX_OUTPUT_TOKENS,
  CONVERSATION_SUMMARY_MAX_SOURCE_MESSAGE_COUNT,
  CONVERSATION_SUMMARY_MIN_SOURCE_MESSAGE_COUNT,
  CONVERSATION_SUMMARY_TEMPERATURE,
} from './memory.constants';

@Injectable()
export class ConversationSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
  ) {}

  /**
   * 获取会话摘要
   * @param conversationId 会话ID
   * @returns 返回会话摘要记录；若不存在则返回 null
   * @description 查询指定会话当前已保存的历史摘要，供聊天上下文组装和摘要增量刷新复用。
   */
  async getConversationSummary(conversationId: string) {
    return this.prisma.conversationSummary.findUnique({
      where: { conversationId },
    });
  }

  /**
   * 刷新会话摘要
   * @param conversationId 会话ID
   * @returns 返回最新摘要记录；若当前无需摘要则返回 null
   * @description 基于会话的较早历史消息生成或增量更新摘要，将最近窗口之外的上下文压缩存储，供后续对话复用。
   */
  async refreshConversationSummary(conversationId: string) {
    const history = await this.prisma.message.findMany({
      where: { conversationId },
      select: {
        id: true,
        role: true,
        content: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const summarySourceMessages = history.slice(
      0,
      Math.max(0, history.length - CHAT_CONTEXT_RECENT_MESSAGE_LIMIT),
    );

    if (
      summarySourceMessages.length <
      CONVERSATION_SUMMARY_MIN_SOURCE_MESSAGE_COUNT
    ) {
      await this.prisma.conversationSummary.deleteMany({
        where: { conversationId },
      });
      return null;
    }

    const latestMessageId =
      summarySourceMessages[summarySourceMessages.length - 1]?.id ?? null;
    const existingSummary = await this.getConversationSummary(conversationId);

    if (
      existingSummary &&
      existingSummary.latestMessageId === latestMessageId &&
      existingSummary.messageCount === summarySourceMessages.length
    ) {
      return existingSummary;
    }

    const summary = await this.generateSummaryContent(
      existingSummary?.summary,
      this.readIncrementalMessages(
        summarySourceMessages,
        existingSummary?.messageCount,
      ),
      this.limitSummarySourceMessages(summarySourceMessages),
    );

    return this.prisma.conversationSummary.upsert({
      where: { conversationId },
      create: {
        conversationId,
        summary,
        latestMessageId,
        messageCount: summarySourceMessages.length,
      },
      update: {
        summary,
        latestMessageId,
        messageCount: summarySourceMessages.length,
      },
    });
  }

  /**
   * 生成摘要内容
   * @param existingSummary 现有摘要内容
   * @param incrementalMessages 需要增量合并的新消息列表
   * @param fullMessages 用于全量重算的完整消息列表
   * @returns 返回摘要文本
   * @description 优先在已有摘要基础上增量合并新增历史消息；若不存在可复用摘要，则退回到全量摘要生成。
   */
  private async generateSummaryContent(
    existingSummary: string | undefined,
    incrementalMessages: Array<{
      role: MessageRole;
      content: string;
    }>,
    fullMessages: Array<{
      role: MessageRole;
      content: string;
    }>,
  ): Promise<string> {
    if (existingSummary && incrementalMessages.length > 0) {
      return this.generateIncrementalSummary(
        existingSummary,
        incrementalMessages,
      );
    }

    return this.generateFullSummary(fullMessages);
  }

  /**
   * 生成全量摘要
   * @param messages 用于摘要的完整历史消息列表
   * @returns 返回压缩后的摘要文本
   * @description 基于会话较早历史消息生成结构化中文摘要，保留事实、偏好、待办和上下文约束，供后续轮次直接注入模型上下文。
   */
  private async generateFullSummary(
    messages: Array<{
      role: MessageRole;
      content: string;
    }>,
  ): Promise<string> {
    return this.generateText([
      {
        role: 'system',
        content: conversationSummaryFullPrompt,
      },
      {
        role: 'user',
        content: `请总结以下历史消息：\n\n${this.formatMessages(messages)}`,
      },
    ]);
  }

  /**
   * 生成增量摘要
   * @param existingSummary 当前已保存的摘要内容
   * @param messages 需要合并进摘要的新消息列表
   * @returns 返回更新后的摘要文本
   * @description 在已有摘要基础上，仅根据新增历史消息更新摘要，减少长会话反复全量重算的模型开销。
   */
  private async generateIncrementalSummary(
    existingSummary: string,
    messages: Array<{
      role: MessageRole;
      content: string;
    }>,
  ): Promise<string> {
    return this.generateText([
      {
        role: 'system',
        content: conversationSummaryIncrementalPrompt,
      },
      {
        role: 'user',
        content: `已有摘要：\n${existingSummary}\n\n新增消息：\n${this.formatMessages(messages)}\n\n请返回更新后的完整摘要。`,
      },
    ]);
  }

  /**
   * 调用模型生成文本
   * @param messages 用于模型生成的消息列表
   * @returns 返回完整文本内容
   * @description 通过统一的 LLM 服务非流式生成完整文本，供摘要生成等非实时输出场景复用。
   */
  private async generateText(
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>,
  ): Promise<string> {
    return this.llmService.generateChatText(messages, {
      generation: {
        temperature: CONVERSATION_SUMMARY_TEMPERATURE,
        maxOutputTokens: CONVERSATION_SUMMARY_MAX_OUTPUT_TOKENS,
      },
    });
  }

  /**
   * 读取需要增量合并的消息
   * @param messages 当前摘要来源消息列表
   * @param summarizedMessageCount 已经被旧摘要覆盖的消息数量
   * @returns 返回尚未合并进摘要的新增历史消息
   * @description 只把旧摘要之后的新历史消息交给增量摘要提示词，避免重复压缩已经覆盖的内容。
   */
  private readIncrementalMessages(
    messages: Array<{
      role: MessageRole;
      content: string;
    }>,
    summarizedMessageCount: number | undefined,
  ) {
    return messages.slice(summarizedMessageCount ?? 0);
  }

  /**
   * 限制摘要来源消息数量
   * @param messages 当前摘要来源消息列表
   * @returns 返回用于全量摘要生成的消息窗口
   * @description 第一版保留较早历史中的最近一段摘要来源，避免极长会话触发过大的后台摘要请求。
   */
  private limitSummarySourceMessages(
    messages: Array<{
      role: MessageRole;
      content: string;
    }>,
  ) {
    return messages.slice(-CONVERSATION_SUMMARY_MAX_SOURCE_MESSAGE_COUNT);
  }

  /**
   * 格式化历史消息
   * @param messages 历史消息列表
   * @returns 返回供模型消费的纯文本消息串
   * @description 将用户和助手消息按时间顺序格式化为可读文本，降低摘要提示词的组装复杂度。
   */
  private formatMessages(
    messages: Array<{
      role: MessageRole;
      content: string;
    }>,
  ): string {
    return messages
      .map((message, index) => {
        const speaker = message.role === MessageRole.USER ? '用户' : '助手';
        return `${index + 1}. ${speaker}：${message.content}`;
      })
      .join('\n');
  }
}
