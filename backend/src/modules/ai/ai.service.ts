import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';

@Injectable()
export class AiService {
  private openai: OpenAI;
  private whisperModel: string;
  private imageModel: string;

  constructor(private readonly configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });
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
    const file = await toFile(audioBuffer, filename);
    const transcription = await this.openai.audio.transcriptions.create({
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
    const response = await this.openai.images.generate({
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
}
