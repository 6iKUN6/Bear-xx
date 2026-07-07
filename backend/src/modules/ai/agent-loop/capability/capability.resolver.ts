import { Injectable } from '@nestjs/common';
import type { AgentStrategyDecision } from '../agent-loop.types';
import { CapabilityRegistry } from './capability.registry';
import type { CapabilityTool, ResolvedCapabilities } from './capability.types';

/**
 * 能力解析器
 * @description 将策略决策解析为实际能力装配：依据 decision.toolGroups / skills 从注册表取出
 * 真实工具与技能提示词。只从已注册闭集解析，保证路由声明的能力都有对应实现。subagents 预留，暂返回空。
 */
@Injectable()
export class CapabilityResolver {
  constructor(private readonly registry: CapabilityRegistry) {}

  /**
   * 解析能力装配
   * @param decision 策略决策
   * @returns 返回本次执行的工具、追加系统提示词与子 agent 工具
   */
  resolve(decision: AgentStrategyDecision): ResolvedCapabilities {
    const toolMap = new Map<string, CapabilityTool>();

    for (const group of decision.toolGroups) {
      for (const tool of this.registry.getToolsByGroup(group)) {
        toolMap.set(tool.name, tool);
      }
    }

    const systemPromptAdditions: string[] = [];
    for (const skillName of decision.skills) {
      const skill = this.registry.getSkill(skillName);
      if (!skill) {
        continue;
      }

      systemPromptAdditions.push(skill.systemPrompt);
      for (const toolName of skill.toolNames ?? []) {
        const tool = this.registry.getTool(toolName);
        if (tool) {
          toolMap.set(tool.name, tool);
        }
      }
    }

    return {
      tools: [...toolMap.values()],
      systemPromptAdditions,
      subagentTools: [],
    };
  }
}
