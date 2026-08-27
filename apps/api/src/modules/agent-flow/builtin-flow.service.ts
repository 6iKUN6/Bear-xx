import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { AgentFlowVersionStatus, Prisma } from '@prisma/client';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { PrismaService } from '../../prisma/prisma.service';
import { calculateFlowDefinitionDigest } from './definition/flow-definition.validator';
import { createFlowDefinitionPreset } from './definition/flow-definition.templates';

/**
 * 内置直接回复 Flow 的固定标识
 * @description 固定而非 cuid：ensure 要幂等，且运维排查时能一眼认出这条记录是系统的。
 */
export const BUILTIN_DIRECT_FLOW_ID = 'builtin-direct-flow';

const BUILTIN_DIRECT_FLOW_NAME = '内置 · 直接回复';
const BUILTIN_DIRECT_FLOW_DESCRIPTION =
  '未绑定 Flow 的智能体默认执行它：直接生成回复，不调用工具。系统维护，不可编辑或删除。';

/** ensure 出来的已发布内置版本，供任务锁定时直接写进 StreamTask。 */
export interface BuiltinFlowVersionRef {
  id: string;
  digest: string;
}

/**
 * 供派发路径消费的内置版本
 * @description 字段与 `agent.defaultFlowVersion` 的投影**保持一致**：派发器对「绑定的 Flow」
 * 与「内置 Flow」走同一段校验，形状不同就得写两份。
 */
export interface BuiltinFlowVersionRecord {
  id: string;
  digest: string | null;
  status: AgentFlowVersionStatus;
  definition: Prisma.JsonValue;
}

/**
 * 内置 Flow 维护
 * @description 未绑定 Flow 的智能体需要一份可执行的 Definition。它**必须真实入库**：
 * `StreamTask.flowVersionId` 是外键，Activity 要读 `task.flowVersion.definition`，
 * 并比对 `task.flowDigest === task.flowVersion.digest`。
 *
 * 曾考虑「代码内置、不入库」，走不通：那需要外键可空 + 加判别字段 + **特例化 digest 校验**。
 * 最后一条是硬伤——digest 校验的意义正是保证「本次运行用的 Definition 与启动时完全一致」，
 * 而代码里的定义会随部署改变，跨版本部署就失去这个保证。入库后下游零改动。
 *
 * 内置定义将来要改，就发布一个**新版本**：在途任务仍指向旧版本（外键 Restrict 保护它），
 * 这正是版本机制该有的行为，不是需要绕开的麻烦。
 */
@Injectable()
export class BuiltinFlowService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BuiltinFlowService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 启动时确保内置 Flow 存在且为最新定义
   * @returns 无返回值
   * @description 失败只记日志不阻断启动：绑了自定义 Flow 的智能体与其余接口都不依赖它，
   * 让整个服务因为它起不来是过度反应。真正依赖它的请求会在 `findDirectVersion`
   * 拿不到记录时明确失败，而不是静默走进一条没有 Definition 的链路。
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureDirectFlow();
    } catch (error) {
      this.logger.error(
        `内置 Flow 初始化失败，未绑定 Flow 的智能体将无法执行：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 幂等地确保内置直接回复 Flow 已发布
   * @returns 返回当前已发布的内置版本引用
   * @description 比对代码中预设的 digest 与库中已发布版本：一致就不动，不一致则发布新版本
   * 并归档旧版本。用 digest 而不是逐字段比对，是因为它本来就是 Definition 的语义摘要
   * （已排除 layout 与字段顺序）。
   */
  async ensureDirectFlow(): Promise<BuiltinFlowVersionRef> {
    const definition = createFlowDefinitionPreset('direct');
    const digest = calculateFlowDefinitionDigest(definition);

    return this.prisma.$transaction(async (transaction) => {
      const flow = await transaction.agentFlow.upsert({
        where: { id: BUILTIN_DIRECT_FLOW_ID },
        create: {
          id: BUILTIN_DIRECT_FLOW_ID,
          name: BUILTIN_DIRECT_FLOW_NAME,
          description: BUILTIN_DIRECT_FLOW_DESCRIPTION,
        },
        update: {
          name: BUILTIN_DIRECT_FLOW_NAME,
          description: BUILTIN_DIRECT_FLOW_DESCRIPTION,
        },
        select: { id: true, publishedVersionId: true },
      });

      if (flow.publishedVersionId) {
        const current = await transaction.agentFlowVersion.findUnique({
          where: { id: flow.publishedVersionId },
          select: { id: true, digest: true },
        });
        if (current?.digest === digest) {
          return { id: current.id, digest };
        }
      }

      return this.publishNewVersion(transaction, definition, digest);
    });
  }

  /**
   * 读取当前已发布的内置版本
   * @param client 可选的事务客户端；任务创建路径要在同一事务里读
   * @returns 返回版本引用；内置 Flow 尚未初始化时返回 null
   * @description 不在这里兜底重建：任务创建路径上重建等于在用户请求里做一次写事务，
   * 且掩盖了「启动时初始化失败」这个真实问题。拿不到就让调用方明确失败。
   */
  async findDirectVersion(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<BuiltinFlowVersionRecord | null> {
    const flow = await client.agentFlow.findUnique({
      where: { id: BUILTIN_DIRECT_FLOW_ID },
      select: {
        publishedVersion: {
          select: {
            id: true,
            digest: true,
            status: true,
            definition: true,
          },
        },
      },
    });
    return flow?.publishedVersion ?? null;
  }

  /**
   * 发布一个新的内置版本
   * @param transaction 当前事务客户端
   * @param definition 代码中的内置定义
   * @param digest 该定义的语义摘要
   * @returns 返回新发布版本的引用
   * @description 归档旧发布版本而不是改写它：旧版本可能仍被在途任务的 flowVersionId 指着，
   * 改写会让那些任务的 digest 校验失败。版本号取当前最大值加一。
   */
  private async publishNewVersion(
    transaction: Prisma.TransactionClient,
    definition: FlowDefinition,
    digest: string,
  ): Promise<BuiltinFlowVersionRef> {
    const now = new Date();
    const latest = await transaction.agentFlowVersion.findFirst({
      where: { flowId: BUILTIN_DIRECT_FLOW_ID },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    await transaction.agentFlowVersion.updateMany({
      where: {
        flowId: BUILTIN_DIRECT_FLOW_ID,
        status: AgentFlowVersionStatus.PUBLISHED,
      },
      data: { status: AgentFlowVersionStatus.ARCHIVED, archivedAt: now },
    });
    const created = await transaction.agentFlowVersion.create({
      data: {
        flowId: BUILTIN_DIRECT_FLOW_ID,
        version: (latest?.version ?? 0) + 1,
        status: AgentFlowVersionStatus.PUBLISHED,
        // FlowDefinition 是只读结构，Prisma 的 InputJsonValue 要求可变；两者在运行时
        // 是同一份 JSON，经 unknown 收敛而不是逐字段复制一遍
        definition: definition as unknown as Prisma.InputJsonValue,
        digest,
        schemaVersion: definition.schemaVersion,
        publishedAt: now,
      },
      select: { id: true },
    });
    await transaction.agentFlow.update({
      where: { id: BUILTIN_DIRECT_FLOW_ID },
      data: { publishedVersionId: created.id },
    });
    // actorId 留空：这是系统动作，挂到某个管理员名下会让审计说谎
    await transaction.agentFlowAuditLog.create({
      data: {
        flowId: BUILTIN_DIRECT_FLOW_ID,
        versionId: created.id,
        action: 'PUBLISHED',
        digest,
      },
    });
    this.logger.log(`内置 Flow 已发布新版本：${created.id}`);
    return { id: created.id, digest };
  }
}
