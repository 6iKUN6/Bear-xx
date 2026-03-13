import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createChatAgent } from './agents/chat-agent';
import { type Agent } from '@mastra/core/agent';
import OpenAI, { toFile } from 'openai';

@Injectable()
export class AiService {
  private chatAgent: Agent;
  private openai: OpenAI;
  private whisperModel: string;
  private imageModel: string;

  constructor(private readonly configService: ConfigService) {
    const model = this.configService.get<string>('AI_MODEL') || 'gpt-4o-mini';
    this.chatAgent = createChatAgent(model);
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });
    this.whisperModel =
      this.configService.get<string>('AI_WHISPER_MODEL') || 'whisper-1';
    this.imageModel =
      this.configService.get<string>('AI_IMAGE_MODEL') || 'dall-e-3';
  }

  async *streamChat(
    messages: { role: 'user' | 'assistant'; content: string }[],
  ): AsyncGenerator<string> {
    const response = await this.chatAgent.stream(messages as never);
    for await (const chunk of response.textStream) {
      yield chunk;
    }
  }

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
