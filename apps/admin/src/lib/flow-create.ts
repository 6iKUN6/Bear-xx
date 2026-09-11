export type FlowCreateIntent = "create" | "create-and-edit";

export interface FlowCreationMetadata {
  name: string;
  description: string;
}

export type FlowCreationJsonResult =
  | {
      ok: true;
      definition: Record<string, unknown>;
      metadata: FlowCreationMetadata;
    }
  | { ok: false; error: string };

/**
 * 解析用于创建 Flow 的 JSON 文本
 * @param text 用户粘贴或从本地文件读取的完整 Definition 文本
 * @returns 返回对象根 Definition 及其名称、描述，或可直接展示的语法错误
 * @description 这里只判断 JSON 语法和对象根形状；节点、边与契约版本继续由后端唯一校验。
 */
export function parseFlowCreationJson(text: string): FlowCreationJsonResult {
  if (!text.trim()) {
    return { ok: false, error: "请输入或选择一份 Flow Definition JSON" };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "JSON 无法解析",
    };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "Flow Definition 必须是一个 JSON 对象" };
  }

  return {
    ok: true,
    definition: value,
    metadata: {
      name: typeof value.name === "string" ? value.name : "",
      description:
        typeof value.description === "string" ? value.description : "",
    },
  };
}

/**
 * 用创建表单内容覆盖 Definition 顶层元数据
 * @param definition 模板或 JSON 导入得到的完整 Definition
 * @param metadata 管理员最终确认的名称与描述
 * @returns 返回只覆盖顶层 name、description 的新 Definition
 * @description 不修改节点、边、版本或策略字段，完整契约仍交给后端校验。
 */
export function applyFlowCreationMetadata(
  definition: object,
  metadata: FlowCreationMetadata,
): Record<string, unknown> {
  return {
    ...definition,
    name: metadata.name.trim(),
    description: metadata.description.trim(),
  };
}

/**
 * 判断未知值是否为可展开的普通对象根
 * @param value 待检查的 JSON 解析结果
 * @returns 返回该值是否为非空且非数组的对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
