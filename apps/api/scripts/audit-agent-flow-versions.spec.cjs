const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  BUILTIN_DIRECT_FLOW_ID,
  deleteAuditCandidates,
  deletionBlockers,
  hasDefinitionObjectShape,
  inspectVersion,
  parseArguments,
  summarizeErrors,
} = require('./audit-agent-flow-versions.cjs');

/**
 * 构造版本查询行
 * @param {Partial<object>} overrides 需要覆盖的版本字段
 * @returns {object} 返回具备 Prisma 盘点查询形状的测试对象
 * @description 只构造候选判定需要的字段，避免单测依赖真实数据库。
 */
function versionRow(overrides = {}) {
  return {
    id: 'version-1',
    flowId: 'flow-1',
    version: 1,
    status: 'DRAFT',
    definition: {},
    schemaVersion: 1,
    _count: { taskSnapshots: 0, defaultForAgents: 0, auditLogs: 0 },
    ...overrides,
  };
}

test('默认参数保持只读并支持 JSON 输出', () => {
  assert.deepEqual(parseArguments([]), { delete: false, format: 'human' });
  assert.deepEqual(parseArguments(['--format=json']), {
    delete: false,
    format: 'json',
  });
  assert.deepEqual(parseArguments(['--delete', '--format=json']), {
    delete: true,
    format: 'json',
  });
  assert.throws(() => parseArguments(['--apply']), /不支持的参数/);
});

test('区分 Definition 对象根与明显损坏的 JSON 根值', () => {
  assert.equal(hasDefinitionObjectShape({}), true);
  assert.equal(hasDefinitionObjectShape(null), false);
  assert.equal(hasDefinitionObjectShape([]), false);
  assert.equal(hasDefinitionObjectShape('broken'), false);
});

test('错误摘要限制条数并报告剩余数量', () => {
  const errors = [1, 2, 3, 4].map((index) => ({
    path: `nodes.${index}`,
    rule: 'schema',
    message: `错误 ${index}`,
  }));
  assert.match(summarizeErrors(errors), /nodes\.1/);
  assert.match(summarizeErrors(errors), /另有 1 条/);
  assert.doesNotMatch(summarizeErrors(errors), /nodes\.4/);
});

test('只有无引用且非发布的不兼容草稿是删除候选', () => {
  const flow = { id: 'flow-1', name: '测试 Flow', publishedVersionId: null };
  const invalid = () => ({
    success: false,
    errors: [{ path: '$', rule: 'schema', message: '不兼容' }],
  });
  const report = inspectVersion(flow, versionRow(), invalid);

  assert.equal(report.deletionCandidate, true);
  assert.deepEqual(report.deletionBlockers, []);
  assert.equal(report.schemaCompatible, false);
});

test('发布、任务引用、Agent 绑定和内置 Flow 均阻止删除', () => {
  const blockers = deletionBlockers({
    flowId: BUILTIN_DIRECT_FLOW_ID,
    status: 'PUBLISHED',
    schemaCompatible: false,
    isCurrentPublished: true,
    taskReferenceCount: 1,
    agentBindingCount: 1,
  });

  assert.deepEqual(blockers, [
    'builtin-flow',
    'not-draft',
    'current-published',
    'task-referenced',
    'agent-bound',
  ]);
});

test('符合当前契约的草稿不会被清理', () => {
  const report = inspectVersion(
    { id: 'flow-1', name: '正常 Flow', publishedVersionId: null },
    versionRow(),
    () => ({ success: true, definition: {} }),
  );

  assert.equal(report.deletionCandidate, false);
  assert.deepEqual(report.deletionBlockers, ['schema-compatible']);
});

test('删除前重新校验候选，并删除失去全部版本的空壳 Flow', async () => {
  const deletedVersionIds = [];
  const deletedFlowIds = [];
  const flow = {
    id: 'flow-1',
    name: '待清理 Flow',
    publishedVersionId: null,
    versions: [versionRow()],
  };
  const transaction = {
    agentFlow: {
      findMany: async () => [flow],
      findUnique: async () => ({ id: flow.id, publishedVersionId: null }),
      delete: async ({ where }) => {
        deletedFlowIds.push(where.id);
      },
    },
    agentFlowVersion: {
      deleteMany: async ({ where }) => {
        deletedVersionIds.push(...where.id.in);
        return { count: where.id.in.length };
      },
      count: async () => 0,
    },
    streamTask: { count: async () => 0 },
    agent: { count: async () => 0 },
  };
  const prisma = {
    $transaction: async (operation) => operation(transaction),
  };
  const invalid = () => ({
    success: false,
    errors: [{ path: '$', rule: 'schema', message: '不兼容' }],
  });

  const result = await deleteAuditCandidates(
    prisma,
    [{ versionId: 'version-1', flowId: 'flow-1' }],
    invalid,
  );

  assert.deepEqual(result, {
    deletedVersionIds: ['version-1'],
    deletedFlowIds: ['flow-1'],
    skippedVersionIds: [],
  });
  assert.deepEqual(deletedVersionIds, ['version-1']);
  assert.deepEqual(deletedFlowIds, ['flow-1']);
});

test('候选在事务内变为受保护状态时跳过删除', async () => {
  const flow = {
    id: 'flow-1',
    name: '已被引用 Flow',
    publishedVersionId: null,
    versions: [
      versionRow({
        _count: { taskSnapshots: 1, defaultForAgents: 0, auditLogs: 0 },
      }),
    ],
  };
  const transaction = {
    agentFlow: { findMany: async () => [flow] },
    agentFlowVersion: {
      deleteMany: async ({ where }) => {
        assert.deepEqual(where.id.in, []);
        return { count: 0 };
      },
      count: async () => 1,
    },
    streamTask: { count: async () => 1 },
    agent: { count: async () => 0 },
  };
  const prisma = {
    $transaction: async (operation) => operation(transaction),
  };

  const result = await deleteAuditCandidates(
    prisma,
    [{ versionId: 'version-1', flowId: 'flow-1' }],
    () => ({
      success: false,
      errors: [{ path: '$', rule: 'schema', message: '不兼容' }],
    }),
  );

  assert.deepEqual(result, {
    deletedVersionIds: [],
    deletedFlowIds: [],
    skippedVersionIds: ['version-1'],
  });
});
