import type { TaskErrorCategory } from '@litter-bear/types/protocol';
import type { AgentFlowFinalStatus } from './agent-flow.workflow.types';

export {
  DEFAULT_CHAT_AGENT_LIMITS,
  DEFAULT_CHAT_AGENT_NODE_KEY,
} from '../../modules/chat-agent/default-chat-agent.constants';

/** 启动一次默认 ReAct 智能体 Workflow 所需的最小业务标识。 */
export interface ChatAgentWorkflowInput {
  streamTaskId: string;
  activityTaskQueue: string;
}

/** HTTP 派发器启动 Workflow 所需的业务快照，不暴露运行时队列配置。 */
export type ChatAgentWorkflowStartInput = Omit<
  ChatAgentWorkflowInput,
  'activityTaskQueue'
>;

/** 恢复智能体时携带的已完成审批标识；决定正文只在数据库里。 */
export interface ChatAgentResumeInput {
  workflow: ChatAgentWorkflowInput;
  approvalId: string;
}

/** 智能体一次推进后的受限结果。 */
export type ChatAgentRunResult =
  | { kind: 'completed' }
  | { kind: 'waiting_human'; approvalId: string; timeoutSeconds: number }
  | {
      kind: 'stopped';
      status: 'completed' | 'cancelled' | 'error';
      errorCategory?: TaskErrorCategory;
    };

/** 任务收尾 Activity 的最小输入。 */
export interface ChatAgentFinalizeInput {
  workflow: ChatAgentWorkflowInput;
  status: AgentFlowFinalStatus;
  /** 必须落在协议闭集内：它会直接进入下发给前端的 task.error 载荷 */
  errorCategory?: TaskErrorCategory;
  /** 只允许来自我们自己抛出的 ApplicationFailure 文案 */
  errorReason?: string;
}

/**
 * 默认 ReAct 智能体 Workflow 可调用的 Activity 闭集
 * @description 名称与 AgentFlowActivityApi 不重叠：两组 Activity 注册在同一个 Worker 上。
 */
export interface ChatAgentActivityApi {
  runChatAgent(input: {
    workflow: ChatAgentWorkflowInput;
  }): Promise<ChatAgentRunResult>;
  resumeChatAgent(input: ChatAgentResumeInput): Promise<ChatAgentRunResult>;
  finalizeChatAgentRun(input: ChatAgentFinalizeInput): Promise<void>;
}

/** Workflow 返回给调用方的最终结果。 */
export interface ChatAgentWorkflowResult {
  status: AgentFlowFinalStatus;
}
