import { Injectable } from '@nestjs/common';
import type { AgentStrategyDecision } from '../agent-loop.types';
import { McpClientManager } from '../../mcp/mcp-client-manager.service';
import { MCDONALDS_MCP_SERVER_NAME } from '../../mcp/McDonalds.mcp';
import { McDonaldsCredentialService } from '../../../mcdonalds-credential/mcdonalds-credential.service';
import { McDonaldsOrderService } from '../../../mcdonalds-order/mcdonalds-order.service';
import {
  MCDONALDS_ORDER_TOOL_GROUP,
  CapabilityRegistry,
} from './capability.registry';
import type { CapabilityTool, ResolvedCapabilities } from './capability.types';

/**
 * 能力解析器
 * @description 将策略决策解析为实际能力装配。静态工具从 registry 读取；麦当劳工具按当前任务锁定的用户凭据
 * 临时加载并包装，避免将任何用户的外部账号身份常驻在全局 Agent 注册表中。
 */
@Injectable()
export class CapabilityResolver {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly mcdonaldsCredentialService: McDonaldsCredentialService,
    private readonly mcpClientManager: McpClientManager,
    private readonly mcdonaldsOrderService: McDonaldsOrderService,
  ) {}

  /**
   * 解析能力装配
   * @param decision 策略决策
   * @param userId 当前认证用户ID
   * @param mcdonaldsCredentialId 当前任务锁定的麦当劳凭据ID
   * @returns 返回本轮工具、追加系统提示词与审批工具名
   * @description 含麦当劳工具组时必须在此校验凭据仍为 ACTIVE；解绑或失效不会静默降级到其他账号。
   */
  async resolve(
    decision: AgentStrategyDecision,
    userId?: string,
    mcdonaldsCredentialId?: string,
  ): Promise<ResolvedCapabilities> {
    const toolMap = new Map<string, CapabilityTool>();
    for (const group of decision.toolGroups) {
      if (
        !this.registry.canUseToolGroup(group, userId, mcdonaldsCredentialId)
      ) {
        continue;
      }
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
        if (
          tool &&
          this.registry.canUseTool(toolName, userId, mcdonaldsCredentialId)
        ) {
          toolMap.set(tool.name, tool);
        }
      }
    }

    if (
      decision.toolGroups.includes(MCDONALDS_ORDER_TOOL_GROUP) &&
      mcdonaldsCredentialId
    ) {
      if (!userId) {
        throw new Error('麦当劳点餐能力缺少用户上下文');
      }
      const access = await this.mcdonaldsCredentialService.requireActiveAccess(
        userId,
        mcdonaldsCredentialId,
      );
      this.mcdonaldsOrderService.assertPaymentUrlEncryptionConfigured();
      const tools = await this.mcpClientManager.getMcDonaldsTools(
        access.credentialId,
        access.token,
      );
      for (const rawTool of tools) {
        const metadata = this.mcpClientManager.getToolMetadata(
          MCDONALDS_MCP_SERVER_NAME,
          rawTool.name,
        );
        if (!metadata) {
          throw new Error(`麦当劳 MCP 工具缺少来源元数据：${rawTool.name}`);
        }
        const wrapped = this.mcdonaldsOrderService.wrapAgentTool(
          rawTool,
          metadata,
        );
        toolMap.set(wrapped.name, wrapped);
      }
    }

    const approvalToolNames = [...toolMap.keys()].filter((name) =>
      this.registry.requiresApproval(name),
    );
    return {
      tools: [...toolMap.values()],
      systemPromptAdditions,
      subagentTools: [],
      approvalToolNames,
    };
  }
}
