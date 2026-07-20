import type { StructuredToolInterface } from '@langchain/core/tools';

/** 可被 agent 装载的工具（LangChain tool 对象） */
export type CapabilityTool = StructuredToolInterface;

/**
 * 技能定义
 * @description 一段注入到系统提示词的能力说明，可选绑定一组工具子集。P2 仅定义接口，暂不注册实例。
 */
export interface SkillDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  toolNames?: string[];
}

/**
 * 子 agent 定义
 * @description 以 agent-as-tool 方式暴露给父 agent 的子智能体。P2 仅预留接口，暂不注册实例。
 */
export interface SubagentDefinition {
  name: string;
  description: string;
}

/**
 * 能力解析结果
 * @description CapabilityResolver 依据策略决策产出的最终装配，交付给统一 executor。
 */
export interface ResolvedCapabilities {
  tools: CapabilityTool[];
  systemPromptAdditions: string[];
  subagentTools: CapabilityTool[];
  /** 本次装配的工具中需要人工审批的工具名（用于 HITL 中断） */
  approvalToolNames: string[];
}
