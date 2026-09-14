/**
 * C 端 DTO 手写对齐（同 admin 的 types.ts 策略：只消费少量端点，手写比生成更轻）。
 * 源：apps/api/src/modules/auth（AccountLoginDto / LoginResult）。
 * 改后端对应 DTO 时必须同步改这里，两边漂移不会有工具报错。
 */

import type {
  MessageRunMetrics,
  MessageStreamFeedbackState,
  MessageTraceItem,
} from "@litter-bear/chat-core";
import type { ReasoningSelection } from "@litter-bear/types";
import type {
  ApprovalDecisionType,
  ApprovalRequiredPayload,
} from "@litter-bear/types/protocol";

export type MembershipTier = "FREE" | "PLUS" | "PRO";

/** POST /auth/account/login 请求体 */
export interface AccountLoginInput {
  /** 账号名：4–20 位，仅限字母、数字、下划线；账号不存在时后端会自动注册 */
  username: string;
  /** 8–64 位 */
  password: string;
}

/** 登录响应里的用户信息（LoginResult.user；membership* 字段 UI 暂不消费） */
export interface AuthUser {
  id: string;
  nickname: string;
  avatarUrl: string;
  membershipTier: MembershipTier;
  effectiveMembershipTier: MembershipTier;
  /** JSON 序列化后为 ISO 字符串 */
  membershipExpiresAt: string | null;
  membershipExpired: boolean;
}

/** 登录 / 刷新响应（LoginResult） */
export interface AuthResponse {
  token: string;
  refreshToken: string;
  user: AuthUser;
}

/* ================= 会话 / 消息 =================
 * 源：apps/api/src/modules/conversation/dto/conversation-response.dto.ts
 * （ConversationDto / ConversationMessageDto；trace 复用 chat-core 的 MessageTraceItem）
 */

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  imageUrl?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  status: "streaming" | "done" | "error";
  /** 服务端为 epoch 毫秒 */
  createdAt: number;
  /** 助手消息的单轮执行轨迹（历史回显用，实时流式走 SSE 事件） */
  trace?: MessageTraceItem[];

  /* ── 以下为前端运行态字段（非 DTO），由 chat-store 在流式 / 加载时装配 ── */

  /** 执行轨迹折叠状态（实时事件流或历史 trace 构建） */
  streamFeedback?: MessageStreamFeedbackState;
  /** 本轮运行指标（token / 耗时 / 缓存），message.done 回填 */
  metrics?: MessageRunMetrics | null;
  /** HITL：待人工审批（approval.required 载荷）；提交决定后清空 */
  pendingApproval?: ApprovalRequiredPayload;
  /** HITL：已处理的审批结论（决定 + 原载荷），历史卡收敛为一行 */
  resolvedApproval?: {
    decision: ApprovalDecisionType;
    payload: ApprovalRequiredPayload;
  };
}

export interface Conversation {
  id: string;
  title: string;
  type?: string;
  agentIds?: string[];
  defaultAgentId?: string | null;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

/** POST /chat/message 请求体（SSE）；不传 conversationId 时后端自动创建会话 */
export interface ChatMessageInput {
  conversationId?: string;
  content: string;
  /** 指定使用的智能体 id；不传则用会话默认 / 内置智能体 */
  agentId?: string;
  /** 本条消息选择的模型预设业务 ID；必须属于回答智能体允许集合 */
  selectedModelPresetId?: string;
  /** 本轮思考设置（仅 direct Agent 可用；自定义 Flow 会忽略/拒绝） */
  reasoning?: ReasoningSelection;
}

/* ================= 智能体 =================
 * 源：apps/api/src/modules/agent/dto/agent-response.dto.ts（AgentResponseDto）
 * 列表只消费选择器需要的字段，其余（systemPrompt / toolGroups / 会员门槛等）暂不取。
 */

export interface Agent {
  id: string;
  name: string;
  description: string;
  /** null = 客户端显示名称首字 */
  avatar: string | null;
  /** null = 执行内置的直接回复 Flow */
  defaultFlowVersionId: string | null;
  enabled: boolean;
  visible: boolean;
  /** 当前用户是否可用（会员门槛等） */
  canUse: boolean;
  /** 是否进入终端发现列表的默认智能体 */
  isDefault: boolean;
}

/* ================= 智能体模型选项 =================
 * 源：apps/api/src/modules/agent/dto/agent-response.dto.ts
 * （AgentModelOptionsDto / AgentModelOptionDto）+ llm/dto/reasoning-selection.dto.ts
 * （ModelReasoningCapabilityDto）。ReasoningSelection 复用 @litter-bear/types 共享契约。
 */

/** 模型思考能力的供应商无关投影（服务端能力目录下发，终端不自行推断档位） */
export interface ModelReasoningCapability {
  activation?: {
    values: readonly ("enabled" | "disabled" | "auto")[];
    defaultValue: "enabled" | "disabled" | "auto";
    configurable: boolean;
  };
  effort?: {
    values: readonly ("minimal" | "low" | "medium" | "high" | "xhigh" | "max")[];
    defaultValue: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    configurable: boolean;
  };
  budget?: {
    supportsAuto: boolean;
    minimum?: number;
    maximum?: number;
    defaultValue: number | "auto";
    configurable: boolean;
  };
  defaultSelection?: ReasoningSelection;
}

/** 终端可安全展示和提交的单个模型选项 */
export interface AgentModelOption {
  modelPresetId: string;
  name: string;
  providerKey: string;
  model: string;
  reasoningCapability: ModelReasoningCapability | null;
  supportsVision: boolean;
}

/** GET /agents/:id/models 响应；自定义 Flow Agent 的 models 为空（前端自然隐藏入口） */
export interface AgentModelOptions {
  agentId: string;
  defaultModelPresetId: string | null;
  defaultReasoning: ReasoningSelection | null;
  models: AgentModelOption[];
}
