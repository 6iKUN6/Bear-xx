import { AGENT_FLOW_SCHEMA_VERSION } from '@litter-bear/types/agent-flow';
import { z } from 'zod';

/** FlowDefinition 的服务端安全上限。 */
export const FLOW_DEFINITION_LIMITS = {
  /** Flow 名称的最大字符数。 */
  nameLength: 100,
  /** Flow 描述的最大字符数。 */
  descriptionLength: 2_000,
  /** 单个 Flow 图允许包含的最大节点数。 */
  nodeCount: 64,
  /** 单个 Flow 图允许包含的最大边数。 */
  edgeCount: 128,
  /** 单次计划允许生成的最大步骤数。 */
  maxSteps: 24,
  /** 单次 Flow 执行允许发起的最大模型调用次数。 */
  maxModelCalls: 64,
  /** 单次 Flow 执行允许发起的最大工具调用次数。 */
  maxToolCalls: 128,
  /** 单次 Flow 执行允许持续的最大时长，单位为秒。 */
  maxDurationSeconds: 3_600,
  /** 单个 Agent 节点允许连续执行的最大工具调用轮数。 */
  maxToolIterations: 16,
  /** 画布节点坐标轴允许的绝对值上限。 */
  layoutCoordinate: 100_000,
} as const;

const NODE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const nodeIdSchema = z.string().regex(NODE_ID_PATTERN);
const nonEmptyKeySchema = z.string().trim().min(1).max(100);

const agentNodeConfigSchema = z
  .object({
    modelPreset: nonEmptyKeySchema.optional(),
    toolGroups: z.array(nonEmptyKeySchema).max(32),
    skills: z.array(nonEmptyKeySchema).max(32),
    maxToolIterations: z
      .number()
      .int()
      .min(1)
      .max(FLOW_DEFINITION_LIMITS.maxToolIterations),
  })
  .strict();

const flowNodeSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: nodeIdSchema,
      type: z.literal('agent'),
      config: agentNodeConfigSchema,
    })
    .strict(),
  z
    .object({
      id: nodeIdSchema,
      type: z.literal('plan'),
      config: z
        .object({
          maxSteps: z
            .number()
            .int()
            .min(1)
            .max(FLOW_DEFINITION_LIMITS.maxSteps),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: nodeIdSchema,
      type: z.literal('plan-loop'),
      config: z
        .object({
          executor: agentNodeConfigSchema
            .extend({ type: z.literal('agent') })
            .strict(),
          stopPolicy: z.enum(['all-steps', 'evaluate-after-step']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: nodeIdSchema,
      type: z.literal('approval'),
      config: z.object({ kind: z.literal('plan-review') }).strict(),
    })
    .strict(),
  z
    .object({
      id: nodeIdSchema,
      type: z.literal('condition'),
      config: z
        .object({
          field: nonEmptyKeySchema,
          operator: z.enum(['equals', 'not-equals', 'exists']),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: nodeIdSchema,
      type: z.literal('synthesize'),
      config: z.object({}).strict(),
    })
    .strict(),
]);

/** `schemaVersion=1` 的 FlowDefinition JSON 解析 Schema。 */
export const FlowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(AGENT_FLOW_SCHEMA_VERSION),
    kind: z.literal('agent-flow'),
    name: z.string().trim().min(1).max(FLOW_DEFINITION_LIMITS.nameLength),
    description: z
      .string()
      .trim()
      .max(FLOW_DEFINITION_LIMITS.descriptionLength)
      .optional(),
    policy: z
      .object({
        maxSteps: z.number().int().min(1).max(FLOW_DEFINITION_LIMITS.maxSteps),
        maxModelCalls: z
          .number()
          .int()
          .min(1)
          .max(FLOW_DEFINITION_LIMITS.maxModelCalls),
        maxToolCalls: z
          .number()
          .int()
          .min(0)
          .max(FLOW_DEFINITION_LIMITS.maxToolCalls),
        maxDurationSeconds: z
          .number()
          .int()
          .min(1)
          .max(FLOW_DEFINITION_LIMITS.maxDurationSeconds),
      })
      .strict(),
    nodes: z.array(flowNodeSchema).min(1).max(FLOW_DEFINITION_LIMITS.nodeCount),
    edges: z
      .array(
        z
          .object({
            from: nodeIdSchema,
            to: nodeIdSchema,
            when: z.enum(['approved', 'true', 'false']).optional(),
          })
          .strict(),
      )
      .max(FLOW_DEFINITION_LIMITS.edgeCount),
    layout: z
      .object({
        nodes: z
          .record(
            nodeIdSchema,
            z
              .object({
                x: z
                  .number()
                  .finite()
                  .min(-FLOW_DEFINITION_LIMITS.layoutCoordinate)
                  .max(FLOW_DEFINITION_LIMITS.layoutCoordinate),
                y: z
                  .number()
                  .finite()
                  .min(-FLOW_DEFINITION_LIMITS.layoutCoordinate)
                  .max(FLOW_DEFINITION_LIMITS.layoutCoordinate),
              })
              .strict(),
          )
          .superRefine((nodes, context) => {
            if (Object.keys(nodes).length > FLOW_DEFINITION_LIMITS.nodeCount) {
              context.addIssue({
                code: 'custom',
                message: `画布节点数不能超过 ${FLOW_DEFINITION_LIMITS.nodeCount}`,
              });
            }
          }),
      })
      .strict()
      .optional(),
  })
  .strict();
