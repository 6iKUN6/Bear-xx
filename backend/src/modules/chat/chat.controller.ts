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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { ChatCompletionsDto } from './dto/chat-completions.dto';
import { VoiceCompletionsDto } from './dto/voice-completions.dto';
import { ImageGenerationDto } from './dto/image-generation.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { LlmTextRequest } from '../llm/llm.types';

@ApiTags('聊天')
@ApiBearerAuth()
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('completions')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '创建 AI 聊天任务',
    description:
      '创建可恢复的 SSE 聊天任务，随后使用 /sse-tasks/:taskId/stream 或 /resume 建链',
  })
  async completions(
    @Body() dto: ChatCompletionsDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatService.createCompletionTask(
      dto.conversationId,
      dto.content,
      userId,
      this.buildLlmTextRequest(dto),
    );
  }

  @Post('voice-completions')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('audio'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: '创建语音聊天任务',
    description: '上传音频文件，Whisper 转文字后创建可恢复的 SSE 任务',
  })
  voiceCompletions(
    @Body() dto: VoiceCompletionsDto,
    @UploadedFile() audio: Express.Multer.File,
    @CurrentUser('id') userId: string,
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
