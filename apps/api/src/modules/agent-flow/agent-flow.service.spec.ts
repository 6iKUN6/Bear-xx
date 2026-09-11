import { AGENT_FLOW_SCHEMA_VERSION } from '@litter-bear/types/agent-flow';
import { BUILTIN_DIRECT_FLOW_ID } from './builtin-flow.service';
import { Prisma } from '@prisma/client';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentFlowService } from './agent-flow.service';
import { FlowRuntimeValidator } from './runtime/flow-runtime-validator.service';
import { calculateFlowDefinitionDigest } from './definition/flow-definition.digest';

type CreateArgs = { data: Record<string, unknown> };

type AgentFlowTransactionClient = {
  agentFlow: {
    create: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
    findUnique: jest.Mock<Promise<Record<string, unknown> | null>, [unknown]>;
    update: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
    delete: jest.Mock<Promise<Record<string, unknown>>, [unknown]>;
  };
  agentFlowVersion: {
    create: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
    findFirst: jest.Mock<Promise<Record<string, unknown> | null>, [unknown]>;
    findUnique: jest.Mock<Promise<Record<string, unknown> | null>, [unknown]>;
    updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    update: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
    deleteMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
  };
  agentFlowAuditLog: {
    create: jest.Mock<Promise<Record<string, unknown>>, [CreateArgs]>;
  };
  streamTask: { count: jest.Mock<Promise<number>, [unknown]> };
  agent: {
    findMany: jest.Mock<Promise<Array<{ name: string }>>, [unknown]>;
  };
};

type TransactionCallback = (
  transactionClient: AgentFlowTransactionClient,
) => Promise<unknown>;

const directDefinition: FlowDefinition = {
  schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
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
    { id: 'start', type: 'start', config: {} },
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
    { id: 'end', type: 'end', config: {} },
  ],
  edges: [
    { from: 'start', to: 'answer' },
    { from: 'answer', to: 'end' },
  ],
};
const directDefinitionDigest = calculateFlowDefinitionDigest(directDefinition);

describe('AgentFlowService', () => {
  // 回滚要走与 publish 相同的发布期能力校验；默认放行，单独用例再让它失败
  const runtimeValidator = { validate: jest.fn() };

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
  let deleteFlow: jest.Mock<Promise<Record<string, unknown>>, [unknown]>;
  let deleteVersions: jest.Mock<Promise<{ count: number }>, [unknown]>;
  let countTasks: jest.Mock<Promise<number>, [unknown]>;
  let findBoundAgents: jest.Mock<Promise<Array<{ name: string }>>, [unknown]>;
  let listFlows: jest.Mock<Promise<Array<Record<string, unknown>>>, [unknown]>;
  let transaction: jest.Mock<Promise<unknown>, [TransactionCallback, unknown]>;

  beforeEach(async () => {
    runtimeValidator.validate.mockClear();
    runtimeValidator.validate.mockReturnValue({ valid: true, errors: [] });
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
    deleteFlow = jest.fn<Promise<Record<string, unknown>>, [unknown]>();
    deleteVersions = jest
      .fn<Promise<{ count: number }>, [unknown]>()
      .mockResolvedValue({ count: 1 });
    // 默认"干净"：没跑过任务、没被智能体绑定；单独用例再让它们非空
    countTasks = jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0);
    findBoundAgents = jest
      .fn<Promise<Array<{ name: string }>>, [unknown]>()
      .mockResolvedValue([]);
    listFlows = jest
      .fn<Promise<Array<Record<string, unknown>>>, [unknown]>()
      .mockResolvedValue([]);
    transaction = jest.fn<Promise<unknown>, [TransactionCallback, unknown]>(
      (callback) =>
        callback({
          agentFlow: {
            create: createFlow,
            findUnique: findFlow,
            update: updateFlow,
            delete: deleteFlow,
          },
          agentFlowVersion: {
            create: createVersion,
            findFirst: findLatestVersion,
            findUnique: findVersion,
            updateMany: updateVersions,
            update: updateVersion,
            deleteMany: deleteVersions,
          },
          agentFlowAuditLog: { create: createAudit },
          streamTask: { count: countTasks },
          agent: { findMany: findBoundAgents },
        }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentFlowService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: transaction,
            agentFlow: { findMany: listFlows },
          },
        },
        { provide: FlowRuntimeValidator, useValue: runtimeValidator },
      ],
    }).compile();

    service = module.get(AgentFlowService);
  });

  it('存量旧工件不再让整个 Flow 列表失败', async () => {
    // 回归用：读取路径原先要求工件仍然合法，一条 schemaVersion=1 的旧数据就让
    // GET /admin/agent-flows 整体返回 400，管理员连别的 Flow 都看不到、删不掉。
    listFlows.mockResolvedValue([
      {
        id: 'flow-legacy',
        name: 'Plan Execute',
        description: '',
        publishedVersionId: 'version-legacy',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        publishedVersion: {
          id: 'version-legacy',
          flowId: 'flow-legacy',
          version: 1,
          status: 'PUBLISHED',
          definition: { ...directDefinition, schemaVersion: 1 },
          digest: 'a'.repeat(64),
          schemaVersion: 1,
          createdById: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          publishedAt: new Date(0),
          archivedAt: null,
        },
      },
    ]);

    const flows = await service.list();

    expect(flows).toHaveLength(1);
    expect(flows[0].publishedVersion?.schemaStatus).toBe('unsupported');
    expect(flows[0].publishedVersion?.schemaErrors?.[0]?.path).toBe(
      'schemaVersion',
    );
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
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
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
        schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
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

  it('创建时允许保存拓扑未完成但结构安全的草稿', async () => {
    const incompleteDraft = { ...directDefinition, edges: [] };
    createFlow.mockResolvedValue({
      id: 'flow-incomplete',
      name: incompleteDraft.name,
      description: incompleteDraft.description,
      publishedVersionId: null,
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
      updatedAt: new Date('2026-09-11T00:00:00.000Z'),
    });
    createVersion.mockResolvedValue({
      id: 'version-incomplete',
      flowId: 'flow-incomplete',
      version: 1,
      status: 'DRAFT',
      definition: incompleteDraft,
      digest: null,
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
      updatedAt: new Date('2026-09-11T00:00:00.000Z'),
      publishedAt: null,
      archivedAt: null,
    });
    createAudit.mockResolvedValue({ id: 'audit-incomplete' });

    await expect(
      service.create(incompleteDraft, 'admin-1'),
    ).resolves.toMatchObject({
      id: 'flow-incomplete',
      draftVersion: { id: 'version-incomplete', status: 'DRAFT' },
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
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
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
        schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
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

  it('导入时允许保存拓扑未完成但结构安全的草稿', async () => {
    const incompleteDraft = { ...directDefinition, edges: [] };
    findFlow.mockResolvedValue({ id: 'flow-1' });
    findLatestVersion.mockResolvedValue({ version: 3 });
    createVersion.mockResolvedValue({
      id: 'version-4',
      flowId: 'flow-1',
      version: 4,
      status: 'DRAFT',
      definition: incompleteDraft,
      digest: null,
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
      updatedAt: new Date('2026-09-11T00:00:00.000Z'),
      publishedAt: null,
      archivedAt: null,
    });
    updateFlow.mockResolvedValue({ id: 'flow-1' });
    createAudit.mockResolvedValue({ id: 'audit-incomplete' });

    await expect(
      service.importDefinition('flow-1', incompleteDraft, 'admin-1'),
    ).resolves.toMatchObject({
      id: 'version-4',
      version: 4,
      status: 'DRAFT',
    });
  });

  it('更新基本信息时同步最新草稿，但不修改发布版本', async () => {
    const existingFlow = {
      id: 'flow-1',
      name: '旧名称',
      description: '旧描述',
      publishedVersionId: 'version-1',
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      updatedAt: new Date('2026-08-16T00:00:00.000Z'),
    };
    findFlow.mockResolvedValue(existingFlow);
    findLatestVersion.mockResolvedValue({
      id: 'version-2',
      definition: directDefinition,
    });
    updateFlow.mockResolvedValue({
      ...existingFlow,
      name: '新名称',
      description: '新描述',
      updatedAt: new Date('2026-08-17T00:00:00.000Z'),
    });
    updateVersion.mockResolvedValue({ id: 'version-2' });
    createAudit.mockResolvedValue({ id: 'audit-1' });

    const result = await service.updateMetadata(
      'flow-1',
      { name: '新名称', description: '新描述' },
      'admin-1',
    );

    expect(findLatestVersion).toHaveBeenCalledWith({
      where: { flowId: 'flow-1', status: 'DRAFT' },
      orderBy: { version: 'desc' },
      select: { id: true, definition: true },
    });
    expect(updateVersion).toHaveBeenCalledWith({
      where: { id: 'version-2' },
      data: {
        definition: {
          ...directDefinition,
          name: '新名称',
          description: '新描述',
        },
      },
    });
    expect(createAudit).toHaveBeenCalledWith({
      data: {
        flowId: 'flow-1',
        versionId: 'version-2',
        action: 'METADATA_UPDATED',
        actorId: 'admin-1',
        digest: null,
      },
    });
    expect(result).toMatchObject({ name: '新名称', description: '新描述' });
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
      digest: directDefinitionDigest,
      definition: directDefinition,
      version: 1,
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
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
      digest: directDefinitionDigest,
      definition: directDefinition,
      version: 1,
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
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
        digest: directDefinitionDigest,
      },
    });
  });

  it('回滚目标引用的能力已下线时拒绝回滚，不切换发布指针', async () => {
    findFlow.mockResolvedValue({
      id: 'flow-1',
      publishedVersionId: 'version-3',
    });
    findVersion.mockResolvedValue({
      id: 'version-1',
      flowId: 'flow-1',
      status: 'ARCHIVED',
      digest: directDefinitionDigest,
      definition: directDefinition,
      version: 1,
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      updatedAt: new Date('2026-08-16T00:00:00.000Z'),
      publishedAt: new Date('2026-08-16T00:00:00.000Z'),
      archivedAt: new Date('2026-08-16T00:00:00.000Z'),
    });
    // 历史版本发布时存在的工具组之后被下线
    runtimeValidator.validate.mockReturnValue({
      valid: false,
      errors: [
        {
          path: 'nodes.0.config.toolGroups.0',
          rule: 'tool-group-exists',
          message: '工具组「retired」不存在',
        },
      ],
    });

    await expect(
      service.rollback('flow-1', 'version-1', 'admin-1'),
    ).rejects.toThrow('回滚目标版本引用的能力已不可用');
    // 校验失败必须发生在任何写入之前，否则发布指针会指向一个跑不起来的版本
    expect(updateVersions).not.toHaveBeenCalled();
    expect(updateVersion).not.toHaveBeenCalled();
    expect(updateFlow).not.toHaveBeenCalled();
    expect(createAudit).not.toHaveBeenCalled();
  });

  it('回滚目标摘要与 Definition 不一致时拒绝切换发布指针', async () => {
    findFlow.mockResolvedValue({
      id: 'flow-1',
      publishedVersionId: 'version-3',
    });
    findVersion.mockResolvedValue({
      id: 'version-1',
      flowId: 'flow-1',
      status: 'ARCHIVED',
      digest: 'a'.repeat(64),
      definition: directDefinition,
    });

    await expect(
      service.rollback('flow-1', 'version-1', 'admin-1'),
    ).rejects.toThrow('摘要与 Definition 不一致');
    expect(runtimeValidator.validate).not.toHaveBeenCalled();
    expect(updateVersions).not.toHaveBeenCalled();
    expect(updateVersion).not.toHaveBeenCalled();
    expect(updateFlow).not.toHaveBeenCalled();
  });

  it('删除干净的 Flow 时先摘掉发布指针再删版本', async () => {
    findFlow.mockResolvedValue({
      id: 'flow-1',
      versions: [{ id: 'version-1' }, { id: 'version-2' }],
    });

    await service.remove('flow-1');

    // 顺序有意义：AgentFlow.publishedVersionId 指向版本，不先摘就会被外键挡住
    expect(updateFlow).toHaveBeenCalledWith({
      where: { id: 'flow-1' },
      data: { publishedVersionId: null },
    });
    expect(deleteVersions).toHaveBeenCalledWith({
      where: { flowId: 'flow-1' },
    });
    expect(deleteFlow).toHaveBeenCalledWith({ where: { id: 'flow-1' } });
  });

  it('跑过任务的 Flow 拒绝删除，且不发生任何写入', async () => {
    // 被任务锁定过的版本是审计链的一部分；数据库是 Restrict，这里要给出可读原因
    findFlow.mockResolvedValue({
      id: 'flow-1',
      versions: [{ id: 'version-1' }],
    });
    countTasks.mockResolvedValue(3);

    await expect(service.remove('flow-1')).rejects.toThrow(/3 个任务/);
    expect(updateFlow).not.toHaveBeenCalled();
    expect(deleteVersions).not.toHaveBeenCalled();
    expect(deleteFlow).not.toHaveBeenCalled();
  });

  it('仍被智能体绑定时拒绝删除，不静默解绑', async () => {
    // defaultFlowVersionId 是 SetNull：删掉会让那个 Agent 无声退回非 Flow 链路
    findFlow.mockResolvedValue({
      id: 'flow-1',
      versions: [{ id: 'version-1' }],
    });
    findBoundAgents.mockResolvedValue([{ name: '客服助手' }]);

    await expect(service.remove('flow-1')).rejects.toThrow(/客服助手/);
    expect(deleteFlow).not.toHaveBeenCalled();
  });

  it('Flow 不存在时抛 NotFound', async () => {
    findFlow.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toThrow('Flow 不存在');
  });

  it('拒绝编辑或删除内置 Flow', async () => {
    // 内置 Flow 由代码定义、启动时 ensure，且所有未绑定 Flow 的 Agent 都在跑它。
    // 允许改删就是允许一次误操作打掉全站默认回复链路，而下次启动 ensure 又会覆盖回去——
    // 那种"改了但过一会儿又变回来"比直接拒绝更难排查。
    await expect(service.remove(BUILTIN_DIRECT_FLOW_ID)).rejects.toThrow(
      '内置 Flow 由系统维护',
    );
    await expect(
      service.importDefinition(BUILTIN_DIRECT_FLOW_ID, {}, 'admin-1'),
    ).rejects.toThrow('内置 Flow 由系统维护');
    await expect(
      service.rollback(BUILTIN_DIRECT_FLOW_ID, 'version-1', 'admin-1'),
    ).rejects.toThrow('内置 Flow 由系统维护');
    await expect(
      service.updateMetadata(
        BUILTIN_DIRECT_FLOW_ID,
        { name: '不能改' },
        'admin-1',
      ),
    ).rejects.toThrow('内置 Flow 由系统维护');
    // 守卫在事务之前，因此一次数据库都不该碰
    expect(transaction).not.toHaveBeenCalled();
  });
});
