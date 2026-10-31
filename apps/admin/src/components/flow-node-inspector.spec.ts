import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FLOW_RENDER_LIMITS } from "@litter-bear/types/agent-flow";
import {
  FlowNodeInspector,
  type InspectorEditing,
} from "./flow-node-inspector.tsx";
import type { EditableNode } from "../lib/flow-edit.ts";
import type { CanvasDefinition } from "../lib/flow-graph.ts";

const node: EditableNode = {
  id: "render",
  type: "render",
  config: {
    htmlRef: { $ref: ["html", "text"] },
    width: 1080,
    height: 1920,
    durationSeconds: 60,
    fps: 30,
  },
};
const definition: CanvasDefinition = {
  nodes: [
    { id: "start", type: "start", config: {} },
    { id: "html", type: "agent", config: {} },
    node,
  ],
  edges: [
    { from: "start", to: "html" },
    { from: "html", to: "render" },
  ],
};
const editing: InspectorEditing = {
  capabilities: { toolGroups: [], modelPresets: [] },
  onChangeConfig() {},
  onRenameCase() {},
  onChangeName() {},
  onChangeDescription() {},
  onDeleteNode() {},
};

function numberInput(html: string, field: string): string {
  const input = html
    .match(/<input\b[^>]*>/g)
    ?.find((item) => item.includes(`-${field}"`));
  assert.ok(input, `没有找到 ${field} 输入框`);
  return input;
}

test("渲染表单使用共享边界和关联标签，并就地呈现后端字段错误", () => {
  const html = renderToStaticMarkup(
    createElement(FlowNodeInspector, {
      node,
      definition,
      editing,
      errors: [
        {
          path: "nodes.2.config.width",
          rule: "schema",
          message: "成片宽高必须是偶数",
        },
        {
          path: "nodes.2.config.htmlRef.$ref.1",
          rule: "ref-field",
          message: "HTML 来源必须是 string",
        },
      ],
    }),
  );
  assert.match(html, /视频渲染/);
  assert.match(html, /aria-label="HTML 来源"[^>]*aria-invalid="true"/);
  for (const field of ["width", "height", "durationSeconds", "fps"]) {
    const input = numberInput(html, field);
    const id = /\bid="([^"]+)"/.exec(input)![1];
    assert.ok(html.includes(`<label for="${id}"`));
    assert.match(input, /type="number"/);
    assert.match(input, /required=""/);
    assert.ok(input.includes(`aria-describedby="${id}-hint`));
  }
  assert.match(
    numberInput(html, "width"),
    new RegExp(
      `min="${FLOW_RENDER_LIMITS.minWidth}" max="${FLOW_RENDER_LIMITS.maxWidth}" step="2"`,
    ),
  );
  assert.match(
    numberInput(html, "height"),
    new RegExp(
      `min="${FLOW_RENDER_LIMITS.minHeight}" max="${FLOW_RENDER_LIMITS.maxHeight}" step="2"`,
    ),
  );
  assert.match(
    numberInput(html, "durationSeconds"),
    new RegExp(
      `min="${FLOW_RENDER_LIMITS.minDurationSeconds}" max="${FLOW_RENDER_LIMITS.maxDurationSeconds}" step="1"`,
    ),
  );
  assert.match(
    numberInput(html, "fps"),
    new RegExp(
      `min="${FLOW_RENDER_LIMITS.minFps}" max="${FLOW_RENDER_LIMITS.maxFps}" step="1"`,
    ),
  );
  assert.match(numberInput(html, "width"), /aria-invalid="true"/);
  assert.match(
    numberInput(html, "width"),
    /aria-describedby="[^"]*-width-hint [^"]*-width-error"/,
  );
  assert.match(
    html,
    /id="[^"]*-width-error" role="alert"[^>]*>成片宽高必须是偶数/,
  );
  assert.match(html, /HTML 来源必须是 string/);
  assert.match(html, /render\.path/);
});

test("只读和缺失参数不显示可编辑控件或伪造默认值", () => {
  const html = renderToStaticMarkup(
    createElement(FlowNodeInspector, {
      node: { ...node, config: { htmlRef: { $ref: ["html", "text"] } } },
      definition,
      errors: [],
    }),
  );
  for (const field of ["width", "height", "durationSeconds", "fps"]) {
    const input = numberInput(html, field);
    assert.match(input, /disabled=""/);
    assert.match(input, /value=""/);
  }
});

test("HTML 上游断线后明确显示引用不可用，而不是正常已选状态", () => {
  const html = renderToStaticMarkup(
    createElement(FlowNodeInspector, {
      node,
      definition: { ...definition, edges: [] },
      editing,
      errors: [],
    }),
  );
  assert.match(html, /html\.text（当前不可引用）/);
  assert.match(html, /aria-label="HTML 来源"[^>]*aria-invalid="true"/);
  assert.match(html, /不在可引用范围内，保存会被拒绝/);
});
