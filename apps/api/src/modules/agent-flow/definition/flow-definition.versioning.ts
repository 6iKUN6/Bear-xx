import {
  AGENT_FLOW_SCHEMA_VERSION,
  flowLoopRegions,
  type FlowDefinition,
  type FlowNode,
  type FlowNodeLayout,
} from '@litter-bear/types/agent-flow';
import {
  FlowDefinitionV9Schema,
  FlowDefinitionV10Schema,
} from './flow-definition.schema';
import { calculateFlowDefinitionDigest } from './flow-definition.digest';
import {
  parseFlowDefinitionStructure,
  validateFlowDefinition,
  validateGraphStructure,
  type FlowDefinitionValidationError,
} from './flow-definition.validator';

/** 当前控制面识别的 Definition 版本状态。 */
export type FlowSchemaStatus =
  'current' | 'upgradeable' | 'invalid' | 'unsupported';

/** 历史 Definition 升级产生的可审计摘要。 */
export interface FlowDefinitionUpgradeReport {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly loopAssignments: readonly {
    readonly nodeId: string;
    readonly loopId: string;
  }[];
  readonly relativeLayoutNodeIds: readonly string[];
}

/** 一份工件的版本识别结果。 */
export interface FlowDefinitionInspection {
  readonly status: FlowSchemaStatus;
  readonly sourceVersion: number | null;
  readonly targetVersion: number | null;
  readonly errors: readonly FlowDefinitionValidationError[];
  readonly definition?: FlowDefinition;
  readonly report?: FlowDefinitionUpgradeReport;
}

/** Loop 容器迁移使用的确定性几何常量。 */
const LOOP_LAYOUT = {
  nodeWidth: 192,
  nodeHeight: 72,
  padding: 24,
  headerHeight: 48,
  minWidth: 360,
  minHeight: 220,
} as const;

/**
 * 识别并在可能时规范化任意版本的 Flow Definition
 * @param input 数据库工件或外部导入的未知 JSON
 * @returns 返回版本状态；current/upgradeable 同时带当前 v11 Definition
 * @description 当前版本只做结构识别，完整图错误由发布校验负责；v9/v10 必须先按历史语义
 * 完整合法，且迁移结果也完整合法，才标记为 upgradeable。v1-v8 与未来版本不猜测升级。
 */
export function inspectFlowDefinition(
  input: unknown,
): FlowDefinitionInspection {
  const sourceVersion = readSchemaVersion(input);
  if (sourceVersion === AGENT_FLOW_SCHEMA_VERSION) {
    const parsed = parseFlowDefinitionStructure(input);
    return parsed.success
      ? {
          status: 'current',
          sourceVersion,
          targetVersion: AGENT_FLOW_SCHEMA_VERSION,
          errors: [],
          definition: parsed.definition,
        }
      : {
          status: 'invalid',
          sourceVersion,
          targetVersion: null,
          errors: parsed.errors,
        };
  }

  if (sourceVersion === 10) {
    if (hasNonEmptyLegacyContinueWhen(input)) {
      return legacyLoopMigrationRequired(sourceVersion);
    }
    const legacy = FlowDefinitionV10Schema.safeParse(input);
    if (!legacy.success) {
      return {
        status: 'invalid',
        sourceVersion,
        targetVersion: null,
        errors: legacy.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.') || '$',
          rule: 'schema',
          message: `字段格式不合法：${issue.message}`,
        })),
      };
    }
    const normalized = {
      ...legacy.data,
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    };
    const validated = validateFlowDefinition(normalized);
    if (!validated.success) {
      return {
        status: 'invalid',
        sourceVersion,
        targetVersion: null,
        errors: validated.errors,
      };
    }
    return {
      status: 'upgradeable',
      sourceVersion,
      targetVersion: AGENT_FLOW_SCHEMA_VERSION,
      errors: [],
      definition: validated.definition,
      report: {
        fromVersion: 10,
        toVersion: AGENT_FLOW_SCHEMA_VERSION,
        loopAssignments: [],
        relativeLayoutNodeIds: [],
      },
    };
  }

  if (sourceVersion !== 9) {
    return {
      status: sourceVersion === null ? 'invalid' : 'unsupported',
      sourceVersion,
      targetVersion: null,
      errors: [
        {
          path: 'schemaVersion',
          rule: sourceVersion === null ? 'schema' : 'unsupported-version',
          message:
            sourceVersion === null
              ? 'FlowDefinition 缺少整数 schemaVersion'
              : `暂不支持 schemaVersion ${sourceVersion}，当前只支持 v9/v10 到 v11 的升级`,
        },
      ],
    };
  }

  if (hasNonEmptyLegacyContinueWhen(input)) {
    return legacyLoopMigrationRequired(sourceVersion);
  }

  const legacy = FlowDefinitionV9Schema.safeParse(input);
  if (!legacy.success) {
    return {
      status: 'invalid',
      sourceVersion,
      targetVersion: null,
      errors: legacy.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '$',
        rule: 'schema',
        message: `字段格式不合法：${issue.message}`,
      })),
    };
  }

  const legacyAsCurrent: FlowDefinition = {
    ...legacy.data,
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    nodes: legacy.data.nodes.map(removeLoopId),
    ...(legacy.data.layout
      ? {
          layout: {
            nodes: Object.fromEntries(
              Object.entries(legacy.data.layout.nodes).map(
                ([nodeId, layout]) => [nodeId, { x: layout.x, y: layout.y }],
              ),
            ),
          },
        }
      : {}),
  };
  const legacyErrors = validateGraphStructure(legacyAsCurrent, {
    validateLoopOwnership: false,
  });
  if (legacyErrors.length > 0) {
    return {
      status: 'invalid',
      sourceVersion,
      targetVersion: null,
      errors: legacyErrors,
    };
  }

  const migrated = migrateV9ToV10(legacyAsCurrent);
  const validated = validateFlowDefinition(migrated.definition);
  if (!validated.success) {
    return {
      status: 'invalid',
      sourceVersion,
      targetVersion: null,
      errors: validated.errors,
    };
  }
  return {
    status: 'upgradeable',
    sourceVersion,
    targetVersion: AGENT_FLOW_SCHEMA_VERSION,
    errors: [],
    definition: validated.definition,
    report: migrated.report,
  };
}

/**
 * 读取可执行的当前 Definition
 * @param input 数据库中锁定的 Flow 工件
 * @returns current/upgradeable 且完整合法时返回当前 Definition，否则返回明确错误
 * @description 运行时只消费这一入口，不直接分支维护 v9/v10 编译器。
 */
export function normalizeFlowDefinition(input: unknown):
  | {
      readonly success: true;
      readonly definition: FlowDefinition;
      /** 按源版本 schema 解析后、迁移前计算的原工件摘要。 */
      readonly sourceDigest: string;
      readonly inspection: FlowDefinitionInspection;
    }
  | {
      readonly success: false;
      readonly inspection: FlowDefinitionInspection;
    } {
  const inspection = inspectFlowDefinition(input);
  if (!inspection.definition) return { success: false, inspection };
  const validated = validateFlowDefinition(inspection.definition);
  if (!validated.success) {
    return {
      success: false,
      inspection: {
        ...inspection,
        status: 'invalid',
        errors: validated.errors,
      },
    };
  }
  return {
    success: true,
    definition: validated.definition,
    sourceDigest: calculateInspectedSourceDigest(input, inspection),
    inspection,
  };
}

/**
 * 计算已成功识别工件的源版本摘要
 * @param input 数据库中的原始 Definition 工件
 * @param inspection 已成功产出当前内存模型的版本检查结果
 * @returns 返回迁移前的源工件摘要
 * @description 当前版本使用已解析对象；v9/v10 使用数据库中的原始工件计算，绝不对迁移后的
 * v11 内存对象计算历史摘要。调用方只在 inspection.definition 存在时进入，因此失败表示内部
 * 版本分支与检查器发生漂移，应直接抛错而不能返回默认摘要。
 */
function calculateInspectedSourceDigest(
  input: unknown,
  inspection: FlowDefinitionInspection,
): string {
  if (inspection.sourceVersion === AGENT_FLOW_SCHEMA_VERSION) {
    return calculateFlowDefinitionDigest(inspection.definition!);
  }
  if (inspection.sourceVersion === 9 || inspection.sourceVersion === 10) {
    // 迁移 schema 会把 continueWhen 解析投影为 breakWhen；摘要必须基于数据库中原始工件，
    // 否则任务快照校验会把字段规范化误判为 Definition 被篡改。
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      return calculateFlowDefinitionDigest(input);
    }
  }
  throw new Error('Flow Definition 源版本摘要计算分支缺失');
}

/**
 * 检查历史工件是否包含不能直接改名迁移的 Loop 条件
 * @param input 数据库工件或导入 JSON
 * @returns 任一 Loop 的 continueWhen 为非空数组时返回 true
 * @description 只读原始字段，必须在 legacy schema 把字段投影为 breakWhen 之前执行。
 */
function hasNonEmptyLegacyContinueWhen(input: unknown): boolean {
  if (!isRecord(input)) {
    return false;
  }
  const nodes = input.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some((rawNode) => {
    if (!isRecord(rawNode) || rawNode.type !== 'loop') return false;
    const config = rawNode.config;
    if (!isRecord(config)) return false;
    const continueWhen = config.continueWhen;
    return Array.isArray(continueWhen) && continueWhen.length > 0;
  });
}

/**
 * 判断未知值是否为普通记录
 * @param value 待收窄的未知值
 * @returns 非空、非数组对象时返回 true
 * @description 用于只读历史 JSON 字段，不修改对象或接受兼容字段。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 构造历史 Loop 条件需要人工迁移的版本检查结果
 * @param version 原工件 schemaVersion
 * @returns 返回带稳定规则名和人工处理说明的 invalid 结果
 * @description 非空 continueWhen 不能通过字段改名或逐条取反证明等价，因此不产出升级 Definition。
 */
function legacyLoopMigrationRequired(
  version: number,
): FlowDefinitionInspection {
  return {
    status: 'invalid',
    sourceVersion: version,
    targetVersion: null,
    errors: [
      {
        path: 'nodes',
        rule: 'loop-condition-migration',
        message:
          '旧版 continueWhen 非空，无法在现有条件闭集内证明与 breakWhen 等价，请人工编辑后创建 v11 草稿',
      },
    ],
  };
}

/**
 * 将合法 v9 图确定性迁移为 v10 容器契约
 * @param definition 已按 v9 规则验证、但版本号临时投影为当前值的 Definition
 * @returns 返回当前 v11 Definition 与节点归属、坐标变化摘要
 * @description 只依据工件自身拓扑与布局计算，不读取时间、数据库、窗口或随机数。
 */
function migrateV9ToV10(definition: FlowDefinition): {
  readonly definition: FlowDefinition;
  readonly report: FlowDefinitionUpgradeReport;
} {
  const regions = flowLoopRegions(definition.nodes, definition.edges);
  const ownerByNode = new Map<string, string>();
  for (const region of regions.values()) {
    for (const nodeId of region.body) ownerByNode.set(nodeId, region.loopId);
  }
  const loopAssignments = [...ownerByNode.entries()]
    .map(([nodeId, loopId]) => ({ nodeId, loopId }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const nodes: FlowNode[] = definition.nodes.map((node) => {
    const loopId = ownerByNode.get(node.id);
    return loopId ? { ...node, loopId } : node;
  });
  const layoutResult = migrateLoopLayout(definition, regions);
  return {
    definition: {
      ...definition,
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
      nodes,
      ...(layoutResult.layout ? { layout: layoutResult.layout } : {}),
    },
    report: {
      fromVersion: 9,
      toVersion: AGENT_FLOW_SCHEMA_VERSION,
      loopAssignments,
      relativeLayoutNodeIds: layoutResult.relativeNodeIds,
    },
  };
}

/**
 * 把循环体绝对坐标转换为容器相对坐标
 * @param definition 已验证的 v9 Definition
 * @param regions v9 技术边推导出的循环区域
 * @returns 返回迁移后的布局与发生坐标转换的节点列表
 * @description 只有一个循环体的全部节点都有坐标时才转换该容器；缺坐标时保留原布局，交给
 * Admin 自动排布，避免凭空生成与用户画布无关的位置。
 */
function migrateLoopLayout(
  definition: FlowDefinition,
  regions: ReturnType<typeof flowLoopRegions>,
): {
  readonly layout: FlowDefinition['layout'];
  readonly relativeNodeIds: readonly string[];
} {
  if (!definition.layout) return { layout: undefined, relativeNodeIds: [] };
  const layouts: Record<string, FlowNodeLayout> = {
    ...definition.layout.nodes,
  };
  const relativeNodeIds: string[] = [];
  for (const region of [...regions.values()].sort((left, right) =>
    left.loopId.localeCompare(right.loopId),
  )) {
    const memberIds = [...region.body].sort();
    const memberLayouts = memberIds.map((nodeId) => layouts[nodeId]);
    if (memberIds.length === 0 || memberLayouts.some((item) => !item)) continue;

    const minX = Math.min(...memberLayouts.map((item) => item.x));
    const minY = Math.min(...memberLayouts.map((item) => item.y));
    const maxX = Math.max(...memberLayouts.map((item) => item.x));
    const maxY = Math.max(...memberLayouts.map((item) => item.y));
    const containerX = minX - LOOP_LAYOUT.padding;
    const containerY = minY - LOOP_LAYOUT.headerHeight - LOOP_LAYOUT.padding;
    layouts[region.loopId] = {
      x: containerX,
      y: containerY,
      width: Math.max(
        LOOP_LAYOUT.minWidth,
        maxX - minX + LOOP_LAYOUT.nodeWidth + LOOP_LAYOUT.padding * 2,
      ),
      height: Math.max(
        LOOP_LAYOUT.minHeight,
        maxY -
          minY +
          LOOP_LAYOUT.nodeHeight +
          LOOP_LAYOUT.headerHeight +
          LOOP_LAYOUT.padding * 2,
      ),
      collapsed: false,
    };
    memberIds.forEach((nodeId) => {
      const current = layouts[nodeId];
      layouts[nodeId] = {
        x: current.x - containerX,
        y: current.y - containerY,
      };
      relativeNodeIds.push(nodeId);
    });
  }
  return {
    layout: { nodes: layouts },
    relativeNodeIds: relativeNodeIds.sort(),
  };
}

/** 删除历史解析结果类型中仅由当前契约声明的归属字段。 */
function removeLoopId(node: FlowNode): FlowNode {
  const { loopId: _loopId, ...legacyNode } = node;
  return legacyNode;
}

/** 从未知 JSON 根对象中读取整数 schemaVersion。 */
function readSchemaVersion(input: unknown): number | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  const value: unknown = Reflect.get(input, 'schemaVersion');
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
