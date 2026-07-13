import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StreamTaskEventType } from '../stream-task-event.types';

export class StreamTaskStatusDto {
  @ApiProperty({ description: '流式任务 ID', example: 'cmf_task_123' })
  taskId: string;

  @ApiPropertyOptional({
    description: '当前执行流片段 ID',
    example: 'cmf_stream_123',
    nullable: true,
  })
  streamId?: string | null;

  @ApiProperty({
    description: '任务类型',
    enum: ['chat_completion', 'voice_completion', 'agent_workflow'],
    example: 'chat_completion',
  })
  type: string;

  @ApiProperty({
    description: '任务状态',
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
    example: 'streaming',
  })
  status: string;

  @ApiProperty({ description: '会话 ID', example: 'cmf_conv_123' })
  conversationId: string;

  @ApiProperty({ description: 'assistant 消息 ID', example: 'cmf_msg_123' })
  messageId: string;

  @ApiProperty({
    description:
      '服务端已持久化的最后语义事件 ID；流式恢复请使用 SSE id / lastEventId 字符串游标',
    example: 12,
  })
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

  @ApiPropertyOptional({
    description: '任务过期时间戳（毫秒）',
    example: 1735689600000,
    nullable: true,
  })
  expiresAt: number | null;

  @ApiProperty({
    description: '任务更新时间戳（毫秒）',
    example: 1735689600000,
  })
  updatedAt: number;
}

export class CancelStreamTaskResultDto {
  @ApiProperty({ description: '流式任务 ID', example: 'cmf_task_123' })
  taskId: string;

  @ApiProperty({
    description: '取消后的任务状态',
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
    example: 'canceled',
  })
  status: string;
}

export class StreamTaskEventPayloadDto {
  @ApiProperty({
    description: '事件类型',
    enum: StreamTaskEventType,
    enumName: 'StreamTaskEventType',
    example: StreamTaskEventType.MessageDelta,
  })
  type: StreamTaskEventType;

  @ApiProperty({ description: '流式任务 ID', example: 'cmf_task_123' })
  taskId: string;

  @ApiPropertyOptional({
    description: '事件所属执行流片段 ID',
    example: 'cmf_stream_123',
  })
  streamId?: string;

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
