import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { SseRequest } from '../../common/sse';
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
import { Sse, SseInterceptor } from '../../common/sse';

@ApiTags('聊天')
@ApiBearerAuth()
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('completions')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Sse()
  @UseInterceptors(SseInterceptor)
  @ApiOperation({
    summary: 'AI 流式聊天',
    description: 'SSE 流式返回 AI 回复，支持断线重连',
  })
  async completions(
    @Body() dto: ChatCompletionsDto,
    @CurrentUser('id') userId: string,
    @Req() req: SseRequest,
  ) {
    const signal = req.__sseAbortSignal;

    return this.chatService.streamCompletion(
      dto.conversationId,
      dto.content,
      userId,
      signal,
    );
  }

  @Post('voice-completions')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Sse()
  @UseInterceptors(SseInterceptor, FileInterceptor('audio'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: '语音流式聊天',
    description: '上传音频文件，Whisper 转文字后 SSE 流式返回 AI 回复',
  })
  async voiceCompletions(
    @Body() dto: VoiceCompletionsDto,
    @UploadedFile() audio: Express.Multer.File,
    @CurrentUser('id') userId: string,
    @Req() req: Request,
  ) {
    if (!audio) {
      throw new BadRequestException('音频文件不能为空');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const signal = (req as any).__sseAbortSignal as AbortSignal | undefined;

    return this.chatService.voiceCompletion(
      dto.conversationId,
      audio.buffer,
      audio.originalname,
      userId,
      signal,
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
}
