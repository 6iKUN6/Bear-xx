import { AgentFlowVersionStatus } from '@prisma/client';
import {
  BUILTIN_DIRECT_FLOW_ID,
  BuiltinFlowService,
} from './builtin-flow.service';
import { createFlowDefinitionPreset } from './definition/flow-definition.templates';
import { calculateFlowDefinitionDigest } from './definition/flow-definition.validator';

/**
 * 内置 Flow 的 ensure 语义
 * @description 重点不在「能建出来」，而在**幂等**与**升版时不改写旧版本**：旧版本可能仍被
 * 在途任务的 flowVersionId 指着，改写它会让那些任务的 digest 一致性校验失败。
 */
describe('BuiltinFlowService', () => {
  const currentDigest = calculateFlowDefinitionDigest(
    createFlowDefinitionPreset('direct'),
  );

  /**
   * 构造只含本用例所需方法的 Prisma 替身
   * @param publishedVersionId Flow 已有的发布版本标识；null 表示 Flow 是新建的
   * @param publishedDigest 该发布版本的摘要
   * @returns 返回服务实例与替身表
   */
  function createService(
    publishedVersionId: string | null,
    publishedDigest?: string,
  ) {
    const agentFlow = {
      upsert: jest.fn().mockResolvedValue({
        id: BUILTIN_DIRECT_FLOW_ID,
        publishedVersionId,
      }),
      update: jest.fn(),
      findUnique: jest.fn(),
    };
    const agentFlowVersion = {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          publishedVersionId
            ? { id: publishedVersionId, digest: publishedDigest }
            : null,
        ),
      findFirst: jest.fn().mockResolvedValue({ version: 3 }),
      updateMany: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'new-version' }),
    };
    const agentFlowAuditLog = { create: jest.fn() };
    const transaction = { agentFlow, agentFlowVersion, agentFlowAuditLog };
    const prisma = {
      ...transaction,
      $transaction: jest.fn((run: (tx: unknown) => unknown): unknown =>
        run(transaction),
      ),
    };
    return {
      service: new BuiltinFlowService(prisma as never),
      agentFlow,
      agentFlowVersion,
      agentFlowAuditLog,
    };
  }

  it('已发布版本与代码定义一致时不写任何新版本', async () => {
    const { service, agentFlowVersion } = createService(
      'version-3',
      currentDigest,
    );

    const result = await service.ensureDirectFlow();

    expect(result).toEqual({ id: 'version-3', digest: currentDigest });
    expect(agentFlowVersion.create).not.toHaveBeenCalled();
    expect(agentFlowVersion.updateMany).not.toHaveBeenCalled();
  });

  it('首次启动时发布第一个版本', async () => {
    const { service, agentFlowVersion, agentFlow } = createService(null);
    agentFlowVersion.findFirst.mockResolvedValue(null);

    const result = await service.ensureDirectFlow();

    expect(result).toEqual({ id: 'new-version', digest: currentDigest });
    expect(agentFlowVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          flowId: BUILTIN_DIRECT_FLOW_ID,
          version: 1,
          status: AgentFlowVersionStatus.PUBLISHED,
          digest: currentDigest,
        }),
      }),
    );
    expect(agentFlow.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { publishedVersionId: 'new-version' } }),
    );
  });

  it('代码定义变化时发新版本并归档旧版本，而不是改写它', async () => {
    // 改写旧版本会让仍指着它的在途任务 digest 校验失败
    const { service, agentFlowVersion } = createService(
      'version-3',
      'stale'.padEnd(64, '0'),
    );

    await service.ensureDirectFlow();

    expect(agentFlowVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AgentFlowVersionStatus.ARCHIVED,
        }),
      }),
    );
    expect(agentFlowVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 4, digest: currentDigest }),
      }),
    );
  });

  it('审计记录不挂到任何用户名下', async () => {
    // 这是系统动作；挂到某个管理员名下会让审计说谎
    const { service, agentFlowAuditLog } = createService(null);

    await service.ensureDirectFlow();

    const [call] = agentFlowAuditLog.create.mock.calls as Array<
      [{ data: Record<string, unknown> }]
    >;
    expect(call[0].data.actorId).toBeUndefined();
  });

  it('启动失败只记日志，不阻断应用启动', async () => {
    // 绑了自定义 Flow 的 Agent 与其余接口都不依赖内置 Flow
    const { service, agentFlow } = createService(null);
    agentFlow.upsert.mockRejectedValue(new Error('数据库不可用'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
