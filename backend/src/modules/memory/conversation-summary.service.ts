import { Injectable } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { CHAT_CONTEXT_RECENT_MESSAGE_LIMIT } from './memory.constants';

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

    if (summarySourceMessages.length === 0) {
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
      summarySourceMessages.slice(existingSummary?.messageCount ?? 0),
      summarySourceMessages,
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
        content:
          '你是会话摘要助手。请用简洁中文总结对话历史，只保留后续对话真正需要的内容，包括用户目标、关键事实、约束条件、偏好、已完成结论、待跟进事项。不要输出寒暄，不要编造信息，控制在 200 字以内。',
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
        content:
          '你是会话摘要助手。请根据已有摘要和新增消息更新摘要，只保留对后续对话有价值的信息，包括目标、事实、偏好、约束、结论和待办事项。不要编造信息，控制在 200 字以内。',
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
   * @description 通过统一的 LLM 服务流式收集文本，供摘要生成等非实时输出场景复用。
   */
  private async generateText(
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>,
  ): Promise<string> {
    let fullContent = '';

    for await (const chunk of this.llmService.streamChatText(messages, {
      generation: {
        temperature: 0.2,
        maxOutputTokens: 300,
      },
    })) {
      fullContent += chunk;
    }

    return fullContent.trim();
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
