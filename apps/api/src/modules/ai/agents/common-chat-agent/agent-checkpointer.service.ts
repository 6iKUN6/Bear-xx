import { Injectable } from '@nestjs/common';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';

/**
 * Agent 检查点存储
 * @description HITL 需要跨请求挂起/恢复同一次 agent 运行：初始运行在中断处持久化图状态，
 * 审批请求用同一 thread_id 从此处取回状态并续跑。P5a 先用进程内 MemorySaver（重启即丢），
 * 生产可在此换成基于现有 Redis 的 BaseCheckpointSaver 实现，业务层无感。
 *
 * 必须是单例：初始运行与审批恢复共享同一 saver 实例，才能按 thread_id 命中检查点。
 */
@Injectable()
export class AgentCheckpointerService {
  private readonly saver: BaseCheckpointSaver = new MemorySaver();

  /** 获取共享的检查点存储 */
  get(): BaseCheckpointSaver {
    return this.saver;
  }
}
