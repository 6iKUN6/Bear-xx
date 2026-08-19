import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import {
  getTemporalConnectionOptions,
  getTemporalWorkerConfig,
  type TemporalWorkerConfig,
} from '../../../temporal/temporal.config';
import type {
  AgentFlowWorkflowInput,
  AgentFlowWorkflowStartInput,
} from '../../../temporal/workflows/agent-flow.workflow.types';

/** 启动 AgentFlow Workflow 时使用的受限 Temporal 参数。 */
export interface AgentFlowWorkflowStartOptions {
  taskQueue: string;
  workflowId: string;
  workflowIdConflictPolicy: 'USE_EXISTING';
  args: [AgentFlowWorkflowInput];
}

/** Temporal Workflow 启动结果。 */
export interface AgentFlowWorkflowStartResult {
  workflowId: string;
  runId: string;
}

/** 向既有 AgentFlow Workflow 发送审批完成 Signal 的受限参数。 */
export interface AgentFlowApprovalSignalOptions {
  workflowId: string;
  approvalId: string;
}

/** 向既有 AgentFlow Workflow 发送取消 Signal 的受限参数。 */
export interface AgentFlowCancelSignalOptions {
  workflowId: string;
}

/**
 * AgentFlow 的 Temporal Client
 * @description 仅负责连接 Temporal 并幂等启动 Workflow。它不创建 StreamTask、不更新任务状态、不发送 SSE，也不在 HTTP 启动时连接 Temporal；实际派发由阶段 5 的 FlowTaskDispatcher 接入。
 */
@Injectable()
export class TemporalClientService implements OnModuleDestroy {
  private connection: Connection | undefined;
  private clientPromise: Promise<Client> | undefined;

  /**
   * 幂等启动或获取一个 AgentFlow Workflow
   * @param input 只包含 StreamTask、FlowVersion 与 digest 的冻结标识
   * @returns 返回 Workflow ID 与 Temporal Run ID
   * @description Workflow ID 固定等于 StreamTask.id，冲突策略为 USE_EXISTING；API 重试不会创建第二条业务执行。
   */
  async startWorkflow(
    input: AgentFlowWorkflowStartInput,
  ): Promise<AgentFlowWorkflowStartResult> {
    const client = await this.getClient();
    const handle = await client.workflow.start(
      'agentFlowWorkflow',
      createAgentFlowWorkflowStartOptions(input, this.getConfig()),
    );
    return {
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    };
  }

  /**
   * 向指定 Flow Workflow 发送审批完成 Signal
   * @param input 仅包含 Workflow 与审批稳定标识
   * @returns 无返回值
   * @description Signal 不携带审批决定正文或用户输入；Workflow 收到 approvalId 后由恢复 Activity 从 PostgreSQL 的 AgentFlowApproval 读取事实。
   */
  async signalApproval(input: AgentFlowApprovalSignalOptions): Promise<void> {
    const client = await this.getClient();
    const handle = client.workflow.getHandle(input.workflowId);
    await handle.signal('agent-flow-approval-resolved', {
      approvalId: input.approvalId,
    });
  }

  /**
   * 向指定 Flow Workflow 发送取消 Signal
   * @param input 仅包含 Workflow 稳定标识
   * @returns 无返回值
   * @description 取消的业务事实仍以 StreamTask.status=CANCELED 为准；Signal 只负责唤醒或中断 Temporal 的等待与后续节点推进，不携带用户内容或决定正文。
   */
  async signalCancel(input: AgentFlowCancelSignalOptions): Promise<void> {
    const client = await this.getClient();
    const handle = client.workflow.getHandle(input.workflowId);
    await handle.signal('agent-flow-cancelled');
  }

  /**
   * 释放 Temporal 客户端连接
   * @returns 无返回值
   * @description Nest application context 关闭时回收惰性创建的 gRPC 连接；从未调度 Workflow 时不会产生连接。
   */
  async onModuleDestroy(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.clientPromise = undefined;
    await connection?.close();
  }

  /**
   * 获取惰性初始化的 Temporal Client
   * @returns 返回单例 Client 连接
   * @description 并发首次派发共享同一个初始化 Promise；连接失败后清除缓存，避免临时网络错误永久污染后续调度。
   */
  private getClient(): Promise<Client> {
    if (!this.clientPromise) {
      this.clientPromise = this.createClient().catch((error: unknown) => {
        this.clientPromise = undefined;
        throw error;
      });
    }
    return this.clientPromise;
  }

  /**
   * 建立 Temporal SDK Client
   * @returns 返回已绑定 Namespace 的 Client
   * @description 在实际连接前严格读取配置；因此 Worker/调度器配置错误会失败，而尚未启用 Flow 派发的 HTTP 进程不受影响。
   */
  private async createClient(): Promise<Client> {
    const config = this.getConfig();
    const connection = await Connection.connect(
      getTemporalConnectionOptions(config),
    );
    this.connection = connection;
    return new Client({ connection, namespace: config.namespace });
  }

  /**
   * 从当前进程环境读取严格 Temporal 配置
   * @returns 返回经过验证的 Worker 与 Client 共用配置
   * @description 配置读取延迟到实际 Temporal 操作，避免现有 HTTP API 在阶段 4 尚未派发 Flow 时因缺少 Temporal 配置无法启动。
   */
  private getConfig(): TemporalWorkerConfig {
    return getTemporalWorkerConfig(process.env);
  }
}

/**
 * 构造 AgentFlow Workflow 的幂等启动参数
 * @param input 只包含 StreamTask、FlowVersion 与 digest 的冻结标识
 * @param config 已校验的 Temporal 队列配置
 * @returns 返回可直接传给 Temporal WorkflowClient.start 的受限参数
 * @description 固定使用编排队列和 USE_EXISTING；输入仅含任务、版本、digest 与 Activity 队列，不把用户消息、完整 Flow JSON、审批决定或任何凭据带入启动输入。
 */
export function createAgentFlowWorkflowStartOptions(
  input: AgentFlowWorkflowStartInput,
  config: TemporalWorkerConfig,
): AgentFlowWorkflowStartOptions {
  return {
    taskQueue: config.orchestratorTaskQueue,
    workflowId: input.streamTaskId,
    workflowIdConflictPolicy: 'USE_EXISTING',
    args: [
      {
        ...input,
        activityTaskQueue: config.activityTaskQueue,
      },
    ],
  };
}
