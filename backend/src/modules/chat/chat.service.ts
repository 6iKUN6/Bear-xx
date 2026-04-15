import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConversationService } from '../conversation/conversation.service';
import { SseTaskService } from '../sse-task/sse-task.service';
import { MessageRole, MessageStatus } from '@prisma/client';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly conversationService: ConversationService,
    private readonly sseTaskService: SseTaskService,
  ) {}

  async createCompletionTask(
    conversationId: string,
    content: string,
    userId: string,
  ) {
    return this.sseTaskService.createChatTask(conversationId, content, userId);
  }

  async createVoiceTask(
    conversationId: string,
    audioBuffer: Buffer,
    filename: string,
    userId: string,
  ) {
    return this.sseTaskService.createVoiceTask(
      conversationId,
      audioBuffer,
      filename,
      userId,
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
}
