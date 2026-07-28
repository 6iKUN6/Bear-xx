import { ApiProperty } from '@nestjs/swagger';

export class ConversationMessageTraceItemDto {
  @ApiProperty({ description: '轨迹项 ID', example: 'cmf_trace_123' })
  id: string;

  @ApiProperty({
    description: '轨迹项类型',
    example: 'TOOL_CALL',
  })
  type: string;

  @ApiProperty({
    description: '轨迹项状态',
    example: 'SUCCESS',
  })
  status: string;

  @ApiProperty({ description: '展示标题', example: '调用工具：getWeather' })
  title: string;

  @ApiProperty({
    description: '展示摘要',
    example: '工具调用成功',
    required: false,
    nullable: true,
  })
  summary?: string | null;

  @ApiProperty({
    description: '耗时毫秒',
    example: 1250,
    required: false,
    nullable: true,
  })
  durationMs?: number | null;

  @ApiProperty({
    description: '轨迹层级',
    example: 0,
  })
  depth: number;

  @ApiProperty({
    description: '排序序号',
    example: 1,
  })
  sequence: number;

  @ApiProperty({
    description: '工具名（仅工具调用类节点有值），供前端展示工具图标',
    example: 'getWeather',
    required: false,
    nullable: true,
  })
  toolName?: string | null;

  @ApiProperty({
    description: '父轨迹项 ID，用于层级树展示',
    example: 'cmf_trace_100',
    required: false,
    nullable: true,
  })
  parentId?: string | null;

  @ApiProperty({
    description: '入参摘要，供前端展示「调用了什么」的参数卡片',
    required: false,
    nullable: true,
    type: Object,
    additionalProperties: true,
    example: { city: '深圳' },
  })
  inputSummary?: Record<string, unknown> | null;

  @ApiProperty({
    description: '出参摘要，供前端展开查看节点结果详情',
    required: false,
    nullable: true,
    type: Object,
    additionalProperties: true,
    example: { temperature: 30, condition: '晴' },
  })
  outputSummary?: Record<string, unknown> | null;

  @ApiProperty({
    description: '轨迹指标信息，例如 token 消耗、缓存命中、耗时等',
    required: false,
    nullable: true,
    type: Object,
    additionalProperties: true,
    example: {
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
        cachedInputTokens: 800,
        estimated: true,
      },
      cache: {
        memorySummaryHit: true,
        contextCacheHit: true,
      },
    },
  })
  metrics?: Record<string, unknown> | null;
}

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

  @ApiProperty({
    description: '助手消息对应的单轮执行轨迹',
    type: ConversationMessageTraceItemDto,
    isArray: true,
    required: false,
  })
  trace?: ConversationMessageTraceItemDto[];
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
