import assert from "node:assert/strict";
import test from "node:test";
import {
  addNode,
  connect,
  moveNode,
  setNodeDescription,
  type EditableDefinition,
} from "./flow-edit.ts";

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

test("拖入展开 Loop 时写入归属、相对坐标并维护单节点技术边", () => {
  const definition = loopDraft();

  const result = addNode(
    definition,
    "agent",
    { x: 180, y: 190 },
    definition.layout!.nodes,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.definition.nodes.at(-1)?.loopId, "quality_loop");
  assert.deepEqual(result.definition.layout?.nodes.agent, { x: 80, y: 90 });
  assert.deepEqual(result.definition.edges, [
    { from: "quality_loop", to: "agent", when: "again" },
    { from: "agent", to: "quality_loop" },
  ]);
});

test("内部业务拓扑唯一时重建 again 与回流边，多义时不保留旧技术边", () => {
  const first = addNode(
    loopDraft(),
    "agent",
    { x: 180, y: 190 },
    loopDraft().layout!.nodes,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = addNode(
    first.definition,
    "synthesize",
    { x: 380, y: 190 },
    first.definition.layout!.nodes,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.definition.edges, []);

  const connected = connect(
    second.definition,
    "agent",
    "synthesize",
    "default",
  );
  assert.equal(connected.ok, true);
  if (!connected.ok) return;
  assert.deepEqual(connected.definition.edges, [
    { from: "agent", to: "synthesize" },
    { from: "quality_loop", to: "agent", when: "again" },
    { from: "synthesize", to: "quality_loop" },
  ]);
});

test("拒绝业务边跨越 Loop 边界", () => {
  const definition = loopDraft({
    nodes: [
      { id: "inside", type: "agent", loopId: "quality_loop", config: {} },
      { id: "outside", type: "agent", config: {} },
    ],
  });

  const result = connect(definition, "outside", "inside", "default");

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /不能绕过 Loop 入口/);
});

test("无连线节点可拖入再拖出 Loop，并保持视觉绝对位置", () => {
  const definition = loopDraft({
    nodes: [{ id: "worker", type: "agent", config: {} }],
    layout: { worker: { x: 700, y: 160 } },
  });

  const movedIn = moveNode(
    definition,
    "worker",
    { x: 220, y: 210 },
    definition.layout!.nodes,
  );
  assert.equal(movedIn.ok, true);
  if (!movedIn.ok) return;
  assert.equal(movedIn.definition.nodes.at(-1)?.loopId, "quality_loop");
  assert.deepEqual(movedIn.definition.layout?.nodes.worker, { x: 120, y: 110 });

  const movedOut = moveNode(
    movedIn.definition,
    "worker",
    { x: 760, y: 210 },
    movedIn.definition.layout!.nodes,
  );
  assert.equal(movedOut.ok, true);
  if (!movedOut.ok) return;
  assert.equal(movedOut.definition.nodes.at(-1)?.loopId, undefined);
  assert.deepEqual(movedOut.definition.layout?.nodes.worker, {
    x: 760,
    y: 210,
  });
});

test("已有连线会因改归属而跨边界时拒绝拖入", () => {
  const definition = loopDraft({
    nodes: [
      { id: "left", type: "agent", config: {} },
      { id: "worker", type: "agent", config: {} },
    ],
    edges: [{ from: "left", to: "worker" }],
  });

  const result = moveNode(
    definition,
    "worker",
    { x: 220, y: 210 },
    definition.layout!.nodes,
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /将跨越 Loop 边界/);
});

function loopDraft(overrides?: {
  nodes?: EditableDefinition["nodes"];
  edges?: EditableDefinition["edges"];
  layout?: Record<string, { x: number; y: number }>;
}): EditableDefinition {
  return {
    nodes: [
      {
        id: "quality_loop",
        type: "loop",
        config: { maxIterations: 3, breakWhen: [] },
      },
      ...(overrides?.nodes ?? []),
    ],
    edges: overrides?.edges ?? [],
    layout: {
      nodes: {
        quality_loop: {
          x: 100,
          y: 100,
          width: 520,
          height: 260,
          collapsed: false,
        },
        ...(overrides?.layout ?? {}),
      },
    },
  };
}
