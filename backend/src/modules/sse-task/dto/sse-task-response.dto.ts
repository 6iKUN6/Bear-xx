import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SseTaskStatusDto {
  @ApiProperty({ description: 'SSE 任务 ID', example: 'cmf_task_123' })
  taskId: string;

  @ApiProperty({
    description: '任务类型',
    enum: ['chat_completion', 'voice_completion'],
    example: 'chat_completion',
  })
  type: string;

  @ApiProperty({
    description: '任务状态',
    enum: [
      'pending',
      'streaming',
      'paused',
      'completed',
      'error',
      'expired',
      'canceled',
    ],
    example: 'streaming',
  })
  status: string;

  @ApiProperty({ description: '会话 ID', example: 'cmf_conv_123' })
  conversationId: string;

  @ApiProperty({ description: 'assistant 消息 ID', example: 'cmf_msg_123' })
  messageId: string;

  @ApiProperty({ description: '服务端已持久化的最后事件 ID', example: 12 })
  lastEventId: number;

  @ApiProperty({
    description: '当前累计生成内容',
    example: '你好，我是 Litter Bear',
  })
  fullContent: string;

  @ApiPropertyOptional({
    description: '任务错误信息',
    example: '模型服务请求失败',
    nullable: true,
  })
  errorMessage?: string | null;

  @ApiProperty({ description: '当前任务是否可恢复', example: true })
  canResume: boolean;

  @ApiProperty({
    description: '任务过期时间戳（毫秒）',
    example: 1735689600000,
  })
  expiresAt: number;

  @ApiProperty({
    description: '任务更新时间戳（毫秒）',
    example: 1735689600000,
  })
  updatedAt: number;
}

export class CancelSseTaskResultDto {
  @ApiProperty({ description: 'SSE 任务 ID', example: 'cmf_task_123' })
  taskId: string;

  @ApiProperty({
    description: '取消后的任务状态',
    enum: [
      'pending',
      'streaming',
      'paused',
      'completed',
      'error',
      'expired',
      'canceled',
    ],
    example: 'canceled',
  })
  status: string;
}

export class SseTaskEventPayloadDto {
  @ApiProperty({ description: '事件类型', example: 'message.delta' })
  type: string;

  @ApiProperty({ description: 'SSE 任务 ID', example: 'cmf_task_123' })
  taskId: string;

  @ApiProperty({ description: '会话 ID', example: 'cmf_conv_123' })
  conversationId: string;

  @ApiProperty({ description: 'assistant 消息 ID', example: 'cmf_msg_123' })
  messageId: string;

  @ApiProperty({ description: '任务状态', example: 'streaming' })
  status: string;

  @ApiPropertyOptional({
    description: '事件业务载荷，结构随事件类型变化',
    example: { delta: '你好' },
  })
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '错误事件中的错误信息',
    example: '聊天任务执行失败',
  })
  errorMessage?: string;
}
