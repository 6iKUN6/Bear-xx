import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/**
 * 检查点表所在的独立 schema
 * @description 不放 public：这些表由 LangGraph 自建自管（setup() 内含建表与迁移），
 * 不进 Prisma 迁移历史；隔离出来可避免 prisma migrate/introspect 把它们当成 schema 漂移，
 * 也便于单独备份或清理。
 */
const CHECKPOINT_SCHEMA = 'langgraph';

/**
 * Agent 检查点存储
 * @description HITL 需要跨请求挂起/恢复同一次 agent 运行：初始运行在中断处持久化图状态，
 * 审批请求用同一 thread_id 从此处取回状态并续跑。
 *
 * 用 Postgres 而不是进程内存或 Redis：待审批任务的状态（StreamTask.status=WAITING_HUMAN）
 * 本就落在 Postgres，检查点必须与它同生共死——否则任务行说「等待审批」而图状态已丢失
 * （进程重启 / Redis TTL 到期 / 内存淘汰），恢复时找不到中断点，任务永久卡死。
 * 审批间隔可能数分钟到数小时，这类等待不适合放有过期语义的缓存。
 *
 * 必须是单例：初始运行与审批恢复共享同一 saver 实例，才能按 thread_id 命中检查点。
 */
@Injectable()
export class AgentCheckpointerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentCheckpointerService.name);
  /** 初始化失败时的兜底，保证 HITL 之外的链路不受影响 */
  private readonly fallbackSaver: BaseCheckpointSaver = new MemorySaver();
  private postgresSaver: PostgresSaver | null = null;

  constructor(private readonly configService: ConfigService) {}

  /**
   * 建表并就绪
   * @description setup() 幂等（CREATE SCHEMA / TABLE IF NOT EXISTS + 迁移），可重复启动。
   * 失败不阻断应用启动，但会退化为进程内存储——那正是本次要消除的缺陷，
   * 故按 error 级别告警，不做静默降级。
   */
  async onModuleInit(): Promise<void> {
    const connectionString = this.configService.get<string>('DATABASE_URL');
    if (!connectionString) {
      this.logger.error(
        'DATABASE_URL 缺失，HITL 检查点退化为进程内存储：重启会丢失待审批任务',
      );
      return;
    }

    try {
      const saver = PostgresSaver.fromConnString(connectionString, {
        schema: CHECKPOINT_SCHEMA,
      });
      await saver.setup();
      this.postgresSaver = saver;
      this.logger.log(
        `HITL 检查点已就绪（Postgres schema=${CHECKPOINT_SCHEMA}）`,
      );
    } catch (error) {
      this.logger.error(
        `HITL 检查点初始化失败，退化为进程内存储（重启会丢失待审批任务）：${(error as Error).message}`,
      );
    }
  }

  /** 释放检查点连接池（应用关闭时） */
  async onModuleDestroy(): Promise<void> {
    if (!this.postgresSaver) {
      return;
    }
    try {
      await this.postgresSaver.end();
    } catch (error) {
      this.logger.warn(`关闭检查点连接池失败：${(error as Error).message}`);
    }
  }

  /** 获取共享的检查点存储 */
  get(): BaseCheckpointSaver {
    return this.postgresSaver ?? this.fallbackSaver;
  }
}
