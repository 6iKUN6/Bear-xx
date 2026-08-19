import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AgentFlowSignalOutboxStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TemporalClientService } from './temporal-client.service';

const OUTBOX_BATCH_SIZE = 50;
const OUTBOX_DISPATCH_INTERVAL_MS = 5_000;
const OUTBOX_SENDING_LEASE_MS = 60_000;

/**
 * AgentFlow 审批 Signal outbox
 * @description 将已提交的 PostgreSQL 审批决定可靠地投递给 Temporal。outbox 中只保存审批标识，不复制决定正文；失败时保留待投递状态，供后续调用重试。
 */
@Injectable()
export class AgentFlowSignalOutboxService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AgentFlowSignalOutboxService.name);
  private dispatchTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly temporalClientService: TemporalClientService,
  ) {}

  /**
   * 启动审批 Signal outbox 的后台派发循环
   * @returns 无返回值
   * @description 启动时立即尝试投递积压记录，随后定期轮询。API 与 Activity Worker 可同时运行该循环，数据库条件更新会保证同一记录仅由一个进程持有发送权。
   */
  onApplicationBootstrap(): void {
    this.dispatchSafely();
    this.dispatchTimer = setInterval(
      () => this.dispatchSafely(),
      OUTBOX_DISPATCH_INTERVAL_MS,
    );
  }

  /**
   * 停止审批 Signal outbox 的后台派发循环
   * @returns 无返回值
   * @description Nest 应用上下文退出时释放定时器，避免测试或 Worker 关闭后继续尝试访问数据库和 Temporal。
   */
  onModuleDestroy(): void {
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = undefined;
    }
  }

  /**
   * 投递当前待发送的审批 Signal
   * @returns 无返回值
   * @description 逐条以条件更新抢占 outbox，避免多实例 API 同时发送同一条记录；Temporal Signal 成功后才标为 DELIVERED，失败回退 PENDING 等待下次重试。
   */
  async dispatchPending(): Promise<void> {
    await this.recoverExpiredSendingLeases();
    const pending = await this.prisma.agentFlowSignalOutbox.findMany({
      where: { status: AgentFlowSignalOutboxStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: OUTBOX_BATCH_SIZE,
      select: {
        id: true,
        taskId: true,
        approvalId: true,
        status: true,
        attempts: true,
      },
    });

    for (const outbox of pending) {
      await this.dispatchOne(outbox);
    }
  }

  /**
   * 回收超过发送租约的 outbox 记录
   * @returns 无返回值
   * @description 进程可能在将记录标记为 SENDING 后、调用 Temporal 前异常退出；超过租约的记录回退 PENDING 后可由任意健康进程继续派发。重复 Signal 由 Workflow 按 approvalId 幂等处理。
   */
  private async recoverExpiredSendingLeases(): Promise<void> {
    const staleBefore = new Date(Date.now() - OUTBOX_SENDING_LEASE_MS);
    await this.prisma.agentFlowSignalOutbox.updateMany({
      where: {
        status: AgentFlowSignalOutboxStatus.SENDING,
        updatedAt: { lt: staleBefore },
      },
      data: {
        status: AgentFlowSignalOutboxStatus.PENDING,
        lastError: 'Signal 投递租约已超时，等待重新派发',
      },
    });
  }

  /**
   * 投递一条已读取的审批 Signal
   * @param outbox 当前待发送的 outbox 最小记录
   * @returns 无返回值
   * @description 先用 PENDING -> SENDING 的条件更新取得投递所有权，再调用 Temporal；出错只记录安全错误文本并回退 PENDING，保证数据库提交与外部 Signal 间的故障窗口可恢复。
   */
  private async dispatchOne(outbox: {
    id: string;
    taskId: string;
    approvalId: string;
    status: AgentFlowSignalOutboxStatus;
    attempts: number;
  }): Promise<void> {
    const claimed = await this.prisma.agentFlowSignalOutbox.updateMany({
      where: {
        id: outbox.id,
        status: AgentFlowSignalOutboxStatus.PENDING,
      },
      data: {
        status: AgentFlowSignalOutboxStatus.SENDING,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      return;
    }

    try {
      await this.temporalClientService.signalApproval({
        workflowId: outbox.taskId,
        approvalId: outbox.approvalId,
      });
      await this.prisma.agentFlowSignalOutbox.updateMany({
        where: {
          id: outbox.id,
          status: AgentFlowSignalOutboxStatus.SENDING,
        },
        data: {
          status: AgentFlowSignalOutboxStatus.DELIVERED,
          deliveredAt: new Date(),
          lastError: null,
        },
      });
    } catch (error) {
      const message = this.toSafeErrorMessage(error);
      this.logger.warn(`Flow 审批 Signal 投递失败：${message}`);
      await this.prisma.agentFlowSignalOutbox.updateMany({
        where: {
          id: outbox.id,
          status: AgentFlowSignalOutboxStatus.SENDING,
        },
        data: {
          status: AgentFlowSignalOutboxStatus.PENDING,
          lastError: message,
        },
      });
    }
  }

  /**
   * 在后台循环中安全执行一次 outbox 派发
   * @returns 无返回值
   * @description 后台轮询不能因瞬时数据库或 Temporal 故障导致 Nest 启动失败；错误会明确告警，记录状态仍保留在数据库供下一轮恢复。
   */
  private dispatchSafely(): void {
    void this.dispatchPending().catch((error: unknown) => {
      this.logger.warn(
        `Flow 审批 Signal outbox 轮询失败：${this.toSafeErrorMessage(error)}`,
      );
    });
  }

  /**
   * 转换可安全持久化的投递错误说明
   * @param error Temporal Client 抛出的未知错误
   * @returns 返回受长度限制的错误文本
   * @description 不持久化对象、堆栈或请求上下文，避免将凭据和审批决定意外写入 outbox。
   */
  private toSafeErrorMessage(error: unknown): string {
    const message =
      error instanceof Error ? error.message : '未知 Signal 投递错误';
    return message.slice(0, 500);
  }
}
