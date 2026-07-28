import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ConversationTraceItemType,
  ConversationTraceItemStatus,
  StreamTaskStatus,
  type Prisma,
} from '@prisma/client';
import { classifyLlmError } from '../llm/llm-error';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AgentUsageDto,
  ErrorCategoryCountDto,
  ObservabilityOverviewDto,
  RecentTasksDto,
  TaskDetailDto,
  TaskSummaryDto,
  ToolUsageDto,
} from './dto/observability-response.dto';

const DEFAULT_RANGE_DAYS = 7;
const DEFAULT_RECENT_LIMIT = 20;

/**
 * 管理端观测聚合（只读）
 * @description 复用已落库的 StreamTask / ConversationTurnTraceItem 数据做跨用户聚合，
 * 为 admin 面板供数。全部只读，无写操作；鉴权由 controller 的 RolesGuard 保证。
 */
@Injectable()
export class AdminObservabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 总览：任务量、状态分布、成功率、平均时长
   */
  async overview(days?: number): Promise<ObservabilityOverviewDto> {
    const rangeDays = this.resolveRangeDays(days);
    const since = this.sinceDate(rangeDays);

    const grouped = await this.prisma.streamTask.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });

    const statusBreakdown = grouped.map((row) => ({
      status: row.status,
      count: row._count._all,
    }));
    const totalTasks = statusBreakdown.reduce((sum, r) => sum + r.count, 0);
    const completedTasks = this.countFor(
      statusBreakdown,
      StreamTaskStatus.COMPLETED,
    );
    const erroredTasks = this.countFor(statusBreakdown, StreamTaskStatus.ERROR);

    const durationAgg = await this.prisma.streamTask.aggregate({
      where: {
        createdAt: { gte: since },
        status: StreamTaskStatus.COMPLETED,
        startedAt: { not: null },
        completedAt: { not: null },
      },
      _count: { _all: true },
    });

    return {
      rangeDays,
      totalTasks,
      completedTasks,
      erroredTasks,
      successRate: totalTasks > 0 ? completedTasks / totalTasks : 0,
      avgDurationMs: await this.avgCompletedDurationMs(
        since,
        durationAgg._count._all,
      ),
      statusBreakdown,
    };
  }

  /**
   * 按智能体聚合：任务数/成功率/平均时长
   */
  async agentUsage(days?: number): Promise<AgentUsageDto[]> {
    const since = this.sinceDate(this.resolveRangeDays(days));

    const grouped = await this.prisma.streamTask.groupBy({
      by: ['agentId', 'status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });

    // 折叠 (agentId,status) → 每 agent 汇总
    const byAgent = new Map<
      string,
      { agentId: string | null; taskCount: number; completedCount: number }
    >();
    for (const row of grouped) {
      const key = row.agentId ?? '__default__';
      const entry = byAgent.get(key) ?? {
        agentId: row.agentId,
        taskCount: 0,
        completedCount: 0,
      };
      entry.taskCount += row._count._all;
      if (row.status === StreamTaskStatus.COMPLETED) {
        entry.completedCount += row._count._all;
      }
      byAgent.set(key, entry);
    }

    const result: AgentUsageDto[] = [];
    for (const entry of byAgent.values()) {
      result.push({
        agentId: entry.agentId,
        taskCount: entry.taskCount,
        completedCount: entry.completedCount,
        successRate:
          entry.taskCount > 0 ? entry.completedCount / entry.taskCount : 0,
        avgDurationMs: await this.avgCompletedDurationMs(
          since,
          entry.completedCount,
          entry.agentId,
        ),
      });
    }
    return result.sort((a, b) => b.taskCount - a.taskCount);
  }

  /**
   * 按工具聚合：调用次数/成功率/平均时长
   */
  async toolUsage(days?: number): Promise<ToolUsageDto[]> {
    const since = this.sinceDate(this.resolveRangeDays(days));

    const grouped = await this.prisma.conversationTurnTraceItem.groupBy({
      by: ['toolName', 'status'],
      where: {
        type: ConversationTraceItemType.TOOL_CALL,
        status: { not: ConversationTraceItemStatus.RUNNING },
        createdAt: { gte: since },
      },
      _count: { _all: true },
      _avg: { durationMs: true },
    });

    const byTool = new Map<
      string,
      {
        toolName: string | null;
        callCount: number;
        successCount: number;
        durationSum: number;
        durationSamples: number;
      }
    >();
    for (const row of grouped) {
      const key = row.toolName ?? '__unknown__';
      const entry = byTool.get(key) ?? {
        toolName: row.toolName,
        callCount: 0,
        successCount: 0,
        durationSum: 0,
        durationSamples: 0,
      };
      entry.callCount += row._count._all;
      if (row.status === ConversationTraceItemStatus.SUCCESS) {
        entry.successCount += row._count._all;
      }
      if (row._avg.durationMs != null) {
        entry.durationSum += row._avg.durationMs * row._count._all;
        entry.durationSamples += row._count._all;
      }
      byTool.set(key, entry);
    }

    return [...byTool.values()]
      .map((entry) => ({
        toolName: entry.toolName,
        callCount: entry.callCount,
        successCount: entry.successCount,
        successRate:
          entry.callCount > 0 ? entry.successCount / entry.callCount : 0,
        avgDurationMs:
          entry.durationSamples > 0
            ? Math.round(entry.durationSum / entry.durationSamples)
            : null,
      }))
      .sort((a, b) => b.callCount - a.callCount);
  }

  /**
   * 失败任务按错误类别聚合
   * @description 复用 classifyLlmError 把 errorMessage 归类为 TaskErrorCategory，供面板看错误构成。
   */
  async errorBreakdown(days?: number): Promise<ErrorCategoryCountDto[]> {
    const since = this.sinceDate(this.resolveRangeDays(days));
    const tasks = await this.prisma.streamTask.findMany({
      where: {
        createdAt: { gte: since },
        status: StreamTaskStatus.ERROR,
      },
      select: { errorMessage: true },
    });

    const counts = new Map<string, number>();
    for (const task of tasks) {
      const category = classifyLlmError(
        new Error(task.errorMessage ?? 'unknown'),
      ).category;
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * 近期任务分页列表（按创建时间倒序，游标分页）
   */
  async recentTasks(
    days?: number,
    limit?: number,
    cursor?: string,
  ): Promise<RecentTasksDto> {
    const since = this.sinceDate(this.resolveRangeDays(days));
    const take = limit && limit > 0 ? limit : DEFAULT_RECENT_LIMIT;

    const rows = await this.prisma.streamTask.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: take + 1, // 多取一条判断是否还有下一页
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
      items: page.map((task) => this.toTaskSummary(task)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * 单任务详情 + 执行轨迹
   */
  async taskDetail(taskId: string): Promise<TaskDetailDto> {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
    });
    if (!task) {
      throw new NotFoundException('任务不存在');
    }

    const trace = await this.prisma.conversationTurnTraceItem.findMany({
      where: { taskId },
      orderBy: { sequence: 'asc' },
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        summary: true,
        toolName: true,
        durationMs: true,
        sequence: true,
      },
    });

    return {
      ...this.toTaskSummary(task),
      trace: trace.map((item) => ({
        id: item.id,
        type: item.type,
        status: item.status,
        title: item.title,
        summary: item.summary,
        toolName: item.toolName,
        durationMs: item.durationMs,
        sequence: item.sequence,
      })),
    };
  }

  /**
   * StreamTask 行 → 任务摘要（提取 resultPayload.metrics 里的 token / 计数）
   */
  private toTaskSummary(task: {
    id: string;
    agentId: string | null;
    type: string;
    status: string;
    errorMessage: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    resultPayload: Prisma.JsonValue | null;
  }): TaskSummaryDto {
    const metrics = this.readMetrics(task.resultPayload);
    const durationMs =
      task.startedAt && task.completedAt
        ? Math.max(0, task.completedAt.getTime() - task.startedAt.getTime())
        : null;

    return {
      id: task.id,
      agentId: task.agentId,
      type: task.type,
      status: task.status,
      durationMs,
      totalTokens: this.readNumber(
        this.readObject(metrics.tokenUsage)?.totalTokens,
      ),
      toolCallCount: this.readNumber(metrics.toolCallCount),
      modelCallCount: this.readNumber(metrics.modelCallCount),
      errorMessage: task.errorMessage,
      createdAt: task.createdAt.getTime(),
    };
  }

  private readMetrics(
    resultPayload: Prisma.JsonValue | null,
  ): Record<string, unknown> {
    const payload = this.readObject(resultPayload);
    return this.readObject(payload?.metrics) ?? {};
  }

  private readObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  // ---- 私有辅助 ----

  private resolveRangeDays(days?: number): number {
    return days && days > 0 ? days : DEFAULT_RANGE_DAYS;
  }

  private sinceDate(rangeDays: number): Date {
    return new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);
  }

  private countFor(
    breakdown: { status: string; count: number }[],
    status: StreamTaskStatus,
  ): number {
    return breakdown.find((r) => r.status === status)?.count ?? 0;
  }

  /**
   * 计算完成任务的平均时长（completedAt-startedAt）
   * @description Prisma 不支持列间算术聚合，取完成任务的时间戳在应用层平均；
   * 数据量受时间窗口约束，量级可控。
   */
  private async avgCompletedDurationMs(
    since: Date,
    completedCount: number,
    agentId?: string | null,
  ): Promise<number | null> {
    if (completedCount === 0) {
      return null;
    }
    const rows = await this.prisma.streamTask.findMany({
      where: {
        createdAt: { gte: since },
        status: StreamTaskStatus.COMPLETED,
        startedAt: { not: null },
        completedAt: { not: null },
        ...(agentId !== undefined ? { agentId } : {}),
      },
      select: { startedAt: true, completedAt: true },
    });
    if (rows.length === 0) {
      return null;
    }
    const total = rows.reduce((sum, r) => {
      const start = r.startedAt?.getTime() ?? 0;
      const end = r.completedAt?.getTime() ?? 0;
      return sum + Math.max(0, end - start);
    }, 0);
    return Math.round(total / rows.length);
  }
}
