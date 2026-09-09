#!/usr/bin/env node

const path = require('node:path');
const { existsSync } = require('node:fs');

const BUILTIN_DIRECT_FLOW_ID = 'builtin-direct-flow';
const ERROR_SUMMARY_LIMIT = 3;

/**
 * 解析命令行参数
 * @param {string[]} args 不含 node 与脚本路径的参数
 * @returns {{ delete: boolean, format: 'human' | 'json' }} 返回清理开关与输出格式
 * @description 默认只读且输出人类可读报告；任何未知参数都会明确拒绝，避免拼写错误意外改变操作意图。
 */
function parseArguments(args) {
  const supported = new Set(['--delete', '--format=json']);
  const unsupported = args.filter((argument) => !supported.has(argument));
  if (unsupported.length > 0) {
    throw new Error(`不支持的参数：${unsupported.join(', ')}`);
  }
  return {
    delete: args.includes('--delete'),
    format: args.includes('--format=json') ? 'json' : 'human',
  };
}

/**
 * 按需加载 API 本地环境文件
 * @param {string} environmentFile `.env` 文件绝对路径
 * @returns {void} 无返回值
 * @description 使用 Node 24 内置加载器，避免运维脚本依赖未直接安装的 dotenv；文件不存在时沿用容器注入的环境变量。
 */
function loadEnvironment(environmentFile) {
  if (existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }
}

/**
 * 判断 Prisma JSON 是否具有 Flow Definition 可接受的根形状
 * @param {unknown} definition 数据库中的 Definition JSON
 * @returns {boolean} 返回是否为普通 JSON 对象
 * @description Prisma 已完成 JSON 反序列化；这里区分对象根与 null、数组、标量等明显损坏形态。
 */
function hasDefinitionObjectShape(definition) {
  return (
    typeof definition === 'object' &&
    definition !== null &&
    !Array.isArray(definition)
  );
}

/**
 * 把校验错误压缩成可展示摘要
 * @param {{ path: string, rule: string, message: string }[]} errors 完整校验错误
 * @returns {string} 返回最多三条错误及剩余数量
 * @description 报告不输出完整 Definition，只保留定位清理对象所需的字段路径、规则和错误信息。
 */
function summarizeErrors(errors) {
  if (errors.length === 0) return '';
  const summary = errors
    .slice(0, ERROR_SUMMARY_LIMIT)
    .map((error) => `${error.path} [${error.rule}] ${error.message}`)
    .join('；');
  const remaining = errors.length - ERROR_SUMMARY_LIMIT;
  return remaining > 0 ? `${summary}；另有 ${remaining} 条` : summary;
}

/**
 * 计算版本不可删除的原因
 * @param {object} version 版本盘点结果
 * @param {string} version.flowId 所属 Flow ID
 * @param {string} version.status 版本状态
 * @param {boolean} version.schemaCompatible 是否通过当前契约校验
 * @param {boolean} version.isCurrentPublished 是否为当前发布指针
 * @param {number} version.taskReferenceCount 任务引用数
 * @param {number} version.agentBindingCount Agent 绑定数
 * @returns {string[]} 返回阻止删除的原因；空数组表示可删除
 * @description 删除资格是保护条件的交集，审计日志数量不作为阻断条件，因为删除版本时外键会置空保留日志。
 */
function deletionBlockers(version) {
  const blockers = [];
  if (version.flowId === BUILTIN_DIRECT_FLOW_ID) blockers.push('builtin-flow');
  if (version.status !== 'DRAFT') blockers.push('not-draft');
  if (version.schemaCompatible) blockers.push('schema-compatible');
  if (version.isCurrentPublished) blockers.push('current-published');
  if (version.taskReferenceCount > 0) blockers.push('task-referenced');
  if (version.agentBindingCount > 0) blockers.push('agent-bound');
  return blockers;
}

/**
 * 把 Prisma 查询行转换为版本盘点结果
 * @param {object} flow 所属逻辑 Flow
 * @param {string} flow.id Flow ID
 * @param {string} flow.name Flow 名称
 * @param {string | null} flow.publishedVersionId 当前发布版本 ID
 * @param {object} version FlowVersion 查询行
 * @param {(input: unknown) => object} validateDefinition 当前 Flow Definition 校验函数
 * @returns {object} 返回可序列化的版本报告
 * @description 校验只使用当前契约，不访问模型、工具和技能注册表；报告中的删除资格由统一保护规则派生。
 */
function inspectVersion(flow, version, validateDefinition) {
  const validation = validateDefinition(version.definition);
  const schemaErrors = validation.success ? [] : validation.errors;
  const report = {
    flowId: flow.id,
    flowName: flow.name,
    versionId: version.id,
    version: version.version,
    status: version.status,
    schemaVersion: version.schemaVersion,
    definitionObjectShape: hasDefinitionObjectShape(version.definition),
    schemaCompatible: validation.success,
    schemaErrors,
    errorSummary: summarizeErrors(schemaErrors),
    isCurrentPublished: flow.publishedVersionId === version.id,
    taskReferenceCount: version._count.taskSnapshots,
    agentBindingCount: version._count.defaultForAgents,
    auditLogCount: version._count.auditLogs,
  };
  const blockers = deletionBlockers(report);
  return {
    ...report,
    deletionCandidate: blockers.length === 0,
    deletionBlockers: blockers,
  };
}

/**
 * 查询并校验全部 AgentFlow 版本
 * @param {object} prisma PrismaClient 或事务客户端
 * @param {(input: unknown) => object} validateDefinition 当前 Flow Definition 校验函数
 * @returns {Promise<object>} 返回汇总统计、Flow 数量和逐版本报告
 * @description 一次读取版本引用计数并在进程内执行当前契约校验；此方法不包含任何数据库写操作。
 */
async function auditFlowVersions(prisma, validateDefinition) {
  const flows = await prisma.agentFlow.findMany({
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      publishedVersionId: true,
      versions: {
        orderBy: { version: 'asc' },
        select: {
          id: true,
          flowId: true,
          version: true,
          status: true,
          definition: true,
          schemaVersion: true,
          _count: {
            select: {
              taskSnapshots: true,
              defaultForAgents: true,
              auditLogs: true,
            },
          },
        },
      },
    },
  });
  const versions = flows.flatMap((flow) =>
    flow.versions.map((version) =>
      inspectVersion(flow, version, validateDefinition),
    ),
  );
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      flowCount: flows.length,
      versionCount: versions.length,
      compatibleCount: versions.filter((version) => version.schemaCompatible)
        .length,
      incompatibleCount: versions.filter((version) => !version.schemaCompatible)
        .length,
      deletionCandidateCount: versions.filter(
        (version) => version.deletionCandidate,
      ).length,
    },
    versions,
  };
}

/**
 * 删除初次报告中列出的安全候选
 * @param {object} prisma PrismaClient
 * @param {object[]} initialCandidates 初次只读盘点得到的候选版本
 * @param {(input: unknown) => object} validateDefinition 当前 Flow Definition 校验函数
 * @returns {Promise<{ deletedVersionIds: string[], deletedFlowIds: string[], skippedVersionIds: string[] }>} 返回实际删除和跳过的 ID
 * @description 在 Serializable 事务中重新查询和校验；只删除初次报告已列出的候选，期间新增的候选不会被顺带清理。
 */
async function deleteAuditCandidates(
  prisma,
  initialCandidates,
  validateDefinition,
) {
  const candidateIds = new Set(
    initialCandidates.map((candidate) => candidate.versionId),
  );
  const flowIds = [
    ...new Set(initialCandidates.map((candidate) => candidate.flowId)),
  ];
  if (candidateIds.size === 0) {
    return {
      deletedVersionIds: [],
      deletedFlowIds: [],
      skippedVersionIds: [],
    };
  }

  return prisma.$transaction(
    async (transaction) => {
      const freshAudit = await auditSelectedFlows(
        transaction,
        flowIds,
        validateDefinition,
      );
      const freshById = new Map(
        freshAudit.versions.map((version) => [version.versionId, version]),
      );
      const eligibleIds = [...candidateIds].filter(
        (versionId) => freshById.get(versionId)?.deletionCandidate === true,
      );
      const skippedVersionIds = [...candidateIds].filter(
        (versionId) => !eligibleIds.includes(versionId),
      );

      const protectedFlowIds = new Set();
      for (const flowId of flowIds) {
        const versionIds = freshAudit.versions
          .filter((version) => version.flowId === flowId)
          .map((version) => version.versionId);
        if (versionIds.length === 0) continue;
        const [taskReferenceCount, agentBindingCount] = await Promise.all([
          transaction.streamTask.count({
            where: { flowVersionId: { in: versionIds } },
          }),
          transaction.agent.count({
            where: { defaultFlowVersionId: { in: versionIds } },
          }),
        ]);
        if (taskReferenceCount > 0 || agentBindingCount > 0) {
          protectedFlowIds.add(flowId);
        }
      }

      const deleted = await transaction.agentFlowVersion.deleteMany({
        where: { id: { in: eligibleIds }, status: 'DRAFT' },
      });
      if (deleted.count !== eligibleIds.length) {
        throw new Error(
          `删除数量发生变化：预计 ${eligibleIds.length} 条，实际 ${deleted.count} 条`,
        );
      }

      const deletedFlowIds = [];
      for (const flowId of flowIds) {
        if (flowId === BUILTIN_DIRECT_FLOW_ID) continue;
        if (protectedFlowIds.has(flowId)) continue;
        const remainingVersionCount = await transaction.agentFlowVersion.count({
          where: { flowId },
        });
        if (remainingVersionCount > 0) continue;

        const flow = await transaction.agentFlow.findUnique({
          where: { id: flowId },
          select: { id: true, publishedVersionId: true },
        });
        if (!flow || flow.publishedVersionId !== null) continue;
        await transaction.agentFlow.delete({ where: { id: flowId } });
        deletedFlowIds.push(flowId);
      }

      return {
        deletedVersionIds: eligibleIds,
        deletedFlowIds,
        skippedVersionIds,
      };
    },
    { isolationLevel: 'Serializable' },
  );
}

/**
 * 在删除事务内重新盘点指定 Flow
 * @param {object} prisma Prisma 事务客户端
 * @param {string[]} flowIds 初次报告涉及的 Flow ID
 * @param {(input: unknown) => object} validateDefinition 当前 Flow Definition 校验函数
 * @returns {Promise<object>} 返回指定范围内的最新版本报告
 * @description 查询形状与全量盘点保持一致，但只覆盖初次候选所属 Flow，避免事务内扫描无关数据。
 */
async function auditSelectedFlows(prisma, flowIds, validateDefinition) {
  const flows = await prisma.agentFlow.findMany({
    where: { id: { in: flowIds } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      publishedVersionId: true,
      versions: {
        orderBy: { version: 'asc' },
        select: {
          id: true,
          flowId: true,
          version: true,
          status: true,
          definition: true,
          schemaVersion: true,
          _count: {
            select: {
              taskSnapshots: true,
              defaultForAgents: true,
              auditLogs: true,
            },
          },
        },
      },
    },
  });
  const versions = flows.flatMap((flow) =>
    flow.versions.map((version) =>
      inspectVersion(flow, version, validateDefinition),
    ),
  );
  return { flows, versions };
}

/**
 * 输出人类可读盘点报告
 * @param {object} report 全量盘点结果
 * @returns {void} 无返回值
 * @description 表格只展示定位字段和错误摘要，不输出完整 Definition。
 */
function printHumanReport(report) {
  const { summary } = report;
  console.log(
    `[agent-flow-audit] Flow ${summary.flowCount} 个，版本 ${summary.versionCount} 个；` +
      `兼容 ${summary.compatibleCount} 个，不兼容 ${summary.incompatibleCount} 个，` +
      `可删除候选 ${summary.deletionCandidateCount} 个。`,
  );
  console.table(
    report.versions.map((version) => ({
      flow: version.flowName,
      flowId: version.flowId,
      version: version.version,
      versionId: version.versionId,
      status: version.status,
      schema: version.schemaVersion,
      compatible: version.schemaCompatible,
      tasks: version.taskReferenceCount,
      agents: version.agentBindingCount,
      audits: version.auditLogCount,
      candidate: version.deletionCandidate,
      error: version.errorSummary,
    })),
  );
}

/**
 * 执行 AgentFlow 工件盘点命令
 * @returns {Promise<void>} 无返回值
 * @description 加载 API 环境与当前契约校验器；默认只读，只有 `--delete` 会调用安全清理事务。
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const apiRoot = path.resolve(__dirname, '..');
  loadEnvironment(path.join(apiRoot, '.env'));
  process.env.TS_NODE_PROJECT = path.join(apiRoot, 'tsconfig.json');
  require('ts-node/register');
  require('tsconfig-paths/register');

  const { PrismaClient } = require('@prisma/client');
  const {
    validateFlowDefinition,
  } = require('../src/modules/agent-flow/definition/flow-definition.validator');
  const prisma = new PrismaClient();
  try {
    const report = await auditFlowVersions(prisma, validateFlowDefinition);
    if (options.format === 'human') {
      printHumanReport(report);
      if (!options.delete) {
        console.log(
          '[agent-flow-audit] 当前为只读模式；确认候选清单后传入 --delete 才会写入数据库。',
        );
      }
    }

    let deletion;
    if (options.delete) {
      const candidates = report.versions.filter(
        (version) => version.deletionCandidate,
      );
      if (options.format === 'human') {
        console.log(
          `[agent-flow-audit] 将重新校验并尝试删除 ${candidates.length} 个候选版本。`,
        );
      }
      deletion = await deleteAuditCandidates(
        prisma,
        candidates,
        validateFlowDefinition,
      );
      if (options.format === 'human') {
        console.log(
          `[agent-flow-audit] 已删除版本 ${deletion.deletedVersionIds.length} 个、空壳 Flow ${deletion.deletedFlowIds.length} 个；` +
            `因状态变化跳过 ${deletion.skippedVersionIds.length} 个。`,
        );
      }
    }

    if (options.format === 'json') {
      console.log(
        JSON.stringify({ report, ...(deletion ? { deletion } : {}) }, null, 2),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `[agent-flow-audit] 执行失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  BUILTIN_DIRECT_FLOW_ID,
  auditFlowVersions,
  deleteAuditCandidates,
  deletionBlockers,
  hasDefinitionObjectShape,
  inspectVersion,
  loadEnvironment,
  parseArguments,
  summarizeErrors,
};
