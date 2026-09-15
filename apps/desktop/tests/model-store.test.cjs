const assert = require("node:assert/strict");
const test = require("node:test");
const { loadStore } = require("./load-store.cjs");

function setup() {
  const memory = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, value),
    },
  });
  let calls = 0;
  const capability = {
    effort: {
      configurable: true,
      values: ["low", "high"],
      defaultValue: "low",
    },
    defaultSelection: { effort: "low" },
  };
  const models = [
    { modelPresetId: "a", reasoningCapability: capability },
    { modelPresetId: "b", reasoningCapability: capability },
  ];
  const result = loadStore("stores/model-store.ts", {
    "@/api/endpoints": {
      getAgentModelOptions: async (agentId) => {
        calls++;
        return {
          models: agentId === "flow" ? [] : models,
          defaultModelPresetId: "a",
          defaultReasoning: null,
        };
      },
    },
  });
  return { ...result, models, calls: () => calls };
}

test("项目与普通对话独立选择模型/思考，模型目录请求去重", async () => {
  const {
    useModelStore: store,
    models,
    modelSelectionKey: key,
    calls,
  } = setup();
  await Promise.all([
    store.getState().ensureOptions("agent", "chat"),
    store.getState().ensureOptions("agent", "project:1"),
    store.getState().ensureOptions("agent", "project:1"),
  ]);
  assert.equal(calls(), 1);
  store.getState().selectModel("agent", models[1], "project:1");
  store.getState().changeReasoning("agent", { effort: "high" }, "project:1");
  assert.equal(
    store.getState().selectionByScope[key("agent", "chat")].modelPresetId,
    "a",
  );
  assert.equal(
    store.getState().selectionByScope[key("agent", "project:1")].modelPresetId,
    "b",
  );
  assert.equal(
    store.getState().selectionByScope[key("agent", "chat")].reasoning.effort,
    "low",
  );
  store.getState().selectModel("agent", models[0], "project:1");
  assert.equal(
    store.getState().selectionByScope[key("agent", "project:1")].reasoning
      .effort,
    "low",
  );
});

test("自定义 Flow 不生成模型覆盖选项", async () => {
  const { useModelStore: store, modelSelectionKey: key } = setup();
  await store.getState().ensureOptions("flow", "project:1");
  assert.deepEqual(store.getState().optionsByAgent.flow.models, []);
  assert.equal(
    store.getState().selectionByScope[key("flow", "project:1")],
    undefined,
  );
});
