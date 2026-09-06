import { z } from 'zod';

import type {
  PersistedReasoningConfig,
  ReasoningSelection,
} from '@litter-bear/types';

export const REASONING_EFFORT_VALUES = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/** 请求和 Flow Definition 共用的严格思考选择 schema。 */
export const reasoningSelectionSchema: z.ZodType<ReasoningSelection> = z
  .object({
    activation: z.enum(['enabled', 'disabled', 'auto']).optional(),
    effort: z.enum(REASONING_EFFORT_VALUES).optional(),
    budgetTokens: z
      .union([z.number().int().positive(), z.literal('auto')])
      .optional(),
  })
  .strict();

/** Prisma JSON 列中的版本化思考配置 schema。 */
export const persistedReasoningConfigSchema: z.ZodType<PersistedReasoningConfig> =
  z
    .object({
      version: z.literal(1),
      selection: reasoningSelectionSchema,
    })
    .strict();
