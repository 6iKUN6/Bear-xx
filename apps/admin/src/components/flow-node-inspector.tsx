import type { ReactNode } from "react";
import {
  FLOW_CONDITION_OPERATORS,
  type FlowConditionOperator,
  type FlowValueType,
} from "@litter-bear/types/agent-flow";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { branchKeysOf, type EditableNode } from "@/lib/flow-edit";
import {
  branchLabel,
  nodeOutputEntries,
  nodeTypeMeta,
  variableOptions,
  type CanvasDefinition,
  type FlowVariableOption,
} from "@/lib/flow-graph";

/** 可编辑时需要的能力闭集与回调。 */
export interface InspectorEditing {
  /**
   * 工具组闭集，来自 /admin 的能力接口，不在前端硬编码
   * @description 没有 skills：admin API 目前不暴露技能闭集，因此技能只能自由输入。
   */
  capabilities: { toolGroups: string[] };
  /** 提交整份新 config */
  onChangeConfig: (config: Record<string, unknown>) => void;
  /** 改 condition 的 case 键；要连带改引用它的边，因此走单独回调 */
  onRenameCase: (oldKey: string, newKey: string) => void;
  /** 设置节点显示名；传空串即清除，界面回退显示 id */
  onChangeName: (name: string) => void;
  onDeleteNode: () => void;
}

interface FlowNodeInspectorProps {
  node: EditableNode;
  definition: CanvasDefinition;
  /** 校验返回的、路径落在本节点内的错误 */
  errors: Array<{ path: string; rule: string; message: string }>;
  /** 缺省即只读 */
  editing?: InspectorEditing;
}

/**
 * 选中节点的配置面板
 * @param props 节点、当前定义、校验错误与可选的编辑能力
 * @returns 返回右侧面板内容
 * @description 传入 editing 才可改，否则纯展示——给出能填但存不下去的表单等于让人白填。
 * 变量选择器的可选项来自共享 `flowDominators`，与服务端 `ref-dominates` 同一判据，
 * 不列后端注定拒绝的选项。
 */
export function FlowNodeInspector({
  node,
  definition,
  errors,
  editing,
}: FlowNodeInspectorProps) {
  const meta = nodeTypeMeta(node.type);
  const outputs = nodeOutputEntries(node.type);
  const branches = branchKeysOf(node);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          {/* 标题用别名、缺省回退 id；徽章是节点类型，中英并列避免和标识混为一谈 */}
          <h2 className="truncate text-sm font-semibold text-foreground">
            {node.name || node.id}
          </h2>
          <Badge variant="secondary" title={`节点类型：${meta.type}`}>
            {meta.name}
            <span className="ml-1 font-mono opacity-70">{meta.type}</span>
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{meta.desc}</p>
      </div>

      <InspectorSection title="标识与别名">
        <div className="space-y-2">
          <Field
            label="别名"
            hint="只影响画布与列表的显示，可用中文；留空则显示下面的标识"
          >
            {editing ? (
              <Input
                value={node.name ?? ""}
                placeholder={node.id}
                maxLength={60}
                onChange={(event) => editing.onChangeName(event.target.value)}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                {node.name || "未设置"}
              </p>
            )}
          </Field>
          <Field
            label="标识"
            hint="机器标识，被连线与变量引用（$ref）使用，因此不在画布里改"
          >
            <p className="font-mono text-xs text-foreground">{node.id}</p>
          </Field>
        </div>
      </InspectorSection>

      {errors.length > 0 ? (
        <section className="rounded-md border border-[var(--lb-danger)] bg-[var(--lb-danger-soft)] px-3 py-2">
          <h3 className="text-xs font-medium text-foreground">
            本节点校验未通过
          </h3>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {errors.map((error) => (
              <li key={`${error.path}:${error.rule}`}>
                <span className="font-mono">{error.rule}</span> {error.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <InspectorSection title="出边分支">
        <div className="flex flex-wrap gap-1">
          {branches.map((branch) => (
            <Badge key={branch} variant="outline">
              {branchLabel(branch) || branch}
            </Badge>
          ))}
        </div>
      </InspectorSection>

      <InspectorSection title="声明输出">
        {outputs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            该节点不产生输出，只决定走哪条边
          </p>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {outputs.map((output) => (
              <li key={output.field} className="text-muted-foreground">
                <span className="font-mono text-foreground">
                  {node.id}.{output.field}
                </span>
                （{output.valueType}）
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>

      <NodeConfig node={node} definition={definition} editing={editing} />

      {editing && node.type !== "start" ? (
        <Button
          variant="outline"
          size="sm"
          className="w-full text-[var(--lb-danger)]"
          onClick={editing.onDeleteNode}
        >
          <Trash2 className="h-4 w-4" />
          删除节点
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 按节点类型渲染配置
 * @param props 节点、当前定义与可选编辑能力
 * @returns 返回该类型专属的配置区
 * @description 未登记的类型退回原始 JSON，不显示空面板——空面板会让人以为节点没有配置。
 */
function NodeConfig({
  node,
  definition,
  editing,
}: {
  node: EditableNode;
  definition: CanvasDefinition;
  editing?: InspectorEditing;
}) {
  if (node.type === "start") {
    return (
      <InspectorSection title="配置">
        <p className="text-xs text-muted-foreground">
          无需配置。它的 <span className="font-mono">text</span>{" "}
          输出是用户本轮消息，下游节点可直接引用。
        </p>
      </InspectorSection>
    );
  }

  if (node.type === "agent") {
    return (
      <InspectorSection title="配置">
        <ExecutorFields
          executor={node.config}
          editing={editing}
          onChange={(next) => editing?.onChangeConfig(next)}
        />
      </InspectorSection>
    );
  }

  if (node.type === "plan-loop") {
    const executor = asRecord(node.config.executor) ?? {};
    return (
      <InspectorSection title="配置">
        <div className="space-y-2">
          <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
            循环在**节点内部**：由 Workflow 反复调度同一节点逐步推进，步数上限取
            policy.maxSteps。图上没有回边，也画不出回边。
          </p>
          <Field label="停止策略">
            <Select
              value={
                node.config.stopPolicy === "evaluate-after-step"
                  ? "evaluate-after-step"
                  : "all-steps"
              }
              disabled={!editing}
              onValueChange={(value) =>
                editing?.onChangeConfig({ ...node.config, stopPolicy: value })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all-steps">执行计划的全部步骤</SelectItem>
                <SelectItem value="evaluate-after-step">
                  每步后由评估器判断是否够了
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <ExecutorFields
            executor={executor}
            editing={editing}
            onChange={(next) =>
              editing?.onChangeConfig({
                ...node.config,
                executor: { ...next, type: "agent" },
              })
            }
          />
        </div>
      </InspectorSection>
    );
  }

  if (node.type === "plan") {
    return (
      <InspectorSection title="配置">
        <Field label="计划步数上限">
          <Input
            type="number"
            min={1}
            value={String(node.config.maxSteps ?? "")}
            disabled={!editing}
            onChange={(event) =>
              editing?.onChangeConfig({
                ...node.config,
                maxSteps: Number(event.target.value),
              })
            }
          />
        </Field>
      </InspectorSection>
    );
  }

  if (node.type === "condition") {
    return (
      <ConditionConfig node={node} definition={definition} editing={editing} />
    );
  }

  return (
    <InspectorSection title="配置">
      <pre className="overflow-auto rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
        {JSON.stringify(node.config, null, 2)}
      </pre>
    </InspectorSection>
  );
}

/**
 * Agent 执行器的公共字段
 * @param props 当前执行器配置、编辑能力与提交回调
 * @returns 返回模型、工具组、技能与轮数字段
 * @description agent 节点与 plan-loop 的内部 executor 是同一份配置形状，共用一个组件，
 * 避免两处各写一遍后漂移。
 */
function ExecutorFields({
  executor,
  editing,
  onChange,
}: {
  executor: Record<string, unknown>;
  editing?: InspectorEditing;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const toolGroups = asStringArray(executor.toolGroups);
  const skills = asStringArray(executor.skills);
  return (
    <div className="space-y-2">
      <Field label="模型预设" hint="agent-default 表示运行时取智能体的默认模型">
        <Input
          value={String(executor.modelPreset ?? "")}
          disabled={!editing}
          onChange={(event) =>
            onChange({ ...executor, modelPreset: event.target.value })
          }
        />
      </Field>
      <Field label="工具组">
        {editing ? (
          <MultiSelect
            options={editing.capabilities.toolGroups.map((value) => ({
              value,
              label: value,
            }))}
            value={toolGroups}
            onChange={(next) => onChange({ ...executor, toolGroups: next })}
            placeholder="不装配工具"
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {toolGroups.join("、") || "无"}
          </p>
        )}
      </Field>
      <Field
        label="技能"
        hint={
          editing
            ? "逗号分隔。admin 接口未暴露技能闭集，拼错的名字这里拦不住——运行时它不会贡献任何工具"
            : undefined
        }
      >
        {editing ? (
          <Input
            value={skills.join(", ")}
            onChange={(event) =>
              onChange({
                ...executor,
                skills: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
            placeholder="不启用技能"
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {skills.join("、") || "无"}
          </p>
        )}
      </Field>
      <Field label="工具轮数上限">
        <Input
          type="number"
          min={1}
          value={String(executor.maxToolIterations ?? "")}
          disabled={!editing}
          onChange={(event) =>
            onChange({
              ...executor,
              maxToolIterations: Number(event.target.value),
            })
          }
        />
      </Field>
    </div>
  );
}

/**
 * Condition 节点的判定配置
 * @param props 节点、当前定义与可选编辑能力
 * @returns 返回按 case 分组的判定编辑器
 * @description 已选中的引用若不在可选项里（图被改动后引用失效），显式标红说明发布会被拒，
 * 不静默显示成正常值。
 */
function ConditionConfig({
  node,
  definition,
  editing,
}: {
  node: EditableNode;
  definition: CanvasDefinition;
  editing?: InspectorEditing;
}) {
  const options = variableOptions(node.id, definition);
  const cases = readConditionCases(node);

  const writeCases = (next: ConditionCase[]) => {
    editing?.onChangeConfig({
      ...node.config,
      cases: next.map((item) => ({
        key: item.key,
        logic: item.logic,
        conditions: item.conditions.map((predicate) => ({
          ref: { $ref: predicate.ref },
          operator: predicate.operator,
          ...(predicate.value === undefined ? {} : { value: predicate.value }),
        })),
      })),
    });
  };

  return (
    <InspectorSection title="条件判定">
      {cases.length === 0 ? (
        <p className="text-xs text-muted-foreground">尚未声明任何 case</p>
      ) : null}
      <div className="space-y-3">
        {cases.map((branch, caseIndex) => (
          <div
            key={`${branch.key}:${caseIndex}`}
            className="space-y-2 rounded-md border border-border px-2 py-2"
          >
            <div className="flex items-center gap-2">
              <Input
                className="h-7 w-[104px] font-mono text-xs"
                value={branch.key}
                disabled={!editing}
                onChange={(event) =>
                  editing?.onRenameCase(branch.key, event.target.value)
                }
              />
              <Select
                value={branch.logic}
                disabled={!editing}
                onValueChange={(value) =>
                  writeCases(
                    cases.map((item, index) =>
                      index === caseIndex
                        ? { ...item, logic: value === "or" ? "or" : "and" }
                        : item,
                    ),
                  )
                }
              >
                <SelectTrigger className="h-7 w-[104px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="and">全部成立</SelectItem>
                  <SelectItem value="or">任一成立</SelectItem>
                </SelectContent>
              </Select>
              {editing && cases.length > 1 ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() =>
                    writeCases(cases.filter((_, index) => index !== caseIndex))
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>

            {branch.conditions.length === 0 ? (
              <p className="text-xs text-[var(--lb-warning)]">
                这个 case
                还没有判定，保存会被拒绝。先把本节点连到上游，再添加判定——
                可引用的变量只来自必定先执行的上游节点。
              </p>
            ) : null}

            {branch.conditions.map((predicate, predicateIndex) => (
              <PredicateRow
                key={predicateIndex}
                predicate={predicate}
                options={options}
                editing={editing}
                onChange={(next) =>
                  writeCases(
                    cases.map((item, index) =>
                      index === caseIndex
                        ? {
                            ...item,
                            conditions: item.conditions.map((entry, i) =>
                              i === predicateIndex ? next : entry,
                            ),
                          }
                        : item,
                    ),
                  )
                }
                onRemove={() =>
                  writeCases(
                    cases.map((item, index) =>
                      index === caseIndex
                        ? {
                            ...item,
                            conditions: item.conditions.filter(
                              (_, i) => i !== predicateIndex,
                            ),
                          }
                        : item,
                    ),
                  )
                }
              />
            ))}

            {editing ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={options.length === 0}
                title={
                  options.length === 0
                    ? "本节点上游没有可引用的输出：先把它连到 start 之后"
                    : undefined
                }
                onClick={() =>
                  writeCases(
                    cases.map((item, index) =>
                      index === caseIndex
                        ? {
                            ...item,
                            conditions: [
                              ...item.conditions,
                              defaultPredicate(options[0]),
                            ],
                          }
                        : item,
                    ),
                  )
                }
              >
                <Plus className="h-3.5 w-3.5" />
                添加判定
              </Button>
            ) : null}
          </div>
        ))}
      </div>

      {editing ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full"
          onClick={() =>
            writeCases([
              ...cases,
              {
                key: nextCaseKey(cases),
                logic: "and",
                conditions: options[0] ? [defaultPredicate(options[0])] : [],
              },
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" />
          添加 case
        </Button>
      ) : null}

      <p className="mt-2 text-xs text-muted-foreground">
        全部 case 都不成立时走隐含的 <span className="font-mono">else</span>{" "}
        分支。新增 case 后记得在画布上把它连出去——分支必须全连或全不连。
      </p>
    </InspectorSection>
  );
}

/** 单条判定的编辑行。 */
function PredicateRow({
  predicate,
  options,
  editing,
  onChange,
  onRemove,
}: {
  predicate: ConditionPredicate;
  options: FlowVariableOption[];
  editing?: InspectorEditing;
  onChange: (next: ConditionPredicate) => void;
  onRemove: () => void;
}) {
  const refKey = predicate.ref.join(".");
  const matched = options.find((option) => option.ref.join(".") === refKey);
  const operatorMeta = FLOW_CONDITION_OPERATORS[predicate.operator];
  // 算子按被引变量的类型过滤：类型不匹配在发布期会被服务端以 ref-type-match 拒绝，
  // 选择器不该先把它列出来
  const allowedOperators = matched
    ? operatorsFor(matched.valueType)
    : [predicate.operator];

  return (
    <div className="space-y-1 rounded bg-muted/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <Select
          value={matched ? refKey : undefined}
          disabled={!editing}
          onValueChange={(value) => {
            const option = options.find((item) => item.ref.join(".") === value);
            if (option) {
              onChange(defaultPredicate(option));
            }
          }}
        >
          <SelectTrigger className="h-7 flex-1">
            <SelectValue
              placeholder={refKey ? `${refKey}（不可引用）` : "选择变量"}
            />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem
                key={option.ref.join(".")}
                value={option.ref.join(".")}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {editing ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        <Select
          value={predicate.operator}
          disabled={!editing}
          onValueChange={(value) => {
            const operator = value as FlowConditionOperator;
            onChange({
              ref: predicate.ref,
              operator,
              ...(FLOW_CONDITION_OPERATORS[operator].requiresValue
                ? { value: predicate.value ?? "" }
                : {}),
            });
          }}
        >
          <SelectTrigger className="h-7 w-[128px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allowedOperators.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {operatorMeta?.requiresValue ? (
          <Input
            className="h-7 flex-1"
            value={String(predicate.value ?? "")}
            disabled={!editing}
            onChange={(event) =>
              onChange({
                ...predicate,
                value: coerceValue(event.target.value, matched?.valueType),
              })
            }
          />
        ) : null}
      </div>
      {matched ? null : (
        <p className="text-xs text-[var(--lb-danger)]">
          引用「{refKey || "（空）"}」不在本节点可引用的上游输出中，发布会被拒绝
        </p>
      )}
    </div>
  );
}

/** 面板内的一个分组。 */
function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 带标签的一个字段。 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** condition 判定在读取时的最小形状。 */
interface ConditionPredicate {
  ref: readonly [string, string];
  operator: FlowConditionOperator;
  value?: string | number | boolean;
}

/** condition case 在读取时的最小形状。 */
interface ConditionCase {
  key: string;
  logic: "and" | "or";
  conditions: ConditionPredicate[];
}

/**
 * 列出适用于某个值类型的算子
 * @param valueType 被引变量的值类型
 * @returns 返回可选算子
 * @description 闭集与判定条件都来自共享契约的 FLOW_CONDITION_OPERATORS，前端不另写一份。
 */
function operatorsFor(valueType: string): FlowConditionOperator[] {
  return (
    Object.keys(FLOW_CONDITION_OPERATORS) as FlowConditionOperator[]
  ).filter((name) =>
    FLOW_CONDITION_OPERATORS[name].valueTypes.includes(
      valueType as FlowValueType,
    ),
  );
}

/**
 * 为一个变量生成默认判定
 * @param option 选中的变量
 * @returns 返回类型匹配的默认判定
 * @description 默认算子取该类型的第一个合法算子，而不是固定 'is'——固定值在 number/array 上
 * 一定触发 ref-type-match，等于新加的判定天生就是错的。
 */
function defaultPredicate(option: FlowVariableOption): ConditionPredicate {
  const operator = operatorsFor(option.valueType)[0] ?? "notEmpty";
  return {
    ref: option.ref,
    operator,
    ...(FLOW_CONDITION_OPERATORS[operator].requiresValue ? { value: "" } : {}),
  };
}

/** 生成不冲突的 case 键。 */
function nextCaseKey(cases: ConditionCase[]): string {
  const used = new Set(cases.map((item) => item.key));
  for (let index = 1; ; index += 1) {
    const candidate = `case_${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * 把输入框文本转成该类型应有的比较值
 * @param raw 输入框文本
 * @param valueType 被引变量的值类型
 * @returns 返回类型匹配的值
 * @description number 型必须存数字：存成字符串会让服务端的类型检查过不了，而输入框天然给字符串。
 */
function coerceValue(
  raw: string,
  valueType: string | undefined,
): string | number | boolean {
  if (valueType === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return raw;
}

/**
 * 读取 condition 节点的 case 列表
 * @param node 当前节点
 * @returns 形状可读的 case；读不出来的条目跳过
 * @description 草稿允许 config 还不合法，因此逐项检查而不是断言。
 */
function readConditionCases(node: EditableNode): ConditionCase[] {
  const cases = node.config.cases;
  if (!Array.isArray(cases)) {
    return [];
  }
  const result: ConditionCase[] = [];
  for (const item of cases) {
    const candidate = asRecord(item);
    if (!candidate || typeof candidate.key !== "string") {
      continue;
    }
    const conditions: ConditionPredicate[] = [];
    for (const raw of Array.isArray(candidate.conditions)
      ? candidate.conditions
      : []) {
      const predicate = asRecord(raw);
      const ref = asRecord(predicate?.ref)?.$ref;
      if (
        !predicate ||
        !Array.isArray(ref) ||
        typeof ref[0] !== "string" ||
        typeof ref[1] !== "string" ||
        typeof predicate.operator !== "string"
      ) {
        continue;
      }
      conditions.push({
        ref: [ref[0], ref[1]],
        operator: predicate.operator as FlowConditionOperator,
        ...(predicate.value === undefined
          ? {}
          : { value: predicate.value as string | number | boolean }),
      });
    }
    result.push({
      key: candidate.key,
      logic: candidate.logic === "or" ? "or" : "and",
      conditions,
    });
  }
  return result;
}

/** 把未知值收敛成普通对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 把未知值收敛成字符串数组。 */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
