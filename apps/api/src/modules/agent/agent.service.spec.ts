import { BadRequestException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Agent, MembershipTier, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentDefinitionService } from './agent-definition.service';
import { createFlowDefinitionPreset } from '../agent-flow/definition/flow-definition.templates';
import { collectFlowToolGroups } from '../agent-flow/definition/flow-tool-groups';
import { AgentService } from './agent.service';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AgentAccessService } from '../agent-access/agent-access.service';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';

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
  agentFlowVersion: {
    findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
  };
  modelPreset: {
    findMany: (args: unknown) => Promise<ModelPresetRow[]>;
  };
};

interface ModelPresetRow {
  id: string;
  presetId: string;
  name: string;
  model: string;
  enabled: boolean;
  connection: { providerKey: string; enabled: boolean };
}

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
    enabled: true,
    visible: true,
    minimumMembershipTier: MembershipTier.FREE,
    isDefault: false,
    defaultFlowVersionId: null,
    defaultModelPresetId: 'model-row-id',
    defaultReasoningConfig: null,
    createdById: null,
    createdAt: new Date('2026-08-14T00:00:00.000Z'),
    updatedAt: new Date('2026-08-14T00:00:00.000Z'),
    ...overrides,
  };
}

function buildAgentWithExecution(overrides: Partial<Agent> = {}) {
  return {
    ...buildAgent(overrides),
    defaultFlowVersion: null,
    defaultModelPreset: { presetId: 'model-enabled' },
    allowedModelPresets: [
      {
        modelPreset: {
          id: 'model-row-id',
          presetId: 'model-enabled',
          name: '测试模型',
          model: 'test-model',
          enabled: true,
          connection: { providerKey: 'test', enabled: true },
        },
      },
    ],
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
  let findFlowVersion: jest.Mock<
    Promise<Record<string, unknown> | null>,
    [unknown]
  >;
  let findModelPresets: jest.Mock<Promise<ModelPresetRow[]>, [unknown]>;

  beforeEach(async () => {
    findUnique = jest.fn<Promise<Agent | null>, [unknown]>();
    update = jest.fn<Promise<Agent>, [UpdateArgs]>();
    updateMany = jest.fn<Promise<{ count: number }>, [UpdateManyArgs]>();
    remove = jest.fn<Promise<Agent>, [DeleteArgs]>();
    invalidate = jest.fn<void, []>();
    findFlowVersion = jest.fn<
      Promise<Record<string, unknown> | null>,
      [unknown]
    >();
    findModelPresets = jest
      .fn<Promise<ModelPresetRow[]>, [unknown]>()
      .mockResolvedValue([
        {
          id: 'model-row-id',
          presetId: 'model-enabled',
          name: '测试模型',
          model: 'test-model',
          enabled: true,
          connection: { providerKey: 'test', enabled: true },
        },
      ]);
    transaction = jest.fn<
      Promise<Agent>,
      [TransactionCallback, TransactionOptions]
    >((callback) =>
      callback({
        agent: { findUnique, updateMany, update, delete: remove },
        agentFlowVersion: { findUnique: findFlowVersion },
        modelPreset: { findMany: findModelPresets },
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentService,
        {
          provide: PrismaService,
          useValue: {
            agent: { findUnique, update, delete: remove },
            agentFlowVersion: { findUnique: findFlowVersion },
            modelPreset: { findMany: findModelPresets },
            $transaction: transaction,
          },
        },
        {
          provide: AgentDefinitionService,
          useValue: { invalidate },
        },
        AgentAccessService,
        {
          provide: LlmModelRegistryService,
          useValue: {
            getReasoningCapability: jest.fn(() => undefined),
            normalizePresetReasoning: jest.fn(
              (_presetId: string, selection: unknown) => selection,
            ),
          },
        },
      ],
    }).compile();

    service = module.get(AgentService);
  });

  it('工具标签从绑定 Flow 的图上推导', async () => {
    // Agent.toolGroups 那一列已随方案 A 删除，工具只在 Flow 节点上声明
    findUnique.mockResolvedValue({
      ...buildAgentWithExecution(),
      defaultFlowVersion: { definition: createFlowDefinitionPreset('react') },
    } as never);

    const result = await service.get('agent-id');

    expect(result.toolGroups).toEqual(['default']);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'agent-id' },
      include: expect.objectContaining({
        defaultFlowVersion: { select: { definition: true } },
      }),
    });
  });

  it('未绑定 Flow 时按内置 direct 形态推导', async () => {
    // ⚠️ 这条区分不了「从预设推导」与「写死空数组」：direct 预设的工具组恒为空，两种
    // 实现当前行为完全等价。断言写成调用 collectFlowToolGroups 是为了让期望值跟着预设
    // 走——内置形态哪天带上工具，这条会自动开始有区分力，而不需要有人记得回来改。
    findUnique.mockResolvedValue({
      ...buildAgentWithExecution(),
    });

    const result = await service.get('agent-id');

    expect(result.toolGroups).toEqual(
      collectFlowToolGroups(createFlowDefinitionPreset('direct')),
    );
  });

  it('绑定版本的 Definition 损坏时标签为空，不让列表整个报错', async () => {
    findUnique.mockResolvedValue({
      ...buildAgentWithExecution(),
      defaultFlowVersion: { definition: { nonsense: true } },
    } as never);

    await expect(service.get('agent-id')).resolves.toMatchObject({
      toolGroups: [],
    });
  });

  it('切换默认智能体时在事务内清除旧默认并设置目标后失效缓存', async () => {
    const target = buildAgentWithExecution({ id: 'target-id' });
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
      // 必须带上 include：响应里的 toolGroups 从绑定 Flow 的 Definition 推导，
      // 漏了不会报错，只会静默返回空标签
      include: expect.objectContaining({
        defaultFlowVersion: { select: { definition: true } },
      }),
    });
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: target.id, isDefault: true });
  });

  it('遇到 P2034 后重试设置默认智能体且只失效一次缓存', async () => {
    const target = buildAgentWithExecution({ id: 'target-id' });
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
    findUnique.mockResolvedValue(buildAgentWithExecution({ enabled: false }));

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

  it.each([
    [{ visible: false }, '隐藏的智能体不可设为默认'],
    [
      { minimumMembershipTier: MembershipTier.PLUS },
      '默认智能体最低会员等级必须为 FREE',
    ],
  ] satisfies Array<[Partial<Agent>, string]>)(
    '拒绝不满足默认开放约束的智能体：%s',
    async (overrides, message) => {
      findUnique.mockResolvedValue(buildAgentWithExecution(overrides));

      await expect(service.setDefault('agent-id')).rejects.toThrow(
        new BadRequestException(message),
      );

      expect(updateMany).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it('拒绝停用当前默认智能体且不更新数据', async () => {
    findUnique.mockResolvedValue(buildAgentWithExecution({ isDefault: true }));

    await expect(
      service.update('agent-id', { enabled: false }),
    ).rejects.toThrow(new BadRequestException('默认智能体必须启用且展示'));

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(update).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('拒绝删除当前默认智能体且不删除数据', async () => {
    findUnique.mockResolvedValue(buildAgentWithExecution({ isDefault: true }));

    await expect(service.remove('agent-id')).rejects.toThrow(
      new BadRequestException('默认智能体不可删除'),
    );

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('拒绝将未发布 FlowVersion 绑定为智能体默认执行形态', async () => {
    const dto = Object.assign(new UpdateAgentDto(), {
      defaultFlowVersionId: 'draft-flow-version',
    });
    findFlowVersion.mockResolvedValue({
      id: 'draft-flow-version',
      status: 'DRAFT',
    });
    findUnique.mockResolvedValue(buildAgentWithExecution());
    update.mockResolvedValue(buildAgentWithExecution());

    await expect(service.update('agent-id', dto)).rejects.toThrow(
      new BadRequestException('只能绑定已发布的 Flow 版本'),
    );

    expect(findFlowVersion).toHaveBeenCalledWith({
      where: { id: 'draft-flow-version' },
      select: { status: true, definition: true },
    });
    expect(update).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('切换到自定义 Flow 时允许显式清空默认模型和思考设置', async () => {
    findUnique.mockResolvedValue(
      buildAgentWithExecution({
        defaultReasoningConfig: {
          version: 1,
          selection: { activation: 'enabled' },
        },
      }),
    );
    findFlowVersion.mockResolvedValue({
      status: 'PUBLISHED',
      definition: createFlowDefinitionPreset('blank'),
    });
    update.mockResolvedValue({
      ...buildAgentWithExecution({ defaultFlowVersionId: 'flow-version' }),
      defaultFlowVersion: {
        definition: createFlowDefinitionPreset('blank'),
      },
      defaultModelPreset: null,
      allowedModelPresets: [],
    } as never);

    await service.update('agent-id', {
      defaultFlowVersionId: 'flow-version',
      allowedModelPresetIds: [],
      defaultModelPresetId: null,
      defaultReasoning: null,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          defaultModelPreset: { disconnect: true },
          defaultReasoningConfig: Prisma.JsonNull,
        }),
      }),
    );
  });
});
