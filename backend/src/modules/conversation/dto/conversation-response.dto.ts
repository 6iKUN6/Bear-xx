import { ApiProperty } from '@nestjs/swagger';

export class ConversationMessageDto {
  @ApiProperty({ description: '消息 ID', example: 'cmf_msg_123' })
  id: string;

  @ApiProperty({
    description: '消息角色',
    enum: ['user', 'assistant'],
    example: 'user',
  })
  role: 'user' | 'assistant';

  @ApiProperty({ description: '消息文本内容', example: '你好' })
  content: string;

  @ApiProperty({
    description: '消息状态',
    enum: ['streaming', 'done', 'error'],
    example: 'done',
  })
  status: 'streaming' | 'done' | 'error';

  @ApiProperty({
    description: '消息创建时间戳（毫秒）',
    example: 1735689600000,
  })
  createdAt: number;
}

export class ConversationDto {
  @ApiProperty({ description: '会话 ID', example: 'cmf_conv_123' })
  id: string;

  @ApiProperty({ description: '会话标题', example: '新对话' })
  title: string;

  @ApiProperty({
    description: '会话消息列表',
    type: ConversationMessageDto,
    isArray: true,
  })
  messages: ConversationMessageDto[];

  @ApiProperty({
    description: '会话创建时间戳（毫秒）',
    example: 1735689600000,
  })
  createdAt: number;

  @ApiProperty({
    description: '会话更新时间戳（毫秒）',
    example: 1735689600000,
  })
  updatedAt: number;
}
