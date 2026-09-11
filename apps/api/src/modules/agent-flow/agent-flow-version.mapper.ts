import { Prisma, type AgentFlowVersion } from '@prisma/client';
import { inspectFlowDefinition } from './definition/flow-definition.versioning';
import type { AgentFlowVersionResponse } from './agent-flow.service';

/**
 * 映射 AgentFlowVersion 为管理端响应
 * @param version Prisma 查询或写入得到的版本记录
 * @returns 返回可展示的版本数据，含契约兼容性
 * @description 读取路径**不要求**工件仍然合法。原先两个 service 各有一份实现，都调
 * requireValidDefinition 来收敛 Json 类型，副作用是契约一升级、存量工件不再通过校验，
 * 读取就抛 400：一条旧数据能让整个 Flow 列表返回 400，管理员连别的 Flow 都看不到、删不掉，
 * 而且 GET 返回 400 语义本身就是错的——请求没问题，是存量数据不再符合当前契约。
 *
 * 现在把「不兼容」当作要如实呈现的事实：原文照返，兼容性与逐条原因单独给出，由管理端显示
 * 不兼容标记并禁用编辑与发布。这不是静默透传脏数据，恰恰相反——原先那种做法才是让人
 * 完全看不到发生了什么。
 */
export function toAgentFlowVersionResponse(
  version: AgentFlowVersion,
): AgentFlowVersionResponse {
  const inspection = inspectFlowDefinition(version.definition);
  return {
    id: version.id,
    flowId: version.flowId,
    version: version.version,
    status: version.status,
    definition: toDefinitionObject(version.definition),
    schemaStatus: inspection.status,
    schemaTargetVersion: inspection.targetVersion,
    ...(inspection.errors.length === 0
      ? {}
      : { schemaErrors: [...inspection.errors] }),
    digest: version.digest,
    schemaVersion: version.schemaVersion,
    createdAt: version.createdAt.getTime(),
    updatedAt: version.updatedAt.getTime(),
    publishedAt: version.publishedAt?.getTime() ?? null,
    archivedAt: version.archivedAt?.getTime() ?? null,
  };
}

/**
 * 把存储的 Definition JSON 收敛为可返回的对象
 * @param value Prisma 读到的 Json 值
 * @returns 是对象时原样返回，否则返回空对象
 * @description 只保证响应类型成立，不判断内容是否合法——合法性由 schemaStatus 表达。
 * 数组或标量落在这一列意味着数据已损坏；返回空对象让管理端显示「不兼容」，而不是让整个请求失败。
 */
function toDefinitionObject(value: Prisma.JsonValue): object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : {};
}
