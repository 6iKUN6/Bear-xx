import { AgentLoopRunnerService } from './agent-loop-runner.service';
import { AgentStrategyMode } from './agent-loop.types';
import { MCDONALDS_ORDER_TOOL_GROUP } from './capability/capability.registry';

describe('AgentLoopRunnerService HITL 凭据快照', () => {
  it('恢复点餐审批任务时复用首轮锁定的凭据ID', async () => {
    const resolver = {
      resolve: jest.fn().mockResolvedValue({
        tools: [],
        subagentTools: [],
        approvalToolNames: [],
        systemPromptAdditions: [],
      }),
    };
    const runner = new AgentLoopRunnerService(
      {} as never,
      {} as never,
      resolver as never,
    );

    await runner.resolveResumeCapabilities(
      { messages: [], userId: 'user-1', mcdonaldsCredentialId: 'new-token' },
      {
        strategy: AgentStrategyMode.PlanExecute,
        toolGroups: [MCDONALDS_ORDER_TOOL_GROUP],
        skills: [],
        maxSteps: 6,
        mcdonaldsCredentialId: 'credential-at-start',
      },
    );

    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        toolGroups: [MCDONALDS_ORDER_TOOL_GROUP],
      }),
      'user-1',
      'credential-at-start',
    );
  });
});
