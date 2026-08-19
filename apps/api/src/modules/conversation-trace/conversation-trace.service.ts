import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CapabilityRegistry } from '../ai/agent-loop/capability/capability.registry';
import { mapStreamEventToTraceCommand } from './conversation-trace.mapper';
import {
  ConversationTraceItemStatus,
  ConversationTraceItemType,
  type CompleteTraceItemInput,
  type FailTraceItemInput,
  type RecordStreamEventInput,
  type RecordStreamEventInputOf,
  type StartTraceItemInput,
  type TraceCommand,
} from './conversation-trace.types';
import { StreamTaskEventType } from '../stream-task/stream-task-event.types';

type TraceWriteClient = Pick<
  Prisma.TransactionClient,
  'conversationTurnTraceItem'
>;

@Injectable()
export class ConversationTraceService {
  private readonly logger = new Logger(ConversationTraceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilityRegistry?: CapabilityRegistry,
  ) {}

  /**
   * 记录流式事件对应的单轮对话轨迹
   * @param input 流式事件和任务上下文
   * @returns 无返回值
   * @description 将实时 SSE 事件归约为历史消息可回显的 trace item。delta 类高频事件不会写入 trace。
   */
  async recordStreamEvent<K extends StreamTaskEventType>(
    input: RecordStreamEventInputOf<K>,
  ) {
    if (!input.userId) {
      return;
    }

    // 泛型已保证 eventName 与 payload 对应，但 TS 无法证明未收窄的泛型形态
    // 可赋值给分发后的联合。断言收敛在这一处，调用方仍受泛型约束。
    const command = mapStreamEventToTraceCommand(
      input as RecordStreamEventInput,
    );
    if (!command) {
      return;
    }
    const enrichedCommand = this.enrichMcpMetadata(
      input as RecordStreamEventInput,
      command,
    );

    try {
      if (enrichedCommand.action === 'start') {
        await this.startItem(enrichedCommand.input);
        return;
      }

      if (enrichedCommand.action === 'complete') {
        await this.completeItem(enrichedCommand.input);
        return;
      }

      if (enrichedCommand.action === 'fail') {
        await this.failItem(enrichedCommand.input);
        return;
      }

      await this.createSuccessItem(enrichedCommand.input);
    } catch (error) {
      this.logger.warn(
        `Record conversation trace failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * 在调用方事务内记录流式事件对应的轨迹
   * @param transaction 当前 PostgreSQL 事务客户端
   * @param input 流式事件和任务上下文
   * @returns 返回写入或更新后的轨迹项；无需归约的事件返回 null
   * @description 与普通 `recordStreamEvent` 不同，本方法不会吞掉异常，确保审批决定、语义事件与 trace 可作为同一业务事实原子提交。
   */
  async recordStreamEventInTransaction<K extends StreamTaskEventType>(
    transaction: Prisma.TransactionClient,
    input: RecordStreamEventInputOf<K>,
  ) {
    if (!input.userId) {
      return null;
    }

    const command = mapStreamEventToTraceCommand(
      input as RecordStreamEventInput,
    );
    if (!command) {
      return null;
    }
    const enrichedCommand = this.enrichMcpMetadata(
      input as RecordStreamEventInput,
      command,
    );

    if (enrichedCommand.action === 'start') {
      return this.startItem(enrichedCommand.input, transaction);
    }
    if (enrichedCommand.action === 'complete') {
      return this.completeItem(enrichedCommand.input, transaction);
    }
    if (enrichedCommand.action === 'fail') {
      return this.failItem(enrichedCommand.input, transaction);
    }
    return this.createSuccessItem(enrichedCommand.input, transaction);
  }

  /**
   * 创建正在执行的轨迹项
   * @param input 轨迹项创建参数
   * @returns 返回新创建的轨迹项
   * @description 用于 workflow/model/tool 等有 start/done 生命周期的节点，后续通过 traceKey 更新为完成或失败。
   */
  async startItem(
    input: StartTraceItemInput,
    client: TraceWriteClient = this.prisma,
  ) {
    const existing = await this.findLatestItem(
      input.taskId,
      input.traceKey,
      client,
    );
    if (existing) {
      return existing;
    }

    return this.createItem(input, ConversationTraceItemStatus.RUNNING, client);
  }

  /**
   * 完成正在执行的轨迹项
   * @param input 轨迹项完成参数
   * @returns 返回更新后的轨迹项；如果没有匹配项则返回 null
   * @description 根据 taskId 与 traceKey/nodeKey 查找已有 running 项，补充摘要、耗时、输出摘要和完成状态。
   */
  async completeItem(
    input: CompleteTraceItemInput,
    client: TraceWriteClient = this.prisma,
  ) {
    const existing = await this.findRunningItem(
      input.taskId,
      input.traceKey,
      client,
    );
    if (!existing) {
      return null;
    }

    const endedAt = input.endedAt ?? new Date();
    const durationMs = this.calculateDurationMs(existing.startedAt, endedAt);

    return client.conversationTurnTraceItem.update({
      where: { id: existing.id },
      data: {
        status: ConversationTraceItemStatus.SUCCESS,
        title: input.title,
        summary: input.summary,
        detail: input.detail,
        mcpServer: input.mcpServer,
        mcpTool: input.mcpTool,
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
  async failItem(
    input: FailTraceItemInput,
    client: TraceWriteClient = this.prisma,
  ) {
    const existing = await this.findRunningItem(
      input.taskId,
      input.traceKey,
      client,
    );
    const endedAt = input.endedAt ?? new Date();

    if (!existing) {
      return this.createItem(
        {
          ...input,
          endedAt,
        },
        ConversationTraceItemStatus.ERROR,
        client,
      );
    }

    const durationMs = this.calculateDurationMs(existing.startedAt, endedAt);

    return client.conversationTurnTraceItem.update({
      where: { id: existing.id },
      data: {
        status: ConversationTraceItemStatus.ERROR,
        title: input.title,
        summary: input.summary,
        detail: input.detail,
        mcpServer: input.mcpServer,
        mcpTool: input.mcpTool,
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
  private async createSuccessItem(
    input: StartTraceItemInput,
    client: TraceWriteClient = this.prisma,
  ) {
    return this.createItem(input, ConversationTraceItemStatus.SUCCESS, client);
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
    client: TraceWriteClient = this.prisma,
  ) {
    if (!input.userId) {
      return null;
    }

    const sequence = await this.nextSequence(input.taskId, client);
    const endedAt =
      status === ConversationTraceItemStatus.RUNNING
        ? undefined
        : (input.endedAt ?? new Date());

    return client.conversationTurnTraceItem.create({
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
   * 查询任务下待处理的审批轨迹项
   * @param taskId 任务ID
   * @returns 返回最近一条 RUNNING 的审批项；不存在时返回 null
   * @description 提交人工决定时用它取回请求侧的 traceKey/nodeKey，使 approval.resolved
   * 能收敛同一条 trace，而不是另起一条孤立记录。审批是人工门禁、频率极低，
   * 这里多一次查询不影响链路。
   */
  findPendingApprovalItem(taskId: string) {
    return this.prisma.conversationTurnTraceItem.findFirst({
      where: {
        taskId,
        type: ConversationTraceItemType.APPROVAL,
        status: ConversationTraceItemStatus.RUNNING,
      },
      orderBy: { sequence: 'desc' },
      select: {
        traceKey: true,
        nodeKey: true,
        toolName: true,
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
  private findRunningItem(
    taskId: string,
    traceKey?: string | null,
    client: TraceWriteClient = this.prisma,
  ) {
    return client.conversationTurnTraceItem.findFirst({
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
  private findLatestItem(
    taskId: string,
    traceKey?: string | null,
    client: TraceWriteClient = this.prisma,
  ) {
    if (!traceKey) {
      return null;
    }

    return client.conversationTurnTraceItem.findFirst({
      where: {
        taskId,
        traceKey,
      },
      orderBy: { sequence: 'desc' },
    });
  }

  /**
   * 为 MCP 工具调用补充来源元数据
   * @param eventInput 原始流式事件输入
   * @param command 已由事件映射出的 trace 命令
   * @returns 返回补充了 MCP 来源的 trace 命令；非 MCP 工具原样返回
   * @description MCP 来源属于后端执行审计，不需要透传 SSE 协议。这里用运行时工具名查询
   * CapabilityRegistry 的注册元数据，因此多 server 与自定义工具名前缀下都不依赖字符串猜测。
   * start 帧可能没有名称，后续 delta/done/error 帧仍会补齐到同一 traceKey。
   */
  private enrichMcpMetadata(
    eventInput: RecordStreamEventInput,
    command: TraceCommand,
  ): TraceCommand {
    if (
      eventInput.eventName !== StreamTaskEventType.ToolCallStart &&
      eventInput.eventName !== StreamTaskEventType.ToolCallDelta &&
      eventInput.eventName !== StreamTaskEventType.ToolCallDone &&
      eventInput.eventName !== StreamTaskEventType.ToolCallError &&
      eventInput.eventName !== StreamTaskEventType.ApprovalRequired &&
      eventInput.eventName !== StreamTaskEventType.ApprovalResolved
    ) {
      return command;
    }

    const payload = eventInput.payload;
    const toolName =
      payload && 'toolName' in payload
        ? payload.toolName
        : payload && 'name' in payload
          ? payload.name
          : undefined;
    if (!toolName) {
      return command;
    }

    const metadata = this.capabilityRegistry?.getToolMetadata(toolName);
    if (!metadata) {
      return command;
    }

    if (command.action === 'start') {
      return {
        action: 'start',
        input: {
          ...command.input,
          mcpServer: metadata.mcpServer,
          mcpTool: metadata.mcpTool,
        },
      };
    }

    if (command.action === 'complete') {
      return {
        action: 'complete',
        input: {
          ...command.input,
          mcpServer: metadata.mcpServer,
          mcpTool: metadata.mcpTool,
        },
      };
    }

    if (command.action === 'fail') {
      return {
        action: 'fail',
        input: {
          ...command.input,
          mcpServer: metadata.mcpServer,
          mcpTool: metadata.mcpTool,
        },
      };
    }

    return {
      action: 'create-success',
      input: {
        ...command.input,
        mcpServer: metadata.mcpServer,
        mcpTool: metadata.mcpTool,
      },
    };
  }

  /**
   * 获取下一条轨迹序号
   * @param taskId 任务ID
   * @returns 返回从 1 开始递增的序号
   * @description 当前单任务 trace 写入量较小，使用 count 分配展示序号；后续高并发同任务写入可改为任务级计数器。
   */
  private async nextSequence(
    taskId: string,
    client: TraceWriteClient = this.prisma,
  ) {
    const count = await client.conversationTurnTraceItem.count({
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
