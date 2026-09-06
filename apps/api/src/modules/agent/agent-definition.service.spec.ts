import { AgentDefinitionService } from './agent-definition.service';

/**
 * @deprecated 随 agent-definition.service 一起废弃。
 *
 * 「枚举映射与 AUTO 过滤」那条用例已删除：策略/工具组/技能/步数四类列随方案 A 移除，
 * 那段行为不再存在。剩下的两条（无行时回退合成默认、缓存与失效）仍描述真实行为。
 */

function buildService(findFirst: jest.Mock) {
  const prisma = { agent: { findFirst } };
  return new AgentDefinitionService(prisma as never);
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  name: 'x',
  description: '',
  systemPrompt: null,
  enabled: true,
  visible: true,
  minimumMembershipTier: 'FREE',
  isDefault: false,
  defaultFlowVersionId: null,
  defaultModelPresetId: null,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('AgentDefinitionService', () => {
  it('returns synthetic default when no agent row exists', async () => {
    const service = buildService(jest.fn().mockResolvedValue(null));
    const def = await service.resolve('missing');
    expect(def).toEqual({
      systemPrompt: null,
      modelPreset: null,
      defaultStrategy: 'auto',
      allowedStrategies: [],
      toolGroups: [],
      skills: [],
      maxSteps: null,
    });
  });

  it('caches by key and re-queries after invalidate', async () => {
    const findFirst = jest.fn().mockResolvedValue(row());
    const service = buildService(findFirst);
    await service.resolve('a1');
    await service.resolve('a1');
    expect(findFirst).toHaveBeenCalledTimes(1);
    service.invalidate();
    await service.resolve('a1');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});
