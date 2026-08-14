import { BadRequestException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Agent, AgentStrategy, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentDefinitionService } from './agent-definition.service';
import { AgentService } from './agent.service';

type UpdateManyArgs = {
  where: { isDefault: boolean; id: { not: string } };
  data: { isDefault: boolean };
};

type UpdateArgs = {
  where: { id: string };
  data: { isDefault: boolean };
};

type FindUniqueArgs = {
  where: { id: string };
};

type DeleteArgs = {
  where: { id: string };
};

type AgentTransactionClient = {
  agent: {
    findUnique: (args: FindUniqueArgs) => Promise<Agent | null>;
    updateMany: (args: UpdateManyArgs) => Promise<{ count: number }>;
    update: (args: UpdateArgs) => Promise<Agent>;
    delete: (args: DeleteArgs) => Promise<Agent>;
  };
};

type TransactionCallback = (
  transactionClient: AgentTransactionClient,
) => Promise<Agent>;

type TransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel;
};

function buildAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-id',
    name: '测试智能体',
    description: '',
    avatar: null,
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
    createdAt: new Date('2026-08-14T00:00:00.000Z'),
    updatedAt: new Date('2026-08-14T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AgentService', () => {
  let service: AgentService;
  let findUnique: jest.Mock<Promise<Agent | null>, [unknown]>;
  let update: jest.Mock<Promise<Agent>, [UpdateArgs]>;
  let updateMany: jest.Mock<Promise<{ count: number }>, [UpdateManyArgs]>;
  let remove: jest.Mock<Promise<Agent>, [DeleteArgs]>;
  let transaction: jest.Mock<
    Promise<Agent>,
    [TransactionCallback, TransactionOptions]
  >;
  let invalidate: jest.Mock<void, []>;

  beforeEach(async () => {
    findUnique = jest.fn<Promise<Agent | null>, [unknown]>();
    update = jest.fn<Promise<Agent>, [UpdateArgs]>();
    updateMany = jest.fn<Promise<{ count: number }>, [UpdateManyArgs]>();
    remove = jest.fn<Promise<Agent>, [DeleteArgs]>();
    transaction = jest.fn<
      Promise<Agent>,
      [TransactionCallback, TransactionOptions]
    >((callback) =>
      callback({ agent: { findUnique, updateMany, update, delete: remove } }),
    );
    invalidate = jest.fn<void, []>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentService,
        {
          provide: PrismaService,
          useValue: {
            agent: { findUnique, update, delete: remove },
            $transaction: transaction,
          },
        },
        {
          provide: AgentDefinitionService,
          useValue: { invalidate },
        },
      ],
    }).compile();

    service = module.get(AgentService);
  });

  it('切换默认智能体时在事务内清除旧默认并设置目标后失效缓存', async () => {
    const target = buildAgent({ id: 'target-id' });
    findUnique.mockResolvedValue(target);
    updateMany.mockResolvedValue({ count: 1 });
    update.mockResolvedValue({ ...target, isDefault: true });

    const result = await service.setDefault(target.id);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: target.id } });
    expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(
      findUnique.mock.invocationCallOrder[0],
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { isDefault: true, id: { not: target.id } },
      data: { isDefault: false },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: target.id },
      data: { isDefault: true },
    });
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: target.id, isDefault: true });
  });

  it('遇到 P2034 后重试设置默认智能体且只失效一次缓存', async () => {
    const target = buildAgent({ id: 'target-id' });
    findUnique.mockResolvedValue(target);
    updateMany.mockResolvedValue({ count: 1 });
    update.mockResolvedValue({ ...target, isDefault: true });
    transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('serialization conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );

    await service.setDefault(target.id);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('拒绝将停用的智能体设为默认且不修改默认标记', async () => {
    findUnique.mockResolvedValue(buildAgent({ enabled: false }));

    await expect(service.setDefault('agent-id')).rejects.toThrow(
      new BadRequestException('停用的智能体不可设为默认'),
    );

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('拒绝停用当前默认智能体且不更新数据', async () => {
    findUnique.mockResolvedValue(buildAgent({ isDefault: true }));

    await expect(
      service.update('agent-id', { enabled: false }),
    ).rejects.toThrow(new BadRequestException('默认智能体不可停用'));

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(update).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('拒绝删除当前默认智能体且不删除数据', async () => {
    findUnique.mockResolvedValue(buildAgent({ isDefault: true }));

    await expect(service.remove('agent-id')).rejects.toThrow(
      new BadRequestException('默认智能体不可删除'),
    );

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
