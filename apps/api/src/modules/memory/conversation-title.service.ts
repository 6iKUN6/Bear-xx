import { Injectable, Logger } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { conversationTitlePrompt } from '../../prompts';
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_TITLE_MAX_OUTPUT_TOKENS,
  CONVERSATION_TITLE_SOURCE_CONTENT_LIMIT,
  CONVERSATION_TITLE_TEMPERATURE,
} from './memory.constants';

@Injectable()
export class ConversationTitleService {
  private readonly logger = new Logger(ConversationTitleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
  ) {}

  /**
   * 为新会话首轮生成 AI 标题
   * @param conversationId 会话ID
   * @returns 返回生成并已落库的标题；非首轮或生成失败时返回 null
   * @description 仅在会话首轮（恰好一条用户消息）触发：只基于首条用户消息生成，
   * 与主回答并行执行，标题通常在回答流式输出期间就绪。生成失败时静默保留创建时的
   * 截断兜底标题，绝不影响主链路。
   */
  async generateTitleIfFirstTurn(
    conversationId: string,
  ): Promise<string | null> {
    try {
      const userMessageCount = await this.prisma.message.count({
        where: { conversationId, role: MessageRole.USER },
      });
      if (userMessageCount !== 1) {
        return null;
      }

      const userMessage = await this.prisma.message.findFirst({
        where: { conversationId, role: MessageRole.USER },
        select: { content: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!userMessage?.content.trim()) {
        return null;
      }

      const title = this.sanitizeTitle(
        await this.llmService.generateChatText(
          [
            { role: 'system', content: conversationTitlePrompt },
            {
              role: 'user',
              content: this.formatTitleSource(userMessage.content),
            },
          ],
          {
            generation: {
              temperature: CONVERSATION_TITLE_TEMPERATURE,
              maxOutputTokens: CONVERSATION_TITLE_MAX_OUTPUT_TOKENS,
            },
          },
        ),
      );
      if (!title) {
        return null;
      }

      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { title },
      });
      return title;
    } catch (error) {
      this.logger.warn(
        `Generate conversation title failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * 组装标题生成的输入文本
   * @description 只用首条用户消息（不等助手回复，保证标题能在首轮前期就绪），截断避免超长消息触发过大的后台请求。
   */
  private formatTitleSource(userContent: string) {
    return `请为以下用户消息开启的对话生成标题：\n\n用户：${userContent.slice(
      0,
      CONVERSATION_TITLE_SOURCE_CONTENT_LIMIT,
    )}`;
  }

  /**
   * 清洗模型输出的标题
   * @description 去掉引号/书名号等包裹符与换行，超长时按最大展示长度截断；清洗后为空返回空串。
   */
  private sanitizeTitle(raw: string): string {
    const title = raw
      .replace(/\s+/g, ' ')
      .replace(/^["'“”‘’《〈【[(（\s]+|["'“”‘’》〉】\])）。！？!?.\s]+$/g, '')
      .trim();
    return title.slice(0, CONVERSATION_TITLE_MAX_LENGTH);
  }
}
