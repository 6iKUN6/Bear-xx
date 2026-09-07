import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConversationService } from '../conversation/conversation.service';
import { StreamTaskService } from '../stream-task/stream-task.service';
import { MessageRole, MessageStatus } from '@prisma/client';
import type { TaskStreamResult } from '../stream-task/stream-task.service';
import type { ReasoningSelection } from '@litter-bear/types';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly conversationService: ConversationService,
    private readonly streamTaskService: StreamTaskService,
  ) {}

  /**
   * 创建文本聊天任务
   * @param conversationId 会话ID
   * @param content 用户消息内容
   * @param userId 用户ID
   * @param selectedModelPresetId 本条消息选择的 Agent 允许模型预设业务标识
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 负责接收文本聊天请求，并将受 Agent 允许集合约束的单条消息模型选择委托给流式任务模块处理。
   */
  async createCompletionTask(
    conversationId: string | undefined,
    content: string,
    userId: string,
    selectedModelPresetId?: string,
    reasoning?: ReasoningSelection,
    agentId?: string,
    imageAssetId?: string,
  ) {
    return this.streamTaskService.createChatTask(
      conversationId,
      content,
      userId,
      selectedModelPresetId,
      reasoning,
      agentId,
      false,
      imageAssetId,
    );
  }

  /**
   * 发送文本消息并直接返回流式结果
   * @param conversationId 会话ID
   * @param content 用户消息内容
   * @param userId 用户ID
   * @param selectedModelPresetId 本条消息选择的 Agent 允许模型预设业务标识
   * @param signal 连接中断信号
   * @returns 返回包含异步流式事件的对象
   * @description 统一处理文本消息发送、首轮自动建会话、任务创建和首轮流式建链，供聊天主入口直接使用。
   */
  async streamMessage(
    conversationId: string | undefined,
    content: string,
    userId: string,
    selectedModelPresetId?: string,
    reasoning?: ReasoningSelection,
    signal?: AbortSignal,
    agentId?: string,
    imageAssetId?: string,
  ): Promise<TaskStreamResult> {
    return this.streamTaskService.streamChatTask(
      conversationId,
      content,
      userId,
      selectedModelPresetId,
      reasoning,
      signal,
      agentId,
      false,
      imageAssetId,
    );
  }

  /**
   * 创建语音聊天任务
   * @param conversationId 会话ID
   * @param audioBuffer 音频二进制数据
   * @param filename 音频文件名
   * @param userId 用户ID
   * @param selectedModelPresetId 本条消息选择的 Agent 允许模型预设业务标识
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 负责接收语音聊天请求，先转写音频内容，再携带受限的单条消息模型选择创建可恢复任务。
   */
  async createVoiceTask(
    conversationId: string | undefined,
    audioBuffer: Buffer,
    filename: string,
    userId: string,
    selectedModelPresetId?: string,
    reasoning?: ReasoningSelection,
    agentId?: string,
  ) {
    return this.streamTaskService.createVoiceTask(
      conversationId,
      audioBuffer,
      filename,
      userId,
      selectedModelPresetId,
      reasoning,
      agentId,
    );
  }

  /**
   * 处理图片生成请求
   * @param conversationId 会话ID
   * @param prompt 图片提示词
   * @param userId 用户ID
   * @returns 返回图片消息信息，包含 messageId、imageUrl 和修订后的提示词
   * @description 校验会话归属后，先写入用户提示词消息，再调用图片生成服务并持久化 AI 图片消息。
   */
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
