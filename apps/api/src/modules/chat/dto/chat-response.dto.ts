import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatTaskResultDto {
  @ApiProperty({ description: '流式任务 ID', example: 'cmf_task_123' })
  taskId: string;

  @ApiProperty({
    description: '当前执行流片段 ID',
    example: 'cmf_stream_123',
  })
  streamId: string;

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
      'waiting_human',
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
    description:
      '本条消息选择的模型预设业务 ID；必须属于回答智能体允许集合，仅替换 Flow 中的 agent-default',
    example: 'deepseek-official:deepseek-chat',
  })
  selectedModelPresetId?: string;

  @ApiPropertyOptional({
    description: '指定使用的智能体 id；不传则使用会话或系统默认智能体',
    example: 'agent_abc123',
  })
  agentId?: string;

  @ApiPropertyOptional({
    type: 'string',
    description: 'JSON 字符串形式的本轮思考设置，仅 direct Agent 可用',
    example: '{"activation":"enabled","effort":"high"}',
  })
  reasoning?: string;
}
