import { StrategyRouterService } from './strategy-router.service';
import { AgentStrategyMode, type AgentDefinition } from './agent-loop.types';
import {
  DEFAULT_TOOL_GROUP,
  MCDONALDS_ORDER_TOOL_GROUP,
} from './capability/capability.registry';

function buildRouter() {
  const registry = {
    listToolGroups: jest
      .fn()
      .mockReturnValue([
        DEFAULT_TOOL_GROUP,
        'search',
        MCDONALDS_ORDER_TOOL_GROUP,
      ]),
    listToolNames: jest.fn().mockReturnValue(['getWeather', 'webSearch']),
    listSkillNames: jest.fn().mockReturnValue(['coder']),
    hasTools: jest.fn().mockReturnValue(true),
    canUseToolGroup: jest.fn(
      (group: string, userId: string | undefined) =>
        group !== MCDONALDS_ORDER_TOOL_GROUP || userId === 'mcd-owner',
    ),
  };
  const llmService = { generateChatText: jest.fn() };
  const configService = { get: jest.fn().mockReturnValue('false') }; // 关掉 LLM 路由，走规则
  const router = new StrategyRouterService(
    registry as never,
    llmService as never,
    configService as never,
  );
  return { router, registry, llmService };
}

function buildModelRouter(modelDecision: unknown) {
  const { registry } = buildRouter();
  const llmService = {
    generateStructured: jest.fn().mockResolvedValue(modelDecision),
  };
  const configService = { get: jest.fn().mockReturnValue('true') };
  const router = new StrategyRouterService(
    registry as never,
    llmService as never,
    configService as never,
  );
  return { router, registry, llmService };
}

const baseCfg = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  systemPrompt: null,
  modelPreset: null,
  defaultStrategy: 'auto',
  allowedStrategies: [],
  toolGroups: [],
  skills: [],
  maxSteps: null,
  ...over,
});

const userMsg = (content: string) => [{ role: 'user' as const, content }];

describe('StrategyRouterService agent overrides', () => {
  it('default agent (all empty/auto) does not change the routed decision', async () => {
    const { router } = buildRouter();
    const plain = await router.route({ messages: userMsg('你好') });
    const withDefault = await router.route({
      messages: userMsg('你好'),
      agentConfig: baseCfg(),
    });
    expect(withDefault.mode).toBe(plain.mode);
    expect(withDefault.toolGroups).toEqual(plain.toolGroups);
    expect(withDefault.maxSteps).toBe(plain.maxSteps);
  });

  it('forced strategy short-circuits routing and forces the mode', async () => {
    const { router, llmService } = buildRouter();
    const decision = await router.route({
      messages: userMsg('随便聊聊'),
      agentConfig: baseCfg({ defaultStrategy: AgentStrategyMode.ReAct }),
    });
    expect(decision.mode).toBe(AgentStrategyMode.ReAct);
    // 强制模式不调用 LLM 路由
    expect(llmService.generateChatText).not.toHaveBeenCalled();
    // 带工具模式兜底默认组
    expect(decision.toolGroups).toContain(DEFAULT_TOOL_GROUP);
  });

  it('overrides toolGroups and maxSteps when specified', async () => {
    const { router } = buildRouter();
    const decision = await router.route({
      messages: userMsg('查一下深圳天气'),
      agentConfig: baseCfg({ toolGroups: ['search', 'unknown'], maxSteps: 3 }),
    });
    expect(decision.toolGroups).toEqual(['search']); // 未知组被过滤
    expect(decision.maxSteps).toBe(3);
  });

  it('clamps a routed mode outside allowedStrategies back into the set', async () => {
    const { router } = buildRouter();
    // 规则路由对"查一下天气"会选 ReAct；限制只允许 direct → 回落 direct
    const decision = await router.route({
      messages: userMsg('查一下深圳天气'),
      agentConfig: baseCfg({ allowedStrategies: [AgentStrategyMode.Direct] }),
    });
    expect(decision.mode).toBe(AgentStrategyMode.Direct);
  });

  it('buildResumeDecision falls back to the default group for the default agent', () => {
    const { router } = buildRouter();
    const decision = router.buildResumeDecision(baseCfg());
    expect(decision.toolGroups).toEqual([DEFAULT_TOOL_GROUP]);
  });

  it('规则降级时只为明确的麦当劳请求选择 mcd-order', async () => {
    const { router } = buildRouter();

    const decision = await router.route({
      messages: userMsg('帮我点麦当劳，先看看附近门店有什么套餐'),
      userId: 'mcd-owner',
    });

    expect(decision.mode).toBe(AgentStrategyMode.PlanExecute);
    expect(decision.toolGroups).toEqual([MCDONALDS_ORDER_TOOL_GROUP]);
  });

  it('LLM 路由不能把非麦当劳请求派给 mcd-order', async () => {
    const { router } = buildModelRouter({
      mode: 'plan_execute',
      toolGroups: [MCDONALDS_ORDER_TOOL_GROUP],
      skills: [],
      maxSteps: 4,
      confidence: 0.9,
      reason: '点餐请求',
    });

    const decision = await router.route({
      messages: userMsg('帮我点肯德基'),
      userId: 'mcd-owner',
    });

    expect(decision.toolGroups).toEqual([DEFAULT_TOOL_GROUP]);
  });

  it('LLM 路由保留 token 所有者明确请求的 mcd-order', async () => {
    const { router } = buildModelRouter({
      mode: 'plan_execute',
      toolGroups: [MCDONALDS_ORDER_TOOL_GROUP],
      skills: [],
      maxSteps: 4,
      confidence: 0.9,
      reason: '点餐请求',
    });

    const decision = await router.route({
      messages: userMsg('帮我点麦当劳'),
      userId: 'mcd-owner',
    });

    expect(decision.toolGroups).toEqual([MCDONALDS_ORDER_TOOL_GROUP]);
  });

  it('非 token 所有者即使明确请求麦当劳也不能拿到 mcd-order', async () => {
    const { router } = buildModelRouter({
      mode: 'plan_execute',
      toolGroups: [MCDONALDS_ORDER_TOOL_GROUP],
      skills: [],
      maxSteps: 4,
      confidence: 0.9,
      reason: '点餐请求',
    });

    const decision = await router.route({
      messages: userMsg('帮我点麦当劳'),
      userId: 'another-user',
    });

    expect(decision.toolGroups).toEqual([DEFAULT_TOOL_GROUP]);
  });
});
