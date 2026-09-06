import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type {
  ReasoningActivation,
  ReasoningEffort,
  ReasoningSelection,
} from '@litter-bear/types';
import type {
  LlmGenerationConfig,
  LlmReasoningCapability,
  LlmUpstreamFormat,
} from './llm.types';

export type ModelContextPolicy =
  'none' | 'assistant-reasoning' | 'full-tool-transcript' | 'thought-signature';

export type ModelReasoningRequestMapping =
  | { kind: 'none' }
  | { kind: 'anthropic'; mode: 'adaptive-effort' | 'budget' }
  | {
      kind: 'openai-compatible';
      activation?: 'thinking.type' | 'enable_thinking';
      effort?: 'reasoning_effort';
      budget?: 'thinking_budget';
    }
  | { kind: 'gemini'; mode: 'level' | 'budget' };

export interface ModelReasoningCapability extends LlmReasoningCapability {
  requestMapping: ModelReasoningRequestMapping;
  contextPolicy: ModelContextPolicy;
}

export interface ModelReasoningCatalogEntry {
  providerKey: string;
  upstreamFormat: LlmUpstreamFormat;
  model: string;
  capability: ModelReasoningCapability;
}

const enabledFixed = {
  values: ['enabled'] as const,
  defaultValue: 'enabled' as const,
  configurable: false,
};

const enabledToggle = {
  values: ['enabled', 'disabled'] as const,
  defaultValue: 'enabled' as const,
  configurable: true,
};

const samplingAllowed = {
  temperaturePolicy: 'allowed' as const,
  topPPolicy: 'allowed' as const,
};

const samplingForbidden = {
  temperaturePolicy: 'forbidden' as const,
  topPPolicy: 'forbidden' as const,
};

const samplingForbiddenWhenEnabled = {
  temperaturePolicy: 'forbidden_when_enabled' as const,
  topPPolicy: 'forbidden_when_enabled' as const,
};

function effortCapability(
  values: readonly ReasoningEffort[],
  defaultValue: ReasoningEffort,
) {
  return { values, defaultValue, configurable: true } as const;
}

/**
 * 精确模型思考能力目录。
 * @description 匹配键必须同时包含 providerKey、wire 格式和完整模型 ID。未知模型继续可作普通
 * 模型调用，但绝不按名称前缀猜测思考能力。
 */
export const MODEL_REASONING_CATALOG: readonly ModelReasoningCatalogEntry[] = [
  {
    providerKey: 'anthropic',
    upstreamFormat: 'anthropic_messages',
    model: 'claude-fable-5-1',
    capability: {
      activation: enabledFixed,
      effort: effortCapability(
        ['low', 'medium', 'high', 'xhigh', 'max'],
        'high',
      ),
      defaultSelection: { effort: 'high' },
      ...samplingForbiddenWhenEnabled,
      requestMapping: { kind: 'anthropic', mode: 'adaptive-effort' },
      contextPolicy: 'assistant-reasoning',
    },
  },
  ...['claude-opus-5', 'claude-sonnet-5'].map(
    (model): ModelReasoningCatalogEntry => ({
      providerKey: 'anthropic',
      upstreamFormat: 'anthropic_messages',
      model,
      capability: {
        activation: enabledToggle,
        effort: effortCapability(
          ['low', 'medium', 'high', 'xhigh', 'max'],
          'high',
        ),
        defaultSelection: { activation: 'enabled', effort: 'high' },
        ...samplingForbiddenWhenEnabled,
        requestMapping: { kind: 'anthropic', mode: 'adaptive-effort' },
        contextPolicy: 'assistant-reasoning',
      },
    }),
  ),
  {
    providerKey: 'anthropic',
    upstreamFormat: 'anthropic_messages',
    model: 'claude-haiku-4-5',
    capability: {
      activation: enabledToggle,
      budget: {
        supportsAuto: true,
        minimum: 1024,
        lessThanMaxOutputTokens: true,
        defaultValue: 'auto',
        configurable: true,
      },
      defaultSelection: { activation: 'enabled', budgetTokens: 'auto' },
      ...samplingForbiddenWhenEnabled,
      requestMapping: { kind: 'anthropic', mode: 'budget' },
      contextPolicy: 'assistant-reasoning',
    },
  },
  ...['deepseek-v4-pro', 'deepseek-v4-flash'].map(
    (model): ModelReasoningCatalogEntry => ({
      providerKey: 'deepseek',
      upstreamFormat: 'openai_chat_completions',
      model,
      capability: {
        activation: enabledToggle,
        effort: effortCapability(['low', 'high', 'max'], 'high'),
        defaultSelection: { activation: 'enabled', effort: 'high' },
        ...samplingForbiddenWhenEnabled,
        requestMapping: {
          kind: 'openai-compatible',
          activation: 'thinking.type',
          effort: 'reasoning_effort',
        },
        contextPolicy: 'full-tool-transcript',
      },
    }),
  ),
  ...[
    'doubao-seed-evolving',
    'doubao-seed-2-1-pro-260628',
    'doubao-seed-2-1-turbo-260628',
  ].map((model): ModelReasoningCatalogEntry => ({
    providerKey: 'doubao',
    upstreamFormat: 'openai_chat_completions',
    model,
    capability: {
      activation: enabledToggle,
      effort: effortCapability(['low', 'medium', 'high'], 'high'),
      defaultSelection: { activation: 'enabled', effort: 'high' },
      ...samplingAllowed,
      requestMapping: {
        kind: 'openai-compatible',
        activation: 'thinking.type',
        effort: 'reasoning_effort',
      },
      contextPolicy: 'full-tool-transcript',
    },
  })),
  {
    providerKey: 'kimi',
    upstreamFormat: 'openai_chat_completions',
    model: 'kimi-k3',
    capability: {
      activation: enabledFixed,
      effort: effortCapability(['low', 'high', 'max'], 'max'),
      defaultSelection: { effort: 'max' },
      ...samplingForbidden,
      requestMapping: {
        kind: 'openai-compatible',
        effort: 'reasoning_effort',
      },
      contextPolicy: 'full-tool-transcript',
    },
  },
  ...['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'].map(
    (model): ModelReasoningCatalogEntry => ({
      providerKey: 'kimi',
      upstreamFormat: 'openai_chat_completions',
      model,
      capability: {
        activation: enabledFixed,
        ...samplingForbidden,
        requestMapping: { kind: 'none' },
        contextPolicy: 'full-tool-transcript',
      },
    }),
  ),
  {
    providerKey: 'kimi',
    upstreamFormat: 'openai_chat_completions',
    model: 'kimi-k2.6',
    capability: {
      activation: enabledToggle,
      defaultSelection: { activation: 'enabled' },
      ...samplingForbiddenWhenEnabled,
      requestMapping: {
        kind: 'openai-compatible',
        activation: 'thinking.type',
      },
      contextPolicy: 'full-tool-transcript',
    },
  },
  ...['k3', 'k3-256k'].map((model): ModelReasoningCatalogEntry => ({
    providerKey: 'kimi-coding',
    upstreamFormat: 'openai_chat_completions',
    model,
    capability: {
      activation: enabledFixed,
      effort: effortCapability(['low', 'high', 'max'], 'high'),
      defaultSelection: { effort: 'high' },
      ...samplingForbidden,
      requestMapping: {
        kind: 'openai-compatible',
        effort: 'reasoning_effort',
      },
      contextPolicy: 'full-tool-transcript',
    },
  })),
  ...['kimi-for-coding', 'kimi-for-coding-highspeed'].map(
    (model): ModelReasoningCatalogEntry => ({
      providerKey: 'kimi-coding',
      upstreamFormat: 'openai_chat_completions',
      model,
      capability: {
        activation: enabledFixed,
        ...samplingForbidden,
        requestMapping: { kind: 'none' },
        contextPolicy: 'full-tool-transcript',
      },
    }),
  ),
  {
    providerKey: 'google',
    upstreamFormat: 'gemini_generate_content',
    model: 'gemini-3-pro-preview',
    capability: {
      activation: enabledFixed,
      effort: effortCapability(['low', 'high'], 'high'),
      defaultSelection: { effort: 'high' },
      ...samplingAllowed,
      requestMapping: { kind: 'gemini', mode: 'level' },
      contextPolicy: 'thought-signature',
    },
  },
  {
    providerKey: 'google',
    upstreamFormat: 'gemini_generate_content',
    model: 'gemini-3-flash-preview',
    capability: {
      activation: enabledFixed,
      effort: effortCapability(['minimal', 'low', 'medium', 'high'], 'high'),
      defaultSelection: { effort: 'high' },
      ...samplingAllowed,
      requestMapping: { kind: 'gemini', mode: 'level' },
      contextPolicy: 'thought-signature',
    },
  },
  {
    providerKey: 'google',
    upstreamFormat: 'gemini_generate_content',
    model: 'gemini-2.5-pro',
    capability: {
      activation: enabledFixed,
      budget: {
        supportsAuto: true,
        minimum: 128,
        defaultValue: 'auto',
        configurable: true,
      },
      defaultSelection: { budgetTokens: 'auto' },
      ...samplingAllowed,
      requestMapping: { kind: 'gemini', mode: 'budget' },
      contextPolicy: 'thought-signature',
    },
  },
  {
    providerKey: 'google',
    upstreamFormat: 'gemini_generate_content',
    model: 'gemini-2.5-flash',
    capability: {
      activation: enabledToggle,
      budget: {
        supportsAuto: true,
        minimum: 1,
        defaultValue: 'auto',
        configurable: true,
      },
      defaultSelection: { activation: 'enabled', budgetTokens: 'auto' },
      ...samplingAllowed,
      requestMapping: { kind: 'gemini', mode: 'budget' },
      contextPolicy: 'thought-signature',
    },
  },
  ...['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus'].map(
    (model): ModelReasoningCatalogEntry => ({
      providerKey: 'qwen',
      upstreamFormat: 'openai_chat_completions',
      model,
      capability: {
        activation: enabledToggle,
        budget: {
          supportsAuto: true,
          defaultValue: 'auto',
          configurable: true,
        },
        defaultSelection: { activation: 'enabled', budgetTokens: 'auto' },
        ...samplingAllowed,
        requestMapping: {
          kind: 'openai-compatible',
          activation: 'enable_thinking',
          budget: 'thinking_budget',
        },
        contextPolicy: 'full-tool-transcript',
      },
    }),
  ),
  ...['glm-5.3', 'glm-5.3-flash'].map((model): ModelReasoningCatalogEntry => ({
    providerKey: 'zhipu',
    upstreamFormat: 'openai_chat_completions',
    model,
    capability: {
      activation: enabledFixed,
      effort: effortCapability(['low', 'high', 'max'], 'max'),
      defaultSelection: { effort: 'max' },
      ...samplingAllowed,
      requestMapping: {
        kind: 'openai-compatible',
        effort: 'reasoning_effort',
      },
      contextPolicy: 'full-tool-transcript',
    },
  })),
  {
    providerKey: 'minimax',
    upstreamFormat: 'openai_chat_completions',
    model: 'MiniMax-M3',
    capability: {
      activation: enabledToggle,
      defaultSelection: { activation: 'enabled' },
      ...samplingAllowed,
      requestMapping: {
        kind: 'openai-compatible',
        activation: 'thinking.type',
      },
      contextPolicy: 'full-tool-transcript',
    },
  },
  ...['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'].map(
    (model): ModelReasoningCatalogEntry => ({
      providerKey: 'minimax',
      upstreamFormat: 'openai_chat_completions',
      model,
      capability: {
        activation: enabledFixed,
        ...samplingAllowed,
        requestMapping: { kind: 'none' },
        contextPolicy: 'full-tool-transcript',
      },
    }),
  ),
] as const;

export function findModelReasoningCapability(
  providerKey: string,
  upstreamFormat: LlmUpstreamFormat,
  model: string,
): ModelReasoningCapability | undefined {
  return MODEL_REASONING_CATALOG.find(
    (entry) =>
      entry.providerKey === providerKey &&
      entry.upstreamFormat === upstreamFormat &&
      entry.model === model,
  )?.capability;
}

/** 移除仅服务端使用的请求映射和隐藏上下文策略。 */
export function toReasoningCapabilityProjection(
  capability: ModelReasoningCapability | undefined,
): LlmReasoningCapability | undefined {
  if (!capability) {
    return undefined;
  }
  return {
    ...(capability.activation
      ? {
          activation: {
            ...capability.activation,
            values: [...capability.activation.values],
          },
        }
      : {}),
    ...(capability.effort
      ? {
          effort: {
            ...capability.effort,
            values: [...capability.effort.values],
          },
        }
      : {}),
    ...(capability.budget ? { budget: { ...capability.budget } } : {}),
    ...(capability.defaultSelection
      ? { defaultSelection: { ...capability.defaultSelection } }
      : {}),
    temperaturePolicy: capability.temperaturePolicy,
    topPPolicy: capability.topPPolicy,
  };
}

export interface NormalizeReasoningOptions {
  requireExplicit?: boolean;
  applyDefault?: boolean;
  generation?: LlmGenerationConfig;
}

/**
 * 按精确能力目录规范化并校验一次思考选择。
 * @returns 可调思考模型返回完整选择；固定思考或普通模型返回 undefined
 */
export function normalizeReasoningSelection(
  providerKey: string,
  upstreamFormat: LlmUpstreamFormat,
  model: string,
  selection: ReasoningSelection | undefined,
  options: NormalizeReasoningOptions = {},
): ReasoningSelection | undefined {
  const capability = findModelReasoningCapability(
    providerKey,
    upstreamFormat,
    model,
  );
  if (!capability) {
    if (selection !== undefined) {
      throw new BadRequestException(
        `模型「${model}」没有可配置的思考能力，不能提交 reasoning`,
      );
    }
    return undefined;
  }

  const adjustable = Boolean(
    capability.activation?.configurable ||
    capability.effort?.configurable ||
    capability.budget?.configurable,
  );
  if (!adjustable) {
    if (selection !== undefined) {
      throw new BadRequestException(
        `模型「${model}」的思考模式固定，不能提交 reasoning`,
      );
    }
    validateGenerationPolicy(capability, undefined, options.generation);
    return undefined;
  }

  if (selection === undefined && options.requireExplicit) {
    throw new BadRequestException(`模型「${model}」必须显式配置思考参数`);
  }
  const candidate =
    selection ??
    (options.applyDefault === false ? undefined : capability.defaultSelection);
  if (!candidate) {
    return undefined;
  }

  const normalized: {
    activation?: ReasoningActivation;
    effort?: ReasoningEffort;
    budgetTokens?: number | 'auto';
  } = {};
  const activation = normalizeActivation(
    capability,
    candidate,
    options.requireExplicit === true,
  );
  if (capability.activation?.configurable) {
    normalized.activation = activation;
  } else if (candidate.activation !== undefined) {
    throw new BadRequestException(`模型「${model}」不允许配置思考开关`);
  }

  if (activation === 'disabled') {
    if (
      candidate.effort !== undefined ||
      candidate.budgetTokens !== undefined
    ) {
      throw new BadRequestException('关闭思考时不能同时配置强度或 token 预算');
    }
    validateGenerationPolicy(capability, normalized, options.generation);
    return normalized;
  }

  normalizeEffort(
    capability,
    candidate,
    normalized,
    options.requireExplicit === true,
  );
  normalizeBudget(
    capability,
    candidate,
    normalized,
    options.requireExplicit === true,
    options.generation,
  );
  validateGenerationPolicy(capability, normalized, options.generation);
  return normalized;
}

function normalizeActivation(
  capability: ModelReasoningCapability,
  selection: ReasoningSelection,
  requireExplicit: boolean,
): ReasoningActivation {
  const control = capability.activation;
  if (!control) {
    if (selection.activation !== undefined) {
      throw new BadRequestException('该模型不支持思考开关');
    }
    return 'enabled';
  }
  const value = selection.activation ?? control.defaultValue;
  if (
    control.configurable &&
    requireExplicit &&
    selection.activation === undefined
  ) {
    throw new BadRequestException('思考开关必须显式配置');
  }
  if (!control.values.includes(value)) {
    throw new BadRequestException(`不支持的思考开关值：${value}`);
  }
  return value;
}

function normalizeEffort(
  capability: ModelReasoningCapability,
  selection: ReasoningSelection,
  target: { effort?: ReasoningEffort },
  requireExplicit: boolean,
): void {
  const control = capability.effort;
  if (!control) {
    if (selection.effort !== undefined) {
      throw new BadRequestException('该模型不支持思考强度');
    }
    return;
  }
  if (!control.configurable) {
    if (selection.effort !== undefined) {
      throw new BadRequestException('该模型的思考强度固定，不能修改');
    }
    return;
  }
  if (requireExplicit && selection.effort === undefined) {
    throw new BadRequestException('思考强度必须显式配置');
  }
  const value = selection.effort ?? control.defaultValue;
  if (!control.values.includes(value)) {
    throw new BadRequestException(`不支持的思考强度：${value}`);
  }
  target.effort = value;
}

function normalizeBudget(
  capability: ModelReasoningCapability,
  selection: ReasoningSelection,
  target: { budgetTokens?: number | 'auto' },
  requireExplicit: boolean,
  generation?: LlmGenerationConfig,
): void {
  const control = capability.budget;
  if (!control) {
    if (selection.budgetTokens !== undefined) {
      throw new BadRequestException('该模型不支持思考 token 预算');
    }
    return;
  }
  if (!control.configurable) {
    if (selection.budgetTokens !== undefined) {
      throw new BadRequestException('该模型的思考 token 预算固定，不能修改');
    }
    return;
  }
  if (requireExplicit && selection.budgetTokens === undefined) {
    throw new BadRequestException('思考 token 预算必须显式配置');
  }
  const value = selection.budgetTokens ?? control.defaultValue;
  if (value === 'auto') {
    if (!control.supportsAuto) {
      throw new BadRequestException('该模型不支持自动思考预算');
    }
    target.budgetTokens = value;
    return;
  }
  if (control.minimum === undefined) {
    throw new BadRequestException('该模型只支持自动思考预算');
  }
  if (
    value < control.minimum ||
    (control.maximum !== undefined && value > control.maximum)
  ) {
    throw new BadRequestException(
      `思考 token 预算必须在 ${control.minimum} 到 ${control.maximum ?? '模型上限'} 之间`,
    );
  }
  if (
    control.lessThanMaxOutputTokens &&
    (generation?.maxOutputTokens === undefined ||
      value >= generation.maxOutputTokens)
  ) {
    throw new BadRequestException('思考 token 预算必须小于最大输出 token');
  }
  target.budgetTokens = value;
}

function validateGenerationPolicy(
  capability: ModelReasoningCapability,
  selection: ReasoningSelection | undefined,
  generation?: LlmGenerationConfig,
): void {
  const enabled =
    capability.activation?.configurable === false ||
    selection?.activation === 'enabled' ||
    selection?.activation === 'auto' ||
    (selection?.activation === undefined &&
      capability.activation === undefined);
  assertGenerationField(
    'temperature',
    generation?.temperature,
    capability.temperaturePolicy,
    enabled,
  );
  assertGenerationField(
    'topP',
    generation?.topP,
    capability.topPPolicy,
    enabled,
  );
}

function assertGenerationField(
  field: 'temperature' | 'topP',
  value: number | undefined,
  policy: LlmReasoningCapability['temperaturePolicy'],
  reasoningEnabled: boolean,
): void {
  if (
    value !== undefined &&
    (policy === 'forbidden' ||
      (policy === 'forbidden_when_enabled' && reasoningEnabled))
  ) {
    throw new BadRequestException(`当前思考配置不允许设置 ${field}`);
  }
}

/** 生成不包含正文的稳定配置指纹，供隐藏上下文兼容性判断。 */
export function createReasoningFingerprint(
  providerKey: string,
  upstreamFormat: LlmUpstreamFormat,
  model: string,
  selection: ReasoningSelection | undefined,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        providerKey,
        upstreamFormat,
        model,
        selection: selection ?? null,
      }),
    )
    .digest('hex');
}
