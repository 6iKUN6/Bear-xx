import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFlowCreationMetadata,
  parseFlowCreationJson,
} from "./flow-create.ts";

test("解析对象根 JSON 并读取顶层名称和描述", () => {
  const result = parseFlowCreationJson(
    JSON.stringify({
      schemaVersion: 9,
      name: "导入流程",
      description: "导入说明",
      nodes: [],
      edges: [],
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.metadata, {
    name: "导入流程",
    description: "导入说明",
  });
  assert.deepEqual(result.definition.nodes, []);
});

test("拒绝空文本、非法 JSON 与非对象根值", () => {
  assert.deepEqual(parseFlowCreationJson("  "), {
    ok: false,
    error: "请输入或选择一份 Flow Definition JSON",
  });
  assert.equal(parseFlowCreationJson("{").ok, false);
  assert.deepEqual(parseFlowCreationJson("[]"), {
    ok: false,
    error: "Flow Definition 必须是一个 JSON 对象",
  });
});

test("只覆盖 Definition 顶层元数据并保留其余字段", () => {
  const nodes = [{ id: "start", type: "start", config: {} }];
  const definition = applyFlowCreationMetadata(
    {
      schemaVersion: 9,
      name: "旧名称",
      description: "旧描述",
      nodes,
      edges: [],
    },
    { name: "  新名称  ", description: "  新描述  " },
  );

  assert.equal(definition.name, "新名称");
  assert.equal(definition.description, "新描述");
  assert.equal(definition.nodes, nodes);
  assert.equal(definition.schemaVersion, 9);
});
