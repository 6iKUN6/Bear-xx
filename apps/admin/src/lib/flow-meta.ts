import type { BadgeProps } from "@/components/ui/badge";
import type { AgentFlowVersionStatus } from "@/api/types";

interface VersionStatusMeta {
  name: string;
  desc: string;
  variant: BadgeProps["variant"];
}

/**
 * 版本状态展示元数据。
 * 只有 PUBLISHED 版本能被 Agent 绑定并真正运行；DRAFT 可编辑，ARCHIVED 只能回滚。
 */
const VERSION_STATUS_META: Record<AgentFlowVersionStatus, VersionStatusMeta> = {
  DRAFT: {
    name: "草稿",
    desc: "可编辑；发布后才能被智能体绑定运行",
    variant: "secondary",
  },
  PUBLISHED: {
    name: "已发布",
    desc: "当前生效版本，不可编辑；任务会锁定它的 digest",
    variant: "success",
  },
  ARCHIVED: {
    name: "已归档",
    desc: "历史版本，不可编辑；可回滚为当前发布版本",
    variant: "outline",
  },
};

export function versionStatusMeta(status: string): VersionStatusMeta {
  return (
    VERSION_STATUS_META[status as AgentFlowVersionStatus] ?? {
      name: status,
      desc: "未知版本状态",
      variant: "outline",
    }
  );
}

/**
 * 格式化 FlowDefinition 为可编辑文本
 * @param definition 后端返回的 Definition 工件
 * @returns 返回两空格缩进的 JSON 文本
 */
export function formatDefinition(definition: object): string {
  return JSON.stringify(definition, null, 2);
}

/** JSON 文本解析结果；失败时带上可展示的原因 */
export type ParsedDefinition =
  | { ok: true; value: object }
  | { ok: false; error: string };

/**
 * 解析编辑器里的 JSON 文本
 * @param text 用户编辑的文本
 * @returns 解析成功返回对象，失败返回原始错误信息
 * @description 只做 JSON 语法解析，不做 FlowDefinition 结构判断——结构由服务端校验器唯一裁定，
 * 前端再抄一份规则必然与后端漂移。
 */
export function parseDefinition(text: string): ParsedDefinition {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "JSON 无法解析" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "FlowDefinition 必须是一个 JSON 对象" };
  }
  return { ok: true, value };
}

/** 读取 Definition 里的展示名，取不到时回退 */
export function definitionName(definition: object): string {
  const name = (definition as { name?: unknown }).name;
  return typeof name === "string" && name ? name : "(未命名)";
}
