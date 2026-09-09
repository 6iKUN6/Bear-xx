import assert from "node:assert/strict";
import test from "node:test";
import { setNodeDescription, type EditableDefinition } from "./flow-edit.ts";

test("节点描述写入节点顶层而不是 config", () => {
  const definition: EditableDefinition = {
    nodes: [{ id: "answer", type: "synthesize", config: {} }],
    edges: [],
  };

  const updated = setNodeDescription(definition, "answer", "  汇总上游结果  ");

  assert.equal(updated.nodes[0]?.description, "汇总上游结果");
  assert.equal(updated.nodes[0]?.config.description, undefined);
});

test("清空节点描述时删除顶层字段且不改动 config", () => {
  const config = { modelPreset: "agent-default" };
  const definition: EditableDefinition = {
    nodes: [
      {
        id: "answer",
        type: "synthesize",
        description: "旧描述",
        config,
      },
    ],
    edges: [],
  };

  const updated = setNodeDescription(definition, "answer", "   ");

  assert.equal("description" in updated.nodes[0]!, false);
  assert.deepEqual(updated.nodes[0]?.config, config);
});
