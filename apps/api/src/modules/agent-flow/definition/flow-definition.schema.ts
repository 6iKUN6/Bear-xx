import {
  AGENT_FLOW_SCHEMA_VERSION,
  FLOW_CONDITION_OPERATORS,
  type FlowConditionOperator,
} from '@litter-bear/types/agent-flow';
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
  /** 单个 condition 节点允许声明的最大 case 数。 */
  conditionCaseCount: 16,
  /** 单个 case 内允许声明的最大判定条件数。 */
  conditionPredicateCount: 16,
  /** 条件比较值的最大字符数。 */
  conditionValueLength: 500,
  /** 节点显示名的最大字符数。 */
  nodeNameLength: 60,
  /** 单个 join 节点允许等待的最大分支数。 */
  joinWaitForCount: 16,
} as const;

const NODE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const BRANCH_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const OUTPUT_FIELD_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

const nodeIdSchema = z.string().regex(NODE_ID_PATTERN);
const nonEmptyKeySchema = z.string().trim().min(1).max(100);
const branchKeySchema = z.string().regex(BRANCH_KEY_PATTERN);

/**
 * 所有节点共有的字段
 * @description 以对象展开复用而不是 z.object().extend()：discriminatedUnion 要求每个成员的
 * `type` 是字面量，展开写法最直白，也不会因为 extend 链让报错路径变难读。
 * `name` 是面向人的显示名，可用中文，与作为机器标识的 `id` 职责分开。
 */
const nodeBaseShape = {
  id: nodeIdSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(FLOW_DEFINITION_LIMITS.nodeNameLength)
    .optional(),
};

// 算子清单只从 FLOW_CONDITION_OPERATORS 派生：另写一份 z.enum 字面量就会有第二个源，
// 加算子时漏改一处不会有任何工具报错。Object.keys 的静态类型是 string[]，
// 而该 map 的键就是算子联合本身，这里只是把这个事实告诉编译器。
const conditionOperatorSchema = z.enum(
  Object.keys(FLOW_CONDITION_OPERATORS) as [
    FlowConditionOperator,
    ...FlowConditionOperator[],
  ],
);

/** 结构化变量引用；来源可以是节点标识或 Flow 级根变量。 */
const flowRefSchema = z
  .object({
    $ref: z.tuple([nodeIdSchema, z.string().regex(OUTPUT_FIELD_PATTERN)]),
  })
  .strict();

const conditionCaseSchema = z
  .object({
    key: branchKeySchema,
    logic: z.enum(['and', 'or']),
    conditions: z
      .array(
        z
          .object({
            ref: flowRefSchema,
            operator: conditionOperatorSchema,
            value: z
              .union([
                z.string().max(FLOW_DEFINITION_LIMITS.conditionValueLength),
                z.number().finite(),
                z.boolean(),
              ])
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(FLOW_DEFINITION_LIMITS.conditionPredicateCount),
  })
  .strict();

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
      ...nodeBaseShape,
      type: z.literal('start'),
      config: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...nodeBaseShape,
      type: z.literal('agent'),
      config: agentNodeConfigSchema,
    })
    .strict(),
  z
    .object({
      ...nodeBaseShape,
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
      ...nodeBaseShape,
      type: z.literal('plan-loop'),
      config: z
        .object({
          executor: agentNodeConfigSchema
            .extend({ type: z.literal('agent') })
            .strict(),
          stopPolicy: z.enum(['all-steps', 'evaluate-after-step']),
          planRef: flowRefSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nodeBaseShape,
      type: z.literal('approval'),
      config: z
        .object({
          kind: z.literal('plan-review'),
          policy: z.enum(['always', 'never', 'model']),
          planRef: flowRefSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nodeBaseShape,
      type: z.literal('synthesize'),
      config: z.object({ observationsRef: flowRefSchema.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...nodeBaseShape,
      type: z.literal('join'),
      config: z
        .object({
          waitFor: z
            .array(nodeIdSchema)
            .min(1)
            .max(FLOW_DEFINITION_LIMITS.joinWaitForCount),
          policy: z.enum(['all', 'any']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nodeBaseShape,
      type: z.literal('condition'),
      config: z
        .object({
          cases: z
            .array(conditionCaseSchema)
            .min(1)
            .max(FLOW_DEFINITION_LIMITS.conditionCaseCount),
        })
        .strict(),
    })
    .strict(),
]);

/** 当前 schemaVersion 的 FlowDefinition JSON 解析 Schema。 */
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
            when: branchKeySchema.optional(),
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
