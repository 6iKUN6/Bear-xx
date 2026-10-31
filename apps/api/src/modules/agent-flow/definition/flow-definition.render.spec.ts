import {
  AGENT_FLOW_SCHEMA_VERSION,
  FLOW_NODE_OUTPUTS,
  FLOW_RENDER_LIMITS,
} from '@litter-bear/types/agent-flow';
import { calculateFlowDefinitionDigest } from './flow-definition.digest';
import { validateFlowDefinition } from './flow-definition.validator';
import {
  inspectFlowDefinition,
  normalizeFlowDefinition,
} from './flow-definition.versioning';

describe('render 节点契约', () => {
  it('render 的唯一输出是对象路径字符串', () => {
    expect(FLOW_NODE_OUTPUTS.render).toEqual({ path: 'string' });
  });

  it('当前 schemaVersion 允许 v13 的 render 节点', () => {
    expect(AGENT_FLOW_SCHEMA_VERSION).toBe(13);
    const result = validateFlowDefinition(renderDefinition());
    expect(result).toEqual({ success: true, definition: expect.anything() });
  });

  it.each([
    ['奇数宽度', { width: 1081 }],
    ['超宽', { width: FLOW_RENDER_LIMITS.maxWidth + 2 }],
    ['帧率为 0', { fps: 0 }],
    ['帧率超上限', { fps: FLOW_RENDER_LIMITS.maxFps + 1 }],
    ['时长为 0', { durationSeconds: 0 }],
    [
      '时长超上限',
      { durationSeconds: FLOW_RENDER_LIMITS.maxDurationSeconds + 1 },
    ],
    ['总帧数超预算', { durationSeconds: 1800, fps: 60 }],
    ['像素超上限', { width: 3840, height: 3840 }],
    ['小数帧率', { fps: 29.97 }],
  ])('参数非法时拒绝发布：%s', (_label, overrides) => {
    const result = validateFlowDefinition(
      renderDefinition({
        config: { ...renderConfig(), ...overrides },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('拒绝引用非字符串输出作为 HTML', () => {
    // evaluate 的 score 是 number：拿它当 HTML 只会在渲染期变成字符串 "[object Object]"
    const result = validateFlowDefinition(nonStringRefDefinition());
    expect(result.success).toBe(false);
    expect(readErrorRules(result)).toContain('render-html-ref-type');
  });

  it.each([
    ['不存在的节点', ['missing', 'text']],
    ['自己的输出', ['render', 'path']],
    ['下游节点', ['end', 'text']],
  ])('拒绝引用%s作为 HTML 来源', (_label, ref) => {
    const result = validateFlowDefinition(
      renderDefinition({
        config: {
          ...renderConfig(),
          htmlRef: { $ref: ref as [string, string] },
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('v12 工件里的 render 节点会被拒绝，旧 schema 不接受新节点', () => {
    const inspection = inspectFlowDefinition({
      ...renderDefinition(),
      schemaVersion: 12,
    });
    expect(inspection.status).not.toBe('upgradeable');
    expect(inspection.status).not.toBe('current');
  });

  it('v12 升 v13 保留源工件 digest，且不改变节点内容', () => {
    const withoutRender = startEndDefinition(12);

    const inspection = inspectFlowDefinition(withoutRender);
    expect(inspection.status).toBe('upgradeable');
    expect(inspection.definition?.schemaVersion).toBe(13);

    const normalized = normalizeFlowDefinition(withoutRender);
    expect(normalized.success).toBe(true);
    if (!normalized.success) return;
    // 摘要必须基于数据库里的原始 v12 工件，而不是迁移后的内存对象
    expect(normalized.sourceDigest).toBe(
      calculateFlowDefinitionDigest(withoutRender),
    );
    expect(normalized.sourceDigest).not.toBe(
      calculateFlowDefinitionDigest(normalized.definition),
    );
  });

  it('v13 带 render 的工件可以规范化且摘要稳定', () => {
    const definition = renderDefinition();
    const normalized = normalizeFlowDefinition(definition);
    expect(normalized.success).toBe(true);
    if (!normalized.success) return;
    expect(normalized.sourceDigest).toBe(
      calculateFlowDefinitionDigest(definition),
    );
    expect(normalized.definition.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'render' })]),
    );
  });
});

/**
 * 构造 start → render → end 的合法 v13 图
 * @param overrides 可覆盖的 render 节点配置
 * @returns 返回用于校验的 Definition 原始 JSON
 */
function renderDefinition(overrides: { config?: object } = {}) {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow' as const,
    name: '渲染测试图',
    policy: {
      maxSteps: 1,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxDurationSeconds: 60,
    },
    nodes: [
      { id: 'start', type: 'start' as const, config: {} },
      {
        id: 'render',
        type: 'render' as const,
        config: { ...renderConfig(), ...overrides.config },
      },
      { id: 'end', type: 'end' as const, config: {} },
    ],
    edges: [
      { from: 'start', to: 'render' },
      { from: 'render', to: 'end' },
    ],
  };
}

/** 合法的四项成片参数；用例只覆盖其中一项，其余保持可执行。 */
function renderConfig() {
  return {
    htmlRef: { $ref: ['start', 'text'] as [string, string] },
    width: 1080,
    height: 1920,
    durationSeconds: 60,
    fps: 30,
  };
}

/**
 * 构造「HTML 引用指向 number 输出」的图
 * @returns 返回 start → evaluate → render → end 的 Definition
 * @description evaluate 的 score 是固定 number 输出，正好用来验证引用类型约束。
 */
function nonStringRefDefinition() {
  return {
    ...renderDefinition({
      config: { ...renderConfig(), htmlRef: { $ref: ['judge', 'score'] } },
    }),
    nodes: [
      { id: 'start', type: 'start', config: {} },
      {
        id: 'judge',
        type: 'evaluate',
        config: {
          inputRefs: [{ $ref: ['start', 'text'] }],
          criteria: '判断是否通过',
        },
      },
      {
        id: 'render',
        type: 'render',
        config: { ...renderConfig(), htmlRef: { $ref: ['judge', 'score'] } },
      },
      { id: 'end', type: 'end', config: {} },
    ],
    edges: [
      { from: 'start', to: 'judge' },
      { from: 'judge', to: 'render' },
      { from: 'render', to: 'end' },
    ],
  };
}

/**
 * 构造只有 start 与 end 的历史版本图
 * @param schemaVersion 目标历史版本号
 * @returns 返回该版本的最小合法 Definition
 */
function startEndDefinition(schemaVersion: number) {
  return {
    schemaVersion,
    kind: 'agent-flow' as const,
    name: '最小图',
    policy: {
      maxSteps: 1,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxDurationSeconds: 60,
    },
    nodes: [
      { id: 'start', type: 'start' as const, config: {} },
      { id: 'end', type: 'end' as const, config: {} },
    ],
    edges: [{ from: 'start', to: 'end' }],
  };
}

/**
 * 读取校验失败结果里的规则名
 * @param result validateFlowDefinition 的返回值
 * @returns 返回错误规则名数组；成功时为 undefined
 */
function readErrorRules(result: { success: boolean }): string[] | undefined {
  if (result.success) return undefined;
  const errors = (result as unknown as { errors?: Array<{ rule?: string }> })
    .errors;
  return errors?.map((item) => item.rule ?? '');
}
