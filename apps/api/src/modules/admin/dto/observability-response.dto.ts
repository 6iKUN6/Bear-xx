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
  @ApiProperty({ description: '智能体 id；null=用默认 agent', nullable: true })
  agentId: string | null;

  @ApiProperty({ example: 30 })
  taskCount: number;

  @ApiProperty({ example: 27 })
  completedCount: number;

  @ApiProperty({ example: 0.9 })
  successRate: number;

  @ApiProperty({ example: 3100, nullable: true })
  avgDurationMs: number | null;
}

export class ToolUsageDto {
  @ApiProperty({ example: 'webSearch', nullable: true })
  toolName: string | null;

  @ApiProperty({ description: '调用次数（已结束）', example: 54 })
  callCount: number;

  @ApiProperty({ description: '成功次数', example: 50 })
  successCount: number;

  @ApiProperty({ example: 0.93 })
  successRate: number;

  @ApiProperty({ example: 820, nullable: true })
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

  @ApiProperty({ nullable: true })
  agentId: string | null;

  @ApiProperty({ example: 'CHAT_COMPLETION' })
  type: string;

  @ApiProperty({ example: 'COMPLETED' })
  status: string;

  @ApiProperty({ example: 3200, nullable: true })
  durationMs: number | null;

  @ApiProperty({
    example: 1500,
    nullable: true,
    description: '总 token（估算）',
  })
  totalTokens: number | null;

  @ApiProperty({ example: 2, nullable: true })
  toolCallCount: number | null;

  @ApiProperty({ example: 3, nullable: true })
  modelCallCount: number | null;

  @ApiProperty({ nullable: true })
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

  @ApiProperty({ nullable: true })
  summary: string | null;

  @ApiProperty({ nullable: true })
  toolName: string | null;

  @ApiProperty({ example: 820, nullable: true })
  durationMs: number | null;

  @ApiProperty({ example: 1 })
  sequence: number;
}

export class TaskDetailDto extends TaskSummaryDto {
  @ApiProperty({
    description: '本轮执行轨迹',
    type: TaskTraceItemDto,
    isArray: true,
  })
  trace: TaskTraceItemDto[];
}
