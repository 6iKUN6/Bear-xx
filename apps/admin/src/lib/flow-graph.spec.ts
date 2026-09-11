import assert from "node:assert/strict";
import test from "node:test";
import { toFlowGraph, type CanvasDefinition } from "./flow-graph.ts";

const definition: CanvasDefinition = {
  nodes: [
    { id: "start", type: "start", config: {} },
    {
      id: "quality_loop",
      type: "loop",
      config: { maxIterations: 3, continueWhen: [] },
    },
    { id: "generate", type: "agent", loopId: "quality_loop", config: {} },
    { id: "judge", type: "agent", loopId: "quality_loop", config: {} },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { from: "start", to: "quality_loop" },
    { from: "quality_loop", to: "generate", when: "again" },
    { from: "generate", to: "judge" },
    { from: "judge", to: "quality_loop" },
    { from: "quality_loop", to: "end", when: "done" },
  ],
  layout: {
    nodes: {
      start: { x: 0, y: 180 },
      quality_loop: {
        x: 240,
        y: 100,
        width: 520,
        height: 260,
        collapsed: false,
      },
      generate: { x: 24, y: 72 },
      judge: { x: 244, y: 72 },
      end: { x: 840, y: 180 },
    },
  },
};

test("展开 Loop 投影为父子节点并隐藏技术边", () => {
  const graph = toFlowGraph(definition);

  assert.equal(graph.nodes.find((node) => node.id === "generate")?.parentId, "quality_loop");
  assert.equal(graph.nodes.find((node) => node.id === "generate")?.hidden, undefined);
  assert.deepEqual(
    graph.edges.map((edge) => edge.id),
    ["start:default:quality_loop", "generate:default:judge", "quality_loop:done:end"],
  );
});

test("折叠 Loop 隐藏内部节点与业务边但保留入口和 done 出边", () => {
  const graph = toFlowGraph(definition, new Map([["quality_loop", true]]));

  assert.equal(graph.nodes.find((node) => node.id === "generate")?.hidden, true);
  assert.equal(graph.nodes.find((node) => node.id === "quality_loop")?.width, 220);
  assert.deepEqual(
    graph.edges.map((edge) => edge.id),
    ["start:default:quality_loop", "quality_loop:done:end"],
  );
});
