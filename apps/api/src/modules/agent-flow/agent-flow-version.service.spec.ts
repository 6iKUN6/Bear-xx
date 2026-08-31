import { AGENT_FLOW_SCHEMA_VERSION } from '@litter-bear/types/agent-flow';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, type TestingModule } from '@nestjs/testing';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentFlowVersionService } from './agent-flow-version.service';
import { calculateFlowDefinitionDigest } from './definition/flow-definition.validator';
import { FlowRuntimeValidator } from './runtime/flow-runtime-validator.service';

const directDefinition: FlowDefinition = {
  schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
  kind: 'agent-flow',
  name: '直接回答',
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

describe('AgentFlowVersionService', () => {
  let service: AgentFlowVersionService;
  let findUnique: jest.Mock<Promise<Record<string, unknown> | null>, [unknown]>;
  let update: jest.Mock<Promise<Record<string, unknown>>, [unknown]>;
  let updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
  let findFlow: jest.Mock<Promise<Record<string, unknown> | null>, [unknown]>;
  let updateFlow: jest.Mock<Promise<Record<string, unknown>>, [unknown]>;
  let createAudit: jest.Mock<Promise<Record<string, unknown>>, [unknown]>;
  let runtimeValidate: jest.Mock;
  let transaction: jest.Mock<
    Promise<unknown>,
    [(client: Record<string, unknown>) => Promise<unknown>, unknown]
  >;

  beforeEach(async () => {
    findUnique = jest.fn<Promise<Record<string, unknown> | null>, [unknown]>();
    update = jest.fn<Promise<Record<string, unknown>>, [unknown]>();
    updateMany = jest.fn<Promise<{ count: number }>, [unknown]>();
    findFlow = jest.fn<Promise<Record<string, unknown> | null>, [unknown]>();
    updateFlow = jest.fn<Promise<Record<string, unknown>>, [unknown]>();
    createAudit = jest.fn<Promise<Record<string, unknown>>, [unknown]>();
    runtimeValidate = jest.fn().mockReturnValue({ valid: true, errors: [] });
    transaction = jest.fn<
      Promise<unknown>,
      [(client: Record<string, unknown>) => Promise<unknown>, unknown]
    >((callback: (client: Record<string, unknown>) => Promise<unknown>) =>
      callback({
        agentFlowVersion: { findUnique, update, updateMany },
        agentFlow: { findUnique: findFlow, update: updateFlow },
        agentFlowAuditLog: { create: createAudit },
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentFlowVersionService,
        {
          provide: FlowRuntimeValidator,
          useValue: {
            validate: runtimeValidate,
          },
        },
        {
          provide: PrismaService,
          useValue: {
            agentFlowVersion: { findUnique, update },
            $transaction: transaction,
          },
        },
      ],
    }).compile();

    service = module.get(AgentFlowVersionService);
  });

  it('拒绝覆盖已发布版本的 Definition', async () => {
    findUnique.mockResolvedValue({
      id: 'version-1',
      status: 'PUBLISHED',
    });

    await expect(
      service.updateDraft('version-1', directDefinition, 'admin-1'),
    ).rejects.toThrow(new BadRequestException('已发布或归档版本不可编辑'));

    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'version-1' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('在事务内覆盖草稿、同步 Flow 摘要并写审计', async () => {
    const currentVersion = {
      id: 'version-1',
      flowId: 'flow-1',
      status: 'DRAFT',
      version: 1,
      digest: null,
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      updatedAt: new Date('2026-08-16T00:00:00.000Z'),
      publishedAt: null,
      archivedAt: null,
    };
    findUnique.mockResolvedValue(currentVersion);
    update.mockResolvedValue({
      ...currentVersion,
      definition: directDefinition,
    });
    updateFlow.mockResolvedValue({ id: 'flow-1' });
    createAudit.mockResolvedValue({ id: 'audit-1' });

    await service.updateDraft('version-1', directDefinition, 'admin-1');

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'version-1' },
      data: {
        definition: directDefinition,
        schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
        digest: null,
      },
    });
    expect(updateFlow).toHaveBeenCalledWith({
      where: { id: 'flow-1' },
      data: {
        name: '直接回答',
        description: '',
      },
    });
    expect(createAudit).toHaveBeenCalledWith({
      data: {
        flowId: 'flow-1',
        versionId: 'version-1',
        action: 'DRAFT_UPDATED',
        actorId: 'admin-1',
        digest: null,
      },
    });
  });

  it('发布草稿时归档旧发布版本、锁定 digest 并切换当前发布版本', async () => {
    const draftVersion = {
      id: 'version-2',
      flowId: 'flow-1',
      status: 'DRAFT',
      definition: directDefinition,
      version: 2,
      digest: null,
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      updatedAt: new Date('2026-08-16T00:00:00.000Z'),
      publishedAt: null,
      archivedAt: null,
    };
    findUnique.mockResolvedValue(draftVersion);
    findFlow.mockResolvedValue({
      id: 'flow-1',
      publishedVersionId: 'version-1',
    });
    updateMany.mockResolvedValue({ count: 1 });
    update.mockResolvedValue({ ...draftVersion, status: 'PUBLISHED' });
    updateFlow.mockResolvedValue({
      id: 'flow-1',
      publishedVersionId: 'version-2',
    });
    createAudit.mockResolvedValue({ id: 'audit-1' });

    await service.publish('version-2', 'admin-1');

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        flowId: 'flow-1',
        status: 'PUBLISHED',
        id: { not: 'version-2' },
      },
      data: {
        status: 'ARCHIVED',
        archivedAt: expect.any(Date),
      },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'version-2' },
      data: {
        status: 'PUBLISHED',
        digest: calculateFlowDefinitionDigest(directDefinition),
        publishedAt: expect.any(Date),
        archivedAt: null,
      },
    });
    expect(updateFlow).toHaveBeenCalledWith({
      where: { id: 'flow-1' },
      data: { publishedVersionId: 'version-2' },
    });
    expect(createAudit).toHaveBeenCalledWith({
      data: {
        flowId: 'flow-1',
        versionId: 'version-2',
        action: 'PUBLISHED',
        actorId: 'admin-1',
        digest: calculateFlowDefinitionDigest(directDefinition),
      },
    });
  });

  it('发布时拒绝未通过能力闭集校验的草稿', async () => {
    findUnique.mockResolvedValue({
      id: 'version-2',
      flowId: 'flow-1',
      status: 'DRAFT',
      definition: directDefinition,
    });
    runtimeValidate.mockReturnValue({
      valid: false,
      errors: [
        {
          path: 'nodes.0.config.toolGroups.0',
          rule: 'tool-group-exists',
          message: '工具组不存在',
        },
      ],
    });

    await expect(service.publish('version-2', 'admin-1')).rejects.toThrow(
      new BadRequestException({
        message: 'Flow 运行时校验失败',
        errors: [
          {
            path: 'nodes.0.config.toolGroups.0',
            rule: 'tool-group-exists',
            message: '工具组不存在',
          },
        ],
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('导出时只返回 FlowDefinition JSON', async () => {
    findUnique.mockResolvedValue({
      id: 'version-1',
      flowId: 'flow-1',
      status: 'PUBLISHED',
      definition: directDefinition,
      digest: 'digest',
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    });

    const exported = await service.exportDefinition('version-1');

    expect(exported).toEqual(directDefinition);
    expect(exported).not.toHaveProperty('id');
    expect(exported).not.toHaveProperty('digest');
  });

  it('校验存量非法 Definition 时返回字段错误而不写数据库', async () => {
    findUnique.mockResolvedValue({
      id: 'version-1',
      definition: {
        schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
        kind: 'agent-flow',
        name: '无效 Flow',
      },
    });

    const result = await service.validate('version-1');

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'policy', rule: 'schema' }),
      ]),
    );
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
