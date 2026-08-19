import { Prisma } from '@prisma/client';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentFlowService } from './agent-flow.service';

type CreateArgs = { data: Record<string, unknown> };

type AgentFlowTransactionClient = {
  agentFlow: {
    create: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
    findUnique: jest.Mock<Promise<Record<string, unknown> | null>, [unknown]>;
    update: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
  };
  agentFlowVersion: {
    create: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
    findFirst: jest.Mock<Promise<Record<string, unknown> | null>, [unknown]>;
    findUnique: jest.Mock<Promise<Record<string, unknown> | null>, [unknown]>;
    updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    update: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
  };
  agentFlowAuditLog: {
    create: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
  };
};

type TransactionCallback = (
  transactionClient: AgentFlowTransactionClient,
) => Promise<unknown>;

const directDefinition: FlowDefinition = {
  schemaVersion: 1,
  kind: 'agent-flow',
  name: '直接回答',
  description: '不调用工具，直接生成回复',
  policy: {
    maxSteps: 1,
    maxModelCalls: 1,
    maxToolCalls: 0,
    maxDurationSeconds: 60,
  },
  nodes: [
    {
      id: 'answer',
      type: 'agent',
      config: {
        modelPreset: 'agent-default',
        toolGroups: [],
        skills: [],
        maxToolIterations: 1,
      },
    },
  ],
  edges: [],
};

describe('AgentFlowService', () => {
  let service: AgentFlowService;
  let createFlow: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
  let createVersion: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
  let findFlow: jest.Mock<Promise<Record<string, unknown> | null>, [unknown]>;
  let updateFlow: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
  let findLatestVersion: jest.Mock<
    Promise<Record<string, unknown> | null>,
    [unknown]
  >;
  let findVersion: jest.Mock<
    Promise<Record<string, unknown> | null>,
    [unknown]
  >;
  let updateVersions: jest.Mock<Promise<{ count: number }>, [unknown]>;
  let updateVersion: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
  let createAudit: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
  let transaction: jest.Mock<Promise<unknown>, [TransactionCallback, unknown]>;

  beforeEach(async () => {
    createFlow = jest.fn<Promise<Record<string, unknown>>, [CreateArgs]>();
    createVersion = jest.fn<Promise<Record<string, unknown>>, [CreateArgs]>();
    findFlow = jest.fn<Promise<Record<string, unknown> | null>, [unknown]>();
    updateFlow = jest.fn<Promise<Record<string, unknown>>, [CreateArgs]>();
    findLatestVersion = jest.fn<
      Promise<Record<string, unknown> | null>,
      [unknown]
    >();
    findVersion = jest.fn<Promise<Record<string, unknown> | null>, [unknown]>();
    updateVersions = jest.fn<Promise<{ count: number }>, [unknown]>();
    updateVersion = jest.fn<Promise<Record<string, unknown>>, [CreateArgs]>();
    createAudit = jest.fn<Promise<Record<string, unknown>>, [CreateArgs]>();
    transaction = jest.fn<Promise<unknown>, [TransactionCallback, unknown]>(
      (callback) =>
        callback({
          agentFlow: {
            create: createFlow,
            findUnique: findFlow,
            update: updateFlow,
          },
          agentFlowVersion: {
            create: createVersion,
            findFirst: findLatestVersion,
            findUnique: findVersion,
            updateMany: updateVersions,
            update: updateVersion,
          },
          agentFlowAuditLog: { create: createAudit },
        }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentFlowService,
        {
          provide: PrismaService,
          useValue: { $transaction: transaction },
        },
      ],
    }).compile();

    service = module.get(AgentFlowService);
  });

  it('创建时在同一可串行化事务内生成 version 1 草稿和审计记录', async () => {
    createFlow.mockResolvedValue({
      id: 'flow-1',
      name: directDefinition.name,
      description: directDefinition.description,
      publishedVersionId: null,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      updatedAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    createVersion.mockResolvedValue({
      id: 'version-1',
      flowId: 'flow-1',
      version: 1,
      status: 'DRAFT',
      definition: directDefinition,
      digest: null,
      schemaVersion: 1,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      updatedAt: new Date('2026-08-16T00:00:00.000Z'),
      publishedAt: null,
      archivedAt: null,
    });
    createAudit.mockResolvedValue({ id: 'audit-1' });

    const result = await service.create(directDefinition, 'admin-1');

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(createFlow).toHaveBeenCalledWith({
      data: {
        name: '直接回答',
        description: '不调用工具，直接生成回复',
        createdById: 'admin-1',
      },
    });
    expect(createVersion).toHaveBeenCalledWith({
      data: expect.objectContaining({
        flowId: 'flow-1',
        version: 1,
        status: 'DRAFT',
        definition: directDefinition,
        schemaVersion: 1,
        createdById: 'admin-1',
      }),
    });
    expect(createAudit).toHaveBeenCalledWith({
      data: {
        flowId: 'flow-1',
        versionId: 'version-1',
        action: 'CREATED',
        actorId: 'admin-1',
        digest: null,
      },
    });
    expect(result).toMatchObject({
      id: 'flow-1',
      draftVersion: { id: 'version-1', version: 1, status: 'DRAFT' },
    });
  });

  it('导入时创建递增的新草稿，不覆盖已有版本', async () => {
    findFlow.mockResolvedValue({ id: 'flow-1' });
    findLatestVersion.mockResolvedValue({ version: 2 });
    createVersion.mockResolvedValue({
      id: 'version-3',
      flowId: 'flow-1',
      version: 3,
      status: 'DRAFT',
      definition: directDefinition,
      digest: null,
      schemaVersion: 1,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      updatedAt: new Date('2026-08-16T00:00:00.000Z'),
      publishedAt: null,
      archivedAt: null,
    });
    updateFlow.mockResolvedValue({ id: 'flow-1' });
    createAudit.mockResolvedValue({ id: 'audit-1' });

    const result = await service.importDefinition(
      'flow-1',
      directDefinition,
      'admin-1',
    );

    expect(findLatestVersion).toHaveBeenCalledWith({
      where: { flowId: 'flow-1' },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    expect(createVersion).toHaveBeenCalledWith({
      data: {
        flowId: 'flow-1',
        version: 3,
        status: 'DRAFT',
        definition: directDefinition,
        digest: null,
        schemaVersion: 1,
        createdById: 'admin-1',
      },
    });
    expect(createAudit).toHaveBeenCalledWith({
      data: {
        flowId: 'flow-1',
        versionId: 'version-3',
        action: 'IMPORTED',
        actorId: 'admin-1',
        digest: null,
      },
    });
    expect(result).toMatchObject({
      id: 'version-3',
      version: 3,
      status: 'DRAFT',
    });
  });

  it('回滚时恢复历史版本并归档当前发布版本', async () => {
    findFlow.mockResolvedValue({
      id: 'flow-1',
      publishedVersionId: 'version-3',
    });
    findVersion.mockResolvedValue({
      id: 'version-1',
      flowId: 'flow-1',
      status: 'ARCHIVED',
      digest: 'historical-digest',
      definition: directDefinition,
      version: 1,
      schemaVersion: 1,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      updatedAt: new Date('2026-08-16T00:00:00.000Z'),
      publishedAt: new Date('2026-08-16T00:00:00.000Z'),
      archivedAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    updateVersions.mockResolvedValue({ count: 1 });
    updateVersion.mockResolvedValue({
      id: 'version-1',
      flowId: 'flow-1',
      status: 'PUBLISHED',
      digest: 'historical-digest',
      definition: directDefinition,
      version: 1,
      schemaVersion: 1,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      updatedAt: new Date('2026-08-16T00:00:00.000Z'),
      publishedAt: new Date('2026-08-16T00:00:00.000Z'),
      archivedAt: null,
    });
    updateFlow.mockResolvedValue({
      id: 'flow-1',
      publishedVersionId: 'version-1',
    });
    createAudit.mockResolvedValue({ id: 'audit-1' });

    await service.rollback('flow-1', 'version-1', 'admin-1');

    expect(updateVersions).toHaveBeenCalledWith({
      where: {
        flowId: 'flow-1',
        status: 'PUBLISHED',
        id: { not: 'version-1' },
      },
      data: {
        status: 'ARCHIVED',
        archivedAt: expect.any(Date),
      },
    });
    expect(updateVersion).toHaveBeenCalledWith({
      where: { id: 'version-1' },
      data: {
        status: 'PUBLISHED',
        publishedAt: expect.any(Date),
        archivedAt: null,
      },
    });
    expect(updateFlow).toHaveBeenCalledWith({
      where: { id: 'flow-1' },
      data: { publishedVersionId: 'version-1' },
    });
    expect(createAudit).toHaveBeenCalledWith({
      data: {
        flowId: 'flow-1',
        versionId: 'version-1',
        action: 'ROLLED_BACK',
        actorId: 'admin-1',
        digest: 'historical-digest',
      },
    });
  });
});
