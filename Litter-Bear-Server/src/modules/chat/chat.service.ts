import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { ConversationService } from '../conversation/conversation.service';
import { MessageRole, MessageStatus } from '@prisma/client';
import type { SseEvent } from '../../common/sse';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly conversationService: ConversationService,
  ) {}

  async streamCompletion(
    conversationId: string,
    content: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<{ bufferKey: string; stream: AsyncGenerator<SseEvent> }> {
    // 1. Verify ownership
    await this.conversationService.ensureOwnership(conversationId, userId);

    // 2. Persist user message
    await this.prisma.message.create({
      data: {
        role: MessageRole.USER,
        content,
        status: MessageStatus.DONE,
        conversationId,
      },
    });

    // 3. Auto-update conversation title from first user message
    const msgCount = await this.prisma.message.count({
      where: { conversationId, role: MessageRole.USER },
    });
    if (msgCount === 1) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { title: content.slice(0, 20) },
      });
    }

    // 4. Load conversation history for AI context
    const history = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });

    const messages = history.map((m) => ({
      role:
        m.role === MessageRole.USER
          ? ('user' as const)
          : ('assistant' as const),
      content: m.content,
    }));

    // 5. Create assistant message placeholder
    const aiMessage = await this.prisma.message.create({
      data: {
        role: MessageRole.ASSISTANT,
        content: '',
        status: MessageStatus.DONE,
        conversationId,
      },
    });

    // Use aiMessage.id as buffer key for reconnection
    const bufferKey = aiMessage.id;

    const stream = this.generateStream(
      aiMessage.id,
      conversationId,
      messages,
      signal,
    );

    return { bufferKey, stream };
  }

  async voiceCompletion(
    conversationId: string,
    audioBuffer: Buffer,
    filename: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<{ bufferKey: string; stream: AsyncGenerator<SseEvent> }> {
    const transcribedText = await this.aiService.transcribeAudio(
      audioBuffer,
      filename,
    );
    return this.streamCompletion(
      conversationId,
      transcribedText,
      userId,
      signal,
    );
  }

  async generateImage(conversationId: string, prompt: string, userId: string) {
    await this.conversationService.ensureOwnership(conversationId, userId);

    // Persist user message
    await this.prisma.message.create({
      data: {
        role: MessageRole.USER,
        content: prompt,
        status: MessageStatus.DONE,
        conversationId,
      },
    });

    // Generate image
    const result = await this.aiService.generateImage(prompt);

    // Persist AI message with imageUrl
    const aiMessage = await this.prisma.message.create({
      data: {
        role: MessageRole.ASSISTANT,
        content: result.revisedPrompt,
        imageUrl: result.url,
        status: MessageStatus.DONE,
        conversationId,
      },
    });

    // Touch conversation updatedAt
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return {
      messageId: aiMessage.id,
      imageUrl: result.url,
      revisedPrompt: result.revisedPrompt,
    };
  }

  private async *generateStream(
    aiMessageId: string,
    conversationId: string,
    messages: { role: 'user' | 'assistant'; content: string }[],
    signal?: AbortSignal,
  ): AsyncGenerator<SseEvent> {
    let fullContent = '';

    try {
      for await (const chunk of this.aiService.streamChat(messages)) {
        if (signal?.aborted) break;

        fullContent += chunk;
        yield {
          id: '0', // Will be reassigned by SseInterceptor
          event: 'message',
          data: JSON.stringify({
            choices: [{ delta: { content: chunk } }],
          }),
        };
      }

      // Persist final content
      await this.prisma.message.update({
        where: { id: aiMessageId },
        data: { content: fullContent, status: MessageStatus.DONE },
      });

      // Touch conversation updatedAt
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });

      yield {
        id: '0',
        event: 'done',
        data: '[DONE]',
      };
    } catch (error) {
      this.logger.error(`Stream error: ${(error as Error).message}`);

      // Persist partial content with error status
      await this.prisma.message.update({
        where: { id: aiMessageId },
        data: {
          content: fullContent || '生成失败',
          status: MessageStatus.ERROR,
        },
      });

      yield {
        id: '0',
        event: 'error',
        data: JSON.stringify({ message: '生成出错，请重试' }),
      };
    }
  }
}
