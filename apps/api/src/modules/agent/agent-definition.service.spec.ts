import { AgentStrategy } from '@prisma/client';
import { AgentDefinitionService } from './agent-definition.service';
import { AgentStrategyMode } from '../ai/agent-loop/agent-loop.types';

function buildService(findFirst: jest.Mock) {
  const prisma = { agent: { findFirst } };
  return new AgentDefinitionService(prisma as never);
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  name: 'x',
  description: '',
  systemPrompt: null,
  modelPreset: null,
  defaultStrategy: AgentStrategy.AUTO,
  allowedStrategies: [],
  toolGroups: [],
  skills: [],
  maxSteps: null,
  enabled: true,
  isDefault: false,
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

  it('maps Prisma enums to lowercase modes and filters AUTO from allowed', async () => {
    const service = buildService(
      jest.fn().mockResolvedValue(
        row({
          defaultStrategy: AgentStrategy.REACT,
          allowedStrategies: [
            AgentStrategy.AUTO,
            AgentStrategy.REACT,
            AgentStrategy.DIRECT,
          ],
          toolGroups: ['default'],
          maxSteps: 4,
        }),
      ),
    );
    const def = await service.resolve('a1');
    expect(def.defaultStrategy).toBe(AgentStrategyMode.ReAct);
    expect(def.allowedStrategies).toEqual([
      AgentStrategyMode.ReAct,
      AgentStrategyMode.Direct,
    ]);
    expect(def.toolGroups).toEqual(['default']);
    expect(def.maxSteps).toBe(4);
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
