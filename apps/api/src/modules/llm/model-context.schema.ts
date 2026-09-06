import { z } from 'zod';

import type { LlmUpstreamFormat } from './llm.types';
import type { ModelContextPolicy } from './model-reasoning.catalog';

const jsonObjectSchema = z.record(z.string(), z.json());

const toolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    args: jsonObjectSchema,
  })
  .strict();

const toolResultSchema = z
  .object({
    role: z.literal('tool'),
    content: z.string(),
    toolCallId: z.string().min(1),
    name: z.string().min(1).optional(),
    status: z.enum(['success', 'error']).optional(),
  })
  .strict();

const openAiAssistantSchema = z
  .object({
    role: z.literal('assistant'),
    content: z.string(),
    reasoningContent: z.string().optional(),
    toolCalls: z.array(toolCallSchema),
  })
  .strict();

const anthropicContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('thinking'),
      thinking: z.string(),
      signature: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('redacted_thinking'),
      data: z.string().min(1),
    })
    .strict(),
]);

const anthropicAssistantSchema = z
  .object({
    role: z.literal('assistant'),
    content: z.array(anthropicContentBlockSchema),
    toolCalls: z.array(toolCallSchema),
  })
  .strict();

const geminiContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('thinking'),
      thinking: z.string(),
      signature: z.string().min(1).optional(),
    })
    .strict(),
]);

const geminiAssistantSchema = z
  .object({
    role: z.literal('assistant'),
    content: z.array(geminiContentBlockSchema),
    toolCalls: z.array(toolCallSchema),
    thoughtSignatures: z.record(z.string(), z.string().min(1)),
  })
  .strict();

const envelopeIdentityShape = {
  version: z.literal(1),
  providerKey: z.string().min(1),
  upstreamFormat: z.enum([
    'openai_chat_completions',
    'openai_responses',
    'anthropic_messages',
    'gemini_generate_content',
  ]),
  model: z.string().min(1),
  reasoningFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};

/** Message.modelContext 的严格版本化 schema；额外字段一律拒绝。 */
export const modelContextEnvelopeSchema = z.discriminatedUnion('policy', [
  z
    .object({
      ...envelopeIdentityShape,
      policy: z.literal('assistant-reasoning'),
      payload: z
        .object({
          messages: z.array(
            z.union([anthropicAssistantSchema, toolResultSchema]),
          ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelopeIdentityShape,
      policy: z.literal('full-tool-transcript'),
      payload: z
        .object({
          messages: z.array(z.union([openAiAssistantSchema, toolResultSchema])),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelopeIdentityShape,
      policy: z.literal('thought-signature'),
      payload: z
        .object({
          messages: z.array(z.union([geminiAssistantSchema, toolResultSchema])),
        })
        .strict(),
    })
    .strict(),
]);

export type ModelContextEnvelope = z.infer<typeof modelContextEnvelopeSchema>;

export interface ModelContextIdentity {
  providerKey: string;
  upstreamFormat: LlmUpstreamFormat;
  model: string;
  reasoningFingerprint: string;
  policy: Exclude<ModelContextPolicy, 'none'>;
}

/** 严格解析数据库中的隐藏模型上下文。 */
export function parseModelContextEnvelope(
  value: unknown,
): ModelContextEnvelope {
  return modelContextEnvelopeSchema.parse(value);
}

/** 判断已验证信封是否可交给本次精确模型配置回放。 */
export function isCompatibleModelContext(
  context: ModelContextEnvelope,
  identity: ModelContextIdentity,
): boolean {
  return (
    context.providerKey === identity.providerKey &&
    context.upstreamFormat === identity.upstreamFormat &&
    context.model === identity.model &&
    context.reasoningFingerprint === identity.reasoningFingerprint &&
    context.policy === identity.policy
  );
}
