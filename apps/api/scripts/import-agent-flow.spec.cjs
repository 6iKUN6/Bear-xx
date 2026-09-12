const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const {
  importFlowWithServices,
  materializeModelPreset,
  parseArguments,
} = require('./import-agent-flow.cjs');

test('解析草稿导入、发布和身份参数', () => {
  assert.deepEqual(parseArguments(['--', 'flow.json']), {
    actor: undefined,
    filePath: 'flow.json',
    help: false,
    modelPreset: undefined,
    publish: false,
  });
  assert.deepEqual(
    parseArguments([
      './fixtures/loop.json',
      '--publish',
      '--actor=admin',
      '--model-preset=openai:gpt-5',
    ]),
    {
      actor: 'admin',
      filePath: './fixtures/loop.json',
      help: false,
      modelPreset: 'openai:gpt-5',
      publish: true,
    },
  );
  assert.throws(() => parseArguments([]), /JSON 文件路径/);
  assert.throws(
    () => parseArguments(['first.json', 'second.json']),
    /只能指定一个 JSON 文件/,
  );
  assert.throws(() => parseArguments(['flow.json', '--replace']), /未知参数/);
});

test('模型覆盖会物化全部模型节点且不修改输入对象', () => {
  const input = {
    nodes: [
      { id: 'agent', type: 'agent', config: { modelPreset: 'old' } },
      { id: 'plan', type: 'plan', config: { modelPreset: 'old' } },
      {
        id: 'execute',
        type: 'plan-loop',
        config: { executor: { type: 'agent', modelPreset: 'old' } },
      },
      {
        id: 'approval',
        type: 'approval',
        config: { policy: 'model', modelPreset: 'old' },
      },
      { id: 'answer', type: 'synthesize', config: { modelPreset: 'old' } },
      {
        id: 'extract',
        type: 'structured-output',
        config: { modelPreset: 'old' },
      },
      { id: 'judge', type: 'evaluate', config: { modelPreset: 'old' } },
      { id: 'end', type: 'end', config: {} },
    ],
  };
  const materialized = materializeModelPreset(input, {
    id: 'google:gemini-test',
    reasoning: { effort: 'high' },
  });

  assert.equal(input.nodes[0].config.modelPreset, 'old');
  for (const node of materialized.nodes.slice(0, 7)) {
    const config =
      node.type === 'plan-loop' ? node.config.executor : node.config;
    assert.equal(config.modelPreset, 'google:gemini-test');
    assert.deepEqual(config.reasoning, { effort: 'high' });
  }
  assert.deepEqual(materialized.nodes[7], input.nodes[7]);
});

test('发布预检失败时不会创建 Flow', async () => {
  let createCalls = 0;
  const flowService = {
    create: async () => {
      createCalls += 1;
      return {};
    },
  };
  const versionService = {
    validateDefinition: () => ({
      valid: false,
      errors: [{ path: 'edges', rule: 'cycle', message: '存在非法环' }],
    }),
    publish: async () => ({}),
  };

  await assert.rejects(
    importFlowWithServices({
      actorId: 'admin-1',
      definition: {},
      flowService,
      publish: true,
      versionService,
    }),
    /发布预检失败.*edges \[cycle\] 存在非法环/,
  );
  assert.equal(createCalls, 0);
});

test('结构化评估 Loop fixture 符合当前完整 Definition 契约', () => {
  const apiRoot = path.resolve(__dirname, '..');
  process.env.TS_NODE_PROJECT = path.join(apiRoot, 'tsconfig.json');
  require('ts-node/register');
  require('tsconfig-paths/register');
  const {
    validateFlowDefinition,
  } = require('../src/modules/agent-flow/definition/flow-definition.validator');
  const fixture = require('./fixtures/structured-evaluation-loop-v11.json');

  const result = validateFlowDefinition(fixture);
  assert.equal(
    result.success,
    true,
    result.success ? undefined : JSON.stringify(result.errors),
  );
});
