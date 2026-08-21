import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Prisma, StreamTaskStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TemporalClientService } from './temporal-client.service';
import { isWorkflowUnreachableError } from './temporal-signal-error';

const CANCELLATION_DISPATCH_INTERVAL_MS = 5_000;
const CANCELLATION_DISPATCH_BATCH_SIZE = 50;

/**
 * AgentFlow 取消 Signal 派发器
 * @description 以 PostgreSQL 中已取消的 StreamTask 为事实源投递 Temporal cancel Signal。HTTP 取消在写库后即使进程退出，后续任意健康 API 或 Worker 进程也能扫描并补发未记录成功的取消通知。
 */
@Injectable()
export class AgentFlowCancellationDispatcherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(
    AgentFlowCancellationDispatcherService.name,
  );
  private dispatchTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly temporalClientService: TemporalClientService,
  ) {}

  /**
   * 启动取消 Signal 的补偿派发循环
   * @returns 无返回值
   * @description 启动时先扫描一次遗留取消任务，再每五秒补偿一次。它不参与普通聊天任务，也不改变 StreamTask 的取消状态。
   */
  onApplicationBootstrap(): void {
    this.dispatchSafely();
    this.dispatchTimer = setInterval(
      () => this.dispatchSafely(),
      CANCELLATION_DISPATCH_INTERVAL_MS,
    );
  }

  /**
   * 停止取消 Signal 的补偿派发循环
   * @returns 无返回值
   * @description 应用关闭后清理定时器，避免测试或独立 Worker 已结束但仍保留数据库轮询句柄。
   */
  onModuleDestroy(): void {
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = undefined;
    }
  }

  /**
   * 派发尚未记录成功的 Flow 取消 Signal
   * @returns 无返回值
   * @description 查询已取消且锁定了 Temporal Workflow 的 Flow 任务；Signal 成功后将投递时间写入 executionState。重复 Signal 对 Workflow 是幂等的，而写入状态失败会在下轮扫描中重试。
   */
  async dispatchPending(): Promise<void> {
    const tasks = await this.prisma.streamTask.findMany({
      where: {
        status: StreamTaskStatus.CANCELED,
        flowVersionId: { not: null },
        temporalWorkflowId: { not: null },
        // 必须在 SQL 层排除已处理任务：若投递标记只在内存里过滤，已处理记录会长期
        // 停留在 updatedAt 最旧的位置占满 take 额度，累计到批次大小后新取消的任务
        // 永远进不了批次，取消 Signal 再也发不出去。
        cancelSignalSettledAt: null,
      },
      orderBy: { updatedAt: 'asc' },
      take: CANCELLATION_DISPATCH_BATCH_SIZE,
      select: {
        id: true,
        temporalWorkflowId: true,
        executionState: true,
      },
    });

    for (const task of tasks) {
      const workflowId = task.temporalWorkflowId;
      if (!workflowId) {
        continue;
      }
      await this.dispatchOne({ ...task, temporalWorkflowId: workflowId });
    }
  }

  /**
   * 向一条取消任务的 Workflow 投递 Signal 并记录投递时间
   * @param task 已取消任务的最小数据库快照
   * @returns 无返回值
   * @description Signal 成功后通过 CANCELED 条件更新标记投递，避免任务状态已被其他终态流程改变时覆盖 executionState。若调用失败，保留无标记状态供定时扫描重试。
   */
  private async dispatchOne(task: {
    id: string;
    temporalWorkflowId: string;
    executionState: Prisma.JsonValue | null;
  }): Promise<void> {
    try {
      await this.temporalClientService.signalCancel({
        workflowId: task.temporalWorkflowId,
      });
      await this.settle(task);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '未知取消 Signal 错误';
      // Workflow 已关闭时取消 Signal 本就无意义，且永远不会成功；若不落终态标记，
      // 这条记录会一直留在批次队头并挤掉后续新取消的任务。
      if (isWorkflowUnreachableError(error)) {
        this.logger.log(
          `Flow 取消 Signal 目标已关闭，按已处理收敛（taskId=${task.id}）：${message.slice(0, 200)}`,
        );
        await this.settle(task);
        return;
      }
      this.logger.warn(`Flow 取消 Signal 投递失败：${message.slice(0, 500)}`);
    }
  }

  /**
   * 标记一条取消任务的 Signal 已处理
   * @param task 已取消任务的最小数据库快照
   * @returns 无返回值
   * @description 同时写 cancelSignalSettledAt 与 executionState 标记：前者供派发查询在
   * SQL 层排除，后者保留既有的可观测字段。条件更新避免覆盖已被其他终态流程改写的任务。
   */
  private async settle(task: {
    id: string;
    temporalWorkflowId: string;
    executionState: Prisma.JsonValue | null;
  }): Promise<void> {
    await this.prisma.streamTask.updateMany({
      where: {
        id: task.id,
        status: StreamTaskStatus.CANCELED,
        temporalWorkflowId: task.temporalWorkflowId,
      },
      data: {
        cancelSignalSettledAt: new Date(),
        executionState: toCancellationDeliveredExecutionState(
          task.executionState,
        ),
      },
    });
  }

  /**
   * 在后台循环中安全执行一次取消 Signal 派发
   * @returns 无返回值
   * @description 定时补偿不得因数据库或 Temporal 的瞬时错误影响 Nest 启动；失败仅记录告警并等待下一轮重试。
   */
  private dispatchSafely(): void {
    void this.dispatchPending().catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : '未知取消 Signal 派发错误';
      this.logger.warn(`Flow 取消 Signal 派发失败：${message.slice(0, 500)}`);
    });
  }
}

/**
 * 将取消 Signal 投递标记合并进现有 Flow 执行状态
 * @param value StreamTask.executionState 的原始 JSON 值
 * @returns 返回可安全写回 Prisma 的 JSON 对象
 * @description 保留 Plan 与 PlanLoop 状态，只新增不含用户数据的投递时间；用 JSON 往返清除 undefined，满足 Prisma Json 输入约束。
 * 节点幂等结果与预算用量已迁往 `AgentFlowNodeExecution` 表与 StreamTask 计数列，不在这块 JSON 里。
 */
function toCancellationDeliveredExecutionState(
  value: Prisma.JsonValue | null,
): Prisma.InputJsonObject {
  const root = isJsonObject(value) ? value : {};
  const flow = isJsonObject(root.agentFlow) ? root.agentFlow : {};
  return JSON.parse(
    JSON.stringify({
      ...root,
      agentFlow: {
        ...flow,
        cancelSignalDeliveredAt: new Date().toISOString(),
      },
    }),
  ) as Prisma.InputJsonObject;
}

/**
 * 判断值是否为 Prisma JSON 对象
 * @param value 待检查的 JSON 值
 * @returns 非数组对象时返回 true
 * @description 取消补偿只读取自身写入的固定路径，不把数组、null 或标量解释为可展开的执行状态。
 */
function isJsonObject(
  value: Prisma.JsonValue | null | undefined,
): value is Prisma.JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
