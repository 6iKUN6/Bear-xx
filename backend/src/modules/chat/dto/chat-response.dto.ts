import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatTaskResultDto {
  @ApiProperty({ description: 'SSE 任务 ID', example: 'cmf_task_123' })
  taskId: string;

  @ApiProperty({
    description: '本次 assistant 占位消息 ID',
    example: 'cmf_msg_123',
  })
  messageId: string;

  @ApiProperty({ description: '会话 ID', example: 'cmf_conv_123' })
  conversationId: string;

  @ApiProperty({
    description: '任务初始状态',
    enum: [
      'pending',
      'streaming',
      'paused',
      'completed',
      'error',
      'expired',
      'canceled',
    ],
    example: 'pending',
  })
  status: string;
}

export class ImageGenerationResultDto {
  @ApiProperty({ description: '图片消息 ID', example: 'cmf_msg_123' })
  messageId: string;

  @ApiProperty({
    description: '生成图片地址',
    example: 'https://example.com/generated-image.png',
  })
  imageUrl: string;

  @ApiProperty({
    description: '模型修订后的提示词',
    example: '一只可爱的小熊在森林里散步',
  })
  revisedPrompt: string;
}

export class VoiceCompletionsFormDataDto {
  @ApiProperty({
    description: '音频文件',
    type: 'string',
    format: 'binary',
  })
  audio: string;

  @ApiPropertyOptional({
    description: '会话 ID；首轮语音消息可不传，后端会自动创建新会话',
    example: 'cmf_conv_123',
  })
  conversationId?: string;

  @ApiPropertyOptional({
    description: '模型预设 ID，优先级最高，例如 openai:gpt-4o-mini',
    example: 'openai:gpt-4o-mini',
  })
  modelId?: string;

  @ApiPropertyOptional({ description: 'LLM Provider 名称', example: 'openai' })
  provider?: string;

  @ApiPropertyOptional({ description: '模型平台或商家名称', example: 'openai' })
  platform?: string;

  @ApiPropertyOptional({ description: '模型名称', example: 'gpt-4o-mini' })
  model?: string;

  @ApiPropertyOptional({ description: '采样温度', example: 0.7 })
  temperature?: number;

  @ApiPropertyOptional({ description: '最大输出 Token 数', example: 2048 })
  maxOutputTokens?: number;

  @ApiPropertyOptional({ description: 'Top P 采样参数', example: 1 })
  topP?: number;
}
