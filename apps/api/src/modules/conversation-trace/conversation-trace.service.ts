import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { mapStreamEventToTraceCommand } from './conversation-trace.mapper';
import {
  ConversationTraceItemStatus,
  type CompleteTraceItemInput,
  type FailTraceItemInput,
  type RecordStreamEventInput,
  type StartTraceItemInput,
} from './conversation-trace.types';

@Injectable()
export class ConversationTraceService {
  private readonly logger = new Logger(ConversationTraceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 记录流式事件对应的单轮对话轨迹
   * @param input 流式事件和任务上下文
   * @returns 无返回值
   * @description 将实时 SSE 事件归约为历史消息可回显的 trace item。delta 类高频事件不会写入 trace。
   */
  async recordStreamEvent(input: RecordStreamEventInput) {
    if (!input.userId) {
      return;
    }

    const command = mapStreamEventToTraceCommand(input);
    if (!command) {
      return;
    }

    try {
      if (command.action === 'start') {
        await this.startItem(command.input);
        return;
      }

      if (command.action === 'complete') {
        await this.completeItem(command.input);
        return;
      }

      if (command.action === 'fail') {
        await this.failItem(command.input);
        return;
      }

      await this.createSuccessItem(command.input);
    } catch (error) {
      this.logger.warn(
        `Record conversation trace failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * 创建正在执行的轨迹项
   * @param input 轨迹项创建参数
   * @returns 返回新创建的轨迹项
   * @description 用于 workflow/model/tool 等有 start/done 生命周期的节点，后续通过 traceKey 更新为完成或失败。
   */
  async startItem(input: StartTraceItemInput) {
    const existing = await this.findLatestItem(input.taskId, input.traceKey);
    if (existing) {
      return existing;
    }

    return this.createItem(input, ConversationTraceItemStatus.RUNNING);
  }

  /**
   * 完成正在执行的轨迹项
   * @param input 轨迹项完成参数
   * @returns 返回更新后的轨迹项；如果没有匹配项则返回 null
   * @description 根据 taskId 与 traceKey/nodeKey 查找已有 running 项，补充摘要、耗时、输出摘要和完成状态。
   */
  async completeItem(input: CompleteTraceItemInput) {
    const existing = await this.findRunningItem(input.taskId, input.traceKey);
    if (!existing) {
      return null;
    }

    const endedAt = input.endedAt ?? new Date();
    const durationMs = this.calculateDurationMs(existing.startedAt, endedAt);

    return this.prisma.conversationTurnTraceItem.update({
      where: { id: existing.id },
      data: {
        status: ConversationTraceItemStatus.SUCCESS,
        title: input.title,
        summary: input.summary,
        detail: input.detail,
        outputSummary: this.toJsonValue(input.outputSummary),
        metrics: this.toJsonValue(input.metrics),
        metadata: this.toJsonValue(input.metadata),
        endedAt,
        durationMs,
      },
    });
  }

  /**
   * 标记轨迹项失败
   * @param input 轨迹项失败参数
   * @returns 返回更新或新建后的失败轨迹项
   * @description 优先更新已有 running 项；如果缺少 start 事件，则补建一条失败轨迹，保证历史回显能看到异常。
   */
  async failItem(input: FailTraceItemInput) {
    const existing = await this.findRunningItem(input.taskId, input.traceKey);
    const endedAt = input.endedAt ?? new Date();

    if (!existing) {
      return this.createItem(
        {
          ...input,
          endedAt,
        },
        ConversationTraceItemStatus.ERROR,
      );
    }

    const durationMs = this.calculateDurationMs(existing.startedAt, endedAt);

    return this.prisma.conversationTurnTraceItem.update({
      where: { id: existing.id },
      data: {
        status: ConversationTraceItemStatus.ERROR,
        title: input.title,
        summary: input.summary,
        detail: input.detail,
        error: this.toJsonValue(input.error),
        metadata: this.toJsonValue(input.metadata),
        endedAt,
        durationMs,
      },
    });
  }

  /**
   * 创建已成功完成的轨迹项
   * @param input 轨迹项创建参数
   * @returns 返回新创建的轨迹项
   * @description 用于策略选择、技能选择、最终回复完成等瞬时事件，创建时直接写成 success 状态。
   */
  private async createSuccessItem(input: StartTraceItemInput) {
    return this.createItem(input, ConversationTraceItemStatus.SUCCESS);
  }

  /**
   * 创建轨迹项
   * @param input 轨迹项创建参数
   * @param status 初始状态
   * @returns 返回新创建的轨迹项
   * @description 统一分配 sequence、depth 并写入安全摘要字段，是 trace 表写入的唯一创建入口。
   */
  private async createItem(
    input: StartTraceItemInput,
    status: ConversationTraceItemStatus,
  ) {
    if (!input.userId) {
      return null;
    }

    const sequence = await this.nextSequence(input.taskId);
    const endedAt =
      status === ConversationTraceItemStatus.RUNNING
        ? undefined
        : (input.endedAt ?? new Date());

    return this.prisma.conversationTurnTraceItem.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        taskId: input.taskId,
        runId: input.runId ?? undefined,
        parentId: input.parentId ?? undefined,
        traceKey: input.traceKey ?? undefined,
        sequence,
        depth: input.parentId ? 1 : 0,
        type: input.type,
        status,
        title: input.title,
        summary: input.summary,
        detail: input.detail,
        strategy: input.strategy,
        skill: input.skill,
        graph: input.graph,
        nodeKey: input.nodeKey,
        toolName: input.toolName,
        mcpServer: input.mcpServer,
        mcpTool: input.mcpTool,
        inputSummary: this.toJsonValue(input.inputSummary),
        outputSummary: this.toJsonValue(input.outputSummary),
        error: this.toJsonValue(input.error),
        metrics: this.toJsonValue(input.metrics),
        metadata: this.toJsonValue(input.metadata),
        startedAt: input.startedAt ?? new Date(),
        endedAt,
        durationMs: this.calculateDurationMs(input.startedAt, endedAt),
      },
    });
  }

  /**
   * 查询同一任务下正在执行的轨迹项
   * @param taskId 任务ID
   * @param traceKey 轨迹匹配键
   * @returns 返回匹配的 running 轨迹项；不存在时返回 null
   * @description start/done/error 通过 traceKey 归并为同一条 trace，避免历史回显出现重复节点。
   */
  private findRunningItem(taskId: string, traceKey?: string | null) {
    return this.prisma.conversationTurnTraceItem.findFirst({
      where: {
        taskId,
        traceKey: traceKey ?? undefined,
        status: ConversationTraceItemStatus.RUNNING,
      },
      orderBy: { sequence: 'desc' },
      select: {
        id: true,
        startedAt: true,
      },
    });
  }

  /**
   * 查询同一任务下最近的轨迹项
   * @param taskId 任务ID
   * @param traceKey 轨迹匹配键
   * @returns 返回最近一条匹配轨迹项；不存在时返回 null
   * @description 用于 start 类事件幂等写入，避免工具 delta 多次到达时产生重复历史节点。
   */
  private findLatestItem(taskId: string, traceKey?: string | null) {
    if (!traceKey) {
      return null;
    }

    return this.prisma.conversationTurnTraceItem.findFirst({
      where: {
        taskId,
        traceKey,
      },
      orderBy: { sequence: 'desc' },
    });
  }

  /**
   * 获取下一条轨迹序号
   * @param taskId 任务ID
   * @returns 返回从 1 开始递增的序号
   * @description 当前单任务 trace 写入量较小，使用 count 分配展示序号；后续高并发同任务写入可改为任务级计数器。
   */
  private async nextSequence(taskId: string) {
    const count = await this.prisma.conversationTurnTraceItem.count({
      where: { taskId },
    });
    return count + 1;
  }

  /**
   * 计算轨迹项耗时
   * @param startedAt 开始时间
   * @param endedAt 结束时间
   * @returns 返回毫秒耗时；缺少时间时返回 undefined
   * @description 用于历史回显和后续性能排查，不参与业务状态判断。
   */
  private calculateDurationMs(startedAt?: Date | null, endedAt?: Date | null) {
    if (!startedAt || !endedAt) {
      return undefined;
    }
    return Math.max(0, endedAt.getTime() - startedAt.getTime());
  }

  /**
   * 转换为 Prisma JSON 值
   * @param value 任意输入值
   * @returns 返回可写入 Prisma Json 字段的值
   * @description 通过 JSON 序列化移除 undefined 和不可序列化引用，避免 trace 写入因为 payload 形状异常失败。
   */
  private toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
