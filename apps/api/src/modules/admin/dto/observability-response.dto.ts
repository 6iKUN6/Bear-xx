import { ApiProperty } from '@nestjs/swagger';

export class StatusCountDto {
  @ApiProperty({ example: 'COMPLETED' })
  status: string;

  @ApiProperty({ example: 42 })
  count: number;
}

export class ObservabilityOverviewDto {
  @ApiProperty({ description: '统计窗口天数', example: 7 })
  rangeDays: number;

  @ApiProperty({ description: '任务总数', example: 128 })
  totalTasks: number;

  @ApiProperty({ description: '成功任务数', example: 110 })
  completedTasks: number;

  @ApiProperty({ description: '失败任务数', example: 12 })
  erroredTasks: number;

  @ApiProperty({ description: '成功率（0-1）', example: 0.86 })
  successRate: number;

  @ApiProperty({
    description: '平均任务时长（毫秒，仅完成任务）',
    example: 3200,
    nullable: true,
    type: Number,
  })
  avgDurationMs: number | null;

  @ApiProperty({
    description: '按状态分布',
    type: StatusCountDto,
    isArray: true,
  })
  statusBreakdown: StatusCountDto[];
}

export class AgentUsageDto {
  @ApiProperty({
    description: '智能体 id；null=用默认 agent',
    nullable: true,
    type: String,
  })
  agentId: string | null;

  @ApiProperty({ description: '智能体展示名称' })
  agentName: string;

  @ApiProperty({ description: '智能体头像 URL', nullable: true, type: String })
  agentAvatar: string | null;

  @ApiProperty({ example: 30 })
  taskCount: number;

  @ApiProperty({ example: 27 })
  completedCount: number;

  @ApiProperty({ example: 0.9 })
  successRate: number;

  @ApiProperty({ example: 3100, nullable: true, type: Number })
  avgDurationMs: number | null;
}

export class ToolUsageDto {
  @ApiProperty({ example: 'webSearch', nullable: true, type: String })
  toolName: string | null;

  @ApiProperty({ description: '调用次数（已结束）', example: 54 })
  callCount: number;

  @ApiProperty({ description: '成功次数', example: 50 })
  successCount: number;

  @ApiProperty({ example: 0.93 })
  successRate: number;

  @ApiProperty({ example: 820, nullable: true, type: Number })
  avgDurationMs: number | null;
}

export class ErrorCategoryCountDto {
  @ApiProperty({
    description: '错误类别（TaskErrorCategory）',
    example: 'rate_limit',
  })
  category: string;

  @ApiProperty({ example: 5 })
  count: number;
}

export class TaskSummaryDto {
  @ApiProperty({ example: 'cmf_task_123' })
  id: string;

  @ApiProperty({ nullable: true, type: String })
  agentId: string | null;

  @ApiProperty({ description: '智能体展示名称' })
  agentName: string;

  @ApiProperty({ description: '智能体头像 URL', nullable: true, type: String })
  agentAvatar: string | null;

  @ApiProperty({ example: 'CHAT_COMPLETION' })
  type: string;

  @ApiProperty({ example: 'COMPLETED' })
  status: string;

  @ApiProperty({ example: 3200, nullable: true, type: Number })
  durationMs: number | null;

  @ApiProperty({
    example: 1500,
    nullable: true,
    description: '总 token（估算）',
    type: Number,
  })
  totalTokens: number | null;

  @ApiProperty({ example: 2, nullable: true, type: Number })
  toolCallCount: number | null;

  @ApiProperty({ example: 3, nullable: true, type: Number })
  modelCallCount: number | null;

  @ApiProperty({ nullable: true, type: String })
  errorMessage: string | null;

  @ApiProperty({ example: 1735689600000 })
  createdAt: number;
}

export class RecentTasksDto {
  @ApiProperty({ type: TaskSummaryDto, isArray: true })
  items: TaskSummaryDto[];

  @ApiProperty({
    description: '下一页游标（最后一条任务 id）；无更多时为 null',
    nullable: true,
    type: String,
  })
  nextCursor: string | null;
}

export class TaskTraceItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'TOOL_CALL' })
  type: string;

  @ApiProperty({ example: 'SUCCESS' })
  status: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ nullable: true, type: String })
  summary: string | null;

  @ApiProperty({ nullable: true, type: String })
  detail: string | null;

  @ApiProperty({ nullable: true, type: String })
  toolName: string | null;

  @ApiProperty({ example: 820, nullable: true, type: Number })
  durationMs: number | null;

  @ApiProperty({ example: 1 })
  sequence: number;

  @ApiProperty({ example: 0 })
  depth: number;

  @ApiProperty({ nullable: true, type: String })
  parentId: string | null;

  @ApiProperty({ nullable: true, type: String })
  nodeKey: string | null;

  @ApiProperty({ nullable: true, type: String })
  mcpServer: string | null;

  @ApiProperty({ nullable: true, type: String })
  mcpTool: string | null;

  @ApiProperty({
    nullable: true,
    type: Object,
    additionalProperties: true,
  })
  inputSummary: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    type: Object,
    additionalProperties: true,
  })
  outputSummary: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    type: Object,
    additionalProperties: true,
  })
  error: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    type: Object,
    additionalProperties: true,
  })
  metrics: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, example: 1735689600000, type: Number })
  startedAt: number | null;

  @ApiProperty({ nullable: true, example: 1735689601200, type: Number })
  endedAt: number | null;

  @ApiProperty({ example: 1735689600000 })
  createdAt: number;
}

export class TaskDetailDto extends TaskSummaryDto {
  @ApiProperty({
    description: '本轮执行轨迹',
    type: TaskTraceItemDto,
    isArray: true,
  })
  trace: TaskTraceItemDto[];
}
