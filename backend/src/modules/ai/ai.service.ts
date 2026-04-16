import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';

@Injectable()
export class AiService {
  private whisperModel: string;
  private imageModel: string;

  constructor(private readonly configService: ConfigService) {
    this.whisperModel =
      this.configService.get<string>('AI_WHISPER_MODEL') || 'whisper-1';
    this.imageModel =
      this.configService.get<string>('AI_IMAGE_MODEL') || 'dall-e-3';
  }

  /**
   * 转写音频内容
   * @param audioBuffer 音频二进制数据
   * @param filename 音频文件名
   * @returns 返回识别得到的文本内容
   * @description 调用 OpenAI Whisper 模型对上传音频进行转写，供语音聊天任务复用。
   */
  async transcribeAudio(
    audioBuffer: Buffer,
    filename: string,
  ): Promise<string> {
    const openai = this.getOpenAiClient();
    const file = await toFile(audioBuffer, filename);
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: this.whisperModel,
    });
    return transcription.text;
  }

  /**
   * 生成图片
   * @param prompt 图片提示词
   * @returns 返回图片地址和模型修订后的提示词
   * @description 调用图片生成模型生成单张图片，并返回可用于消息持久化的结果数据。
   */
  async generateImage(
    prompt: string,
  ): Promise<{ url: string; revisedPrompt: string }> {
    const openai = this.getOpenAiClient();
    const response = await openai.images.generate({
      model: this.imageModel,
      prompt,
      n: 1,
      size: '1024x1024',
    });
    const image = response.data![0];
    return {
      url: image.url!,
      revisedPrompt: image.revised_prompt || prompt,
    };
  }

  /**
   * 获取 OpenAI 客户端
   * @returns 返回可调用语音转写和图片生成能力的 OpenAI 客户端实例
   * @description 按需读取 OPENAI_API_KEY 创建客户端；当未配置密钥时抛出明确异常，避免在应用启动阶段阻塞非 OpenAI 文本对话能力。
   */
  private getOpenAiClient(): OpenAI {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      throw new BadRequestException(
        '未配置 OPENAI_API_KEY，无法使用语音转写或图片生成功能',
      );
    }

    return new OpenAI({ apiKey });
  }
}
