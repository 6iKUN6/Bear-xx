import type { AgentStrategyDecision } from '../agent-loop.types';
import { CapabilityResolver } from './capability.resolver';
import { MCDONALDS_ORDER_TOOL_GROUP } from './capability.registry';

describe('CapabilityResolver 用户级麦当劳工具组', () => {
  const decision: AgentStrategyDecision = {
    mode: 'plan_execute',
    confidence: 1,
    reason: '测试',
    toolGroups: [MCDONALDS_ORDER_TOOL_GROUP],
    skills: [],
    maxSteps: 1,
    publicStatus: '测试中',
    source: 'rules',
  };

  it('任务没有锁定凭据时不会加载麦当劳 MCP 工具', async () => {
    const registry = {
      canUseToolGroup: jest.fn().mockReturnValue(false),
      getToolsByGroup: jest.fn().mockReturnValue([]),
      getSkill: jest.fn(),
      getTool: jest.fn(),
      canUseTool: jest.fn(),
      requiresApproval: jest.fn().mockReturnValue(false),
    };
    const credentialService = { requireActiveAccess: jest.fn() };
    const manager = { getMcDonaldsTools: jest.fn() };
    const orderService = { assertPaymentUrlEncryptionConfigured: jest.fn() };
    const resolver = new CapabilityResolver(
      registry as never,
      credentialService as never,
      manager as never,
      orderService as never,
    );

    const result = await resolver.resolve(decision, 'user-1');

    expect(result.tools).toEqual([]);
    expect(credentialService.requireActiveAccess).not.toHaveBeenCalled();
    expect(manager.getMcDonaldsTools).not.toHaveBeenCalled();
  });
});
