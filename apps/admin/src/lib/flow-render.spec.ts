import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_FLOW_SCHEMA_VERSION,
  FLOW_NODE_OUTPUTS,
} from "@litter-bear/types/agent-flow";
import {
  ADDABLE_NODE_TYPES,
  addNode,
  branchKeysOf,
  connect,
  toEditableDefinition,
  updateNodeConfig,
  type EditableDefinition,
} from "./flow-edit.ts";
import { parseFlowCreationJson } from "./flow-create.ts";
import {
  NODE_TYPE_ICONS,
  nodeOutputEntries,
  nodeTypeMeta,
  readDefinitionForCanvas,
  toFlowGraph,
  variableOptions,
  type CanvasDefinition,
} from "./flow-graph.ts";
import { nodeTypeColors } from "./flow-node-colors.ts";

function renderDraft(): EditableDefinition {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: "agent-flow",
    name: "视频制作",
    policy: {
      maxSteps: 20,
      maxModelCalls: 10,
      maxToolCalls: 4,
      maxDurationSeconds: 1800,
    },
    nodes: [
      { id: "start", type: "start", config: {} },
      { id: "html", type: "agent", config: {} },
      { id: "end", type: "end", config: {} },
    ],
    edges: [{ from: "start", to: "html" }],
  };
}

test("添加面板包含所有非起止节点，视频渲染可从同一闭集创建", () => {
  assert.deepEqual(
    new Set(ADDABLE_NODE_TYPES),
    new Set(
      Object.keys(FLOW_NODE_OUTPUTS).filter(
        (type) => type !== "start" && type !== "end",
      ),
    ),
  );
  for (const type of ADDABLE_NODE_TYPES) {
    const result = addNode(renderDraft(), type, { x: 400, y: 100 }, {});
    assert.equal(result.ok, true, `面板节点 ${type} 必须能创建`);
    if (!result.ok) continue;
    assert.equal(result.definition.nodes.at(-1)?.type, type);
  }
});

test("新增视频渲染节点可连线、修改配置、导出再导入，保留版本和预算", () => {
  const source = renderDraft();
  const added = addNode(source, "render", { x: 400, y: 100 }, {});
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const node = added.definition.nodes.find((item) => item.type === "render")!;
  assert.equal(
    "htmlRef" in node.config,
    false,
    "未连线的新节点不能伪造 HTML 引用",
  );
  assert.equal(node.config.width, 1080);
  assert.equal(node.config.height, 1920);
  assert.equal(node.config.durationSeconds, 60);
  assert.equal(node.config.fps, 30);

  const input = connect(added.definition, "html", node.id, "default");
  assert.equal(input.ok, true);
  if (!input.ok) return;
  const output = connect(input.definition, node.id, "end", "default");
  assert.equal(output.ok, true);
  if (!output.ok) return;
  const config = {
    htmlRef: { $ref: ["html", "text"] },
    width: 1920,
    height: 1080,
    durationSeconds: 90,
    fps: 24,
  };
  const edited = updateNodeConfig(output.definition, node.id, config);
  const imported = parseFlowCreationJson(JSON.stringify(edited));
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const reloaded = toEditableDefinition(imported.definition);
  const canvas = readDefinitionForCanvas(imported.definition);
  assert.equal(reloaded.ok, true);
  assert.equal(canvas.ok, true);
  if (!reloaded.ok || !canvas.ok) return;
  assert.deepEqual(
    reloaded.definition.nodes.find((item) => item.id === node.id)?.config,
    config,
  );
  assert.equal(reloaded.definition.schemaVersion, source.schemaVersion);
  assert.deepEqual(reloaded.definition.policy, source.policy);
  assert.deepEqual(reloaded.definition.layout?.nodes[node.id], {
    x: 400,
    y: 100,
  });
  assert.equal(
    toFlowGraph(canvas.definition).edges.some(
      (edge) => edge.source === node.id && edge.target === "end",
    ),
    true,
  );
  assert.deepEqual(branchKeysOf(node), ["default"]);
  assert.equal(
    source.nodes.some((item) => item.type === "render"),
    false,
    "编辑不能修改原草稿",
  );
});

test("服务端 JSONB 边键顺序不影响保存后可编辑草稿的基线", () => {
  const source = renderDraft();
  const before = toEditableDefinition(source);
  const reloaded = toEditableDefinition({
    ...source,
    edges: [{ to: "html", from: "start" }],
  });
  assert.equal(before.ok, true);
  assert.equal(reloaded.ok, true);
  if (!before.ok || !reloaded.ok) return;
  assert.equal(
    JSON.stringify(before.definition),
    JSON.stringify(reloaded.definition),
  );
});

test("HTML 来源按 string 类型筛选而非固定 text 字段，排除并行、下游和非字符串输出", () => {
  const definition: CanvasDefinition = {
    nodes: [
      { id: "start", type: "start", config: {} },
      { id: "plan", type: "plan", config: {} },
      {
        id: "extract",
        type: "structured-output",
        config: {
          fields: [
            { name: "html", type: "string", required: true },
            { name: "score", type: "number", required: true },
          ],
        },
      },
      { id: "parallel", type: "agent", config: {} },
      { id: "render", type: "render", config: {} },
      { id: "end", type: "end", config: {} },
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "extract" },
      { from: "plan", to: "parallel" },
      { from: "extract", to: "render" },
      { from: "render", to: "end" },
      { from: "parallel", to: "end" },
    ],
  };
  assert.deepEqual(
    variableOptions("render", definition, undefined, "string").map(
      (item) => item.ref,
    ),
    [
      ["start", "text"],
      ["extract", "html"],
    ],
  );
  assert.deepEqual(
    variableOptions("render", definition, "steps").map((item) => item.ref),
    [["plan", "steps"]],
  );
});

test("render 唯一输出 path 可被下游作为 string 引用，不泄露帧图或视频字节", () => {
  const source = renderDraft();
  const definition: CanvasDefinition = {
    nodes: [
      ...source.nodes,
      { id: "render", type: "render", config: {} },
      { id: "qc", type: "evaluate", config: {} },
    ],
    edges: [
      ...source.edges,
      { from: "html", to: "render" },
      { from: "render", to: "qc" },
      { from: "qc", to: "end" },
    ],
  };
  assert.deepEqual(nodeOutputEntries("render"), [
    { field: "path", valueType: "string" },
  ]);
  assert.deepEqual(
    variableOptions("qc", definition).filter(
      (item) => item.sourceId === "render",
    ),
    [
      {
        ref: ["render", "path"],
        sourceId: "render",
        field: "path",
        valueType: "string",
        label: "render.path（string）",
      },
    ],
  );
});

test("Loop 体内 render 输出可供当轮 QC 和循环边界引用，不泄露到出环下游", () => {
  const definition: CanvasDefinition = {
    nodes: [
      { id: "start", type: "start", config: {} },
      { id: "html", type: "agent", config: {} },
      { id: "loop", type: "loop", config: { maxIterations: 3, breakWhen: [] } },
      { id: "render", type: "render", loopId: "loop", config: {} },
      { id: "qc", type: "evaluate", loopId: "loop", config: {} },
      { id: "titles", type: "synthesize", config: {} },
      { id: "end", type: "end", config: {} },
    ],
    edges: [
      { from: "start", to: "html" },
      { from: "html", to: "loop" },
      { from: "loop", to: "render", when: "again" },
      { from: "render", to: "qc" },
      { from: "qc", to: "loop" },
      { from: "loop", to: "titles", when: "done" },
      { from: "titles", to: "end" },
    ],
  };
  assert.equal(
    variableOptions("render", definition, undefined, "string").some(
      (item) => item.sourceId === "html",
    ),
    true,
  );
  for (const target of ["qc", "loop"]) {
    assert.equal(
      variableOptions(target, definition, undefined, "string").some(
        (item) => item.sourceId === "render" && item.field === "path",
      ),
      true,
    );
  }
  assert.equal(
    variableOptions("titles", definition).some(
      (item) => item.sourceId === "render",
    ),
    false,
  );
});

test("render 有中文元数据、图标与语义配色，所有共享节点类型都已注册", () => {
  for (const type of Object.keys(FLOW_NODE_OUTPUTS)) {
    assert.notEqual(
      nodeTypeMeta(type).desc,
      "未知节点类型，后台可能落后于后端契约",
    );
  }
  assert.equal(nodeTypeMeta("render").name, "视频渲染");
  assert.equal(nodeTypeMeta("render").category, "执行");
  assert.ok(NODE_TYPE_ICONS.render);
  assert.match(nodeTypeColors("render").color, /^var\(--lb-/);
  assert.notEqual(nodeTypeColors("render").color, "var(--lb-danger)");
});
