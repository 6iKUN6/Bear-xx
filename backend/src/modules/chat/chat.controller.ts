import {
  Controller,
  Post,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiExcludeEndpoint,
  ApiProduces,
  ApiOkResponse,
} from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { ChatCompletionsDto } from './dto/chat-completions.dto';
import { VoiceCompletionsDto } from './dto/voice-completions.dto';
import { ImageGenerationDto } from './dto/image-generation.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { LlmTextRequest } from '../llm/llm.types';
import { Sse, SseInterceptor, type SseRequest } from '../../common/sse';

@ApiTags('聊天')
@ApiBearerAuth()
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('message')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Sse()
  @UseInterceptors(SseInterceptor)
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description: '聊天流式响应',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
        },
      },
    },
  })
  @ApiOperation({
    summary: '发送文本消息并开始流式回复',
    description:
      '发送一条文本消息并直接建立首轮 SSE 流；若未传 conversationId，则自动创建新会话',
    operationId: 'sendMessage',
  })
  async sendMessage(
    @Body() dto: ChatCompletionsDto,
    @CurrentUser('id') userId: string,
    @Req() req: SseRequest,
  ) {
    return this.chatService.streamMessage(
      dto.conversationId,
      dto.content,
      userId,
      this.buildLlmTextRequest(dto),
      req.__sseAbortSignal,
    );
  }

  @Post('completions')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async completions(
    @Body() dto: ChatCompletionsDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.createChatMessageTask(dto, userId);
  }

  @Post('messages')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async messages(
    @Body() dto: ChatCompletionsDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.createChatMessageTask(dto, userId);
  }

  @Post('voice-messages')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('audio'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: '发送语音消息',
    description:
      '上传音频文件，Whisper 转文字后创建可恢复的 SSE 任务；若未传 conversationId，则自动创建新会话',
    operationId: 'voiceCompletions',
  })
  voiceMessages(
    @Body() dto: VoiceCompletionsDto,
    @UploadedFile() audio: Express.Multer.File,
    @CurrentUser('id') userId: string,
  ) {
    return this.createVoiceMessageTask(dto, audio, userId);
  }

  @Post('voice-completions')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('audio'))
  @ApiConsumes('multipart/form-data')
  @ApiExcludeEndpoint()
  voiceCompletions(
    @Body() dto: VoiceCompletionsDto,
    @UploadedFile() audio: Express.Multer.File,
    @CurrentUser('id') userId: string,
  ) {
    return this.createVoiceMessageTask(dto, audio, userId);
  }

  /**
   * 创建文本消息任务
   * @param dto 文本消息请求 DTO
   * @param userId 用户ID
   * @returns 返回任务信息，包含 taskId、messageId、conversationId 和初始状态
   * @description 统一处理文本消息入口，兼容首轮自动建会话和后续按会话继续对话两种场景。
   */
  private createChatMessageTask(dto: ChatCompletionsDto, userId: string) {
    return this.chatService.createCompletionTask(
      dto.conversationId,
      dto.content,
      userId,
      this.buildLlmTextRequest(dto),
    );
  }

  /**
   * 创建语音消息任务
   * @param dto 语音消息请求 DTO
   * @param audio 上传的音频文件
   * @param userId 用户ID
   * @returns 返回任务信息，包含 taskId、messageId、conversationId 和初始状态
   * @description 统一处理语音消息入口，兼容首轮自动建会话和后续按会话继续对话两种场景。
   */
  private createVoiceMessageTask(
    dto: VoiceCompletionsDto,
    audio: Express.Multer.File,
    userId: string,
  ) {
    if (!audio) {
      throw new BadRequestException('音频文件不能为空');
    }

    return this.chatService.createVoiceTask(
      dto.conversationId,
      audio.buffer,
      audio.originalname,
      userId,
      this.buildLlmTextRequest(dto),
    );
  }

  @Post('image-generations')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'AI 图片生成',
    description: '使用 DALL-E 3 生成图片',
  })
  async imageGenerations(
    @Body() dto: ImageGenerationDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatService.generateImage(
      dto.conversationId,
      dto.prompt,
      userId,
    );
  }

  /**
   * 构建文本生成请求配置
   * @param dto 包含模型选择字段的请求 DTO
   * @returns 返回统一的文本生成请求配置；若未传任何模型相关字段则返回 undefined
   * @description 将接口层的 modelId、provider、platform、model 以及生成参数组装成 llm 模块可直接消费的结构。
   */
  private buildLlmTextRequest(dto: {
    modelId?: string;
    provider?: string;
    platform?: string;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
  }): LlmTextRequest | undefined {
    const model =
      dto.modelId || dto.provider || dto.platform || dto.model
        ? {
            modelId: dto.modelId,
            provider: dto.provider,
            platform: dto.platform,
            model: dto.model,
          }
        : undefined;
    const generation =
      dto.temperature !== undefined ||
      dto.maxOutputTokens !== undefined ||
      dto.topP !== undefined
        ? {
            temperature: dto.temperature,
            maxOutputTokens: dto.maxOutputTokens,
            topP: dto.topP,
          }
        : undefined;

    if (!model && !generation) {
      return undefined;
    }

    return { model, generation };
  }
}
