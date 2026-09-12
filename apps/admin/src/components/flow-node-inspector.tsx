import type { ReactNode } from "react";
import {
  FLOW_CONDITION_OPERATORS,
  type FlowConditionOperator,
  type FlowValueType,
} from "@litter-bear/types/agent-flow";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/multi-select";
import { ModelProviderLogo } from "@/components/model-provider-logo";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input, Textarea } from "@/components/ui/input";
import type { ModelPresetOption, ReasoningSelection } from "@/api/types";
import {
  defaultReasoningSelection,
  ReasoningControls,
} from "@/components/reasoning-controls";
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
  capabilities: {
    toolGroups: string[];
    /** 模型预设闭集；与后端同一判据，因此不含发布期会被拒的选项 */
    modelPresets: ModelPresetOption[];
  };
  /** 提交整份新 config */
  onChangeConfig: (config: Record<string, unknown>) => void;
  /** 改 condition 的 case 键；要连带改引用它的边，因此走单独回调 */
  onRenameCase: (oldKey: string, newKey: string) => void;
  /** 设置节点显示名；传空串即清除，界面回退显示 id */
  onChangeName: (name: string) => void;
  /** 设置节点简短描述；传空串即清除 */
  onChangeDescription: (description: string) => void;
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
  const outputs = nodeOutputEntries(node.type, node.config);
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
          <Field label="简短描述" hint="帮助团队理解节点用途，最多 200 字">
            {editing ? (
              <Textarea
                value={node.description ?? ""}
                placeholder="例如：提取订单信息并交给下游节点"
                maxLength={200}
                className="min-h-[72px] resize-y"
                onChange={(event) =>
                  editing.onChangeDescription(event.target.value)
                }
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                {node.description || "未设置"}
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

      {editing && node.type !== "start" && node.type !== "end" ? (
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

  if (node.type === "end") {
    return (
      <InspectorSection title="配置">
        <p className="text-xs text-muted-foreground">
          无需配置。它是流程唯一出口，不产生输出，也不能再连接后继节点。
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
          <RefField
            label="执行哪份计划"
            hint="接 plan 即执行原始计划，接 approval 即执行人确认过的那份"
            nodeId={node.id}
            definition={definition}
            field="steps"
            value={readRef(node.config.planRef)}
            editing={editing}
            onChange={(ref) =>
              editing?.onChangeConfig({ ...node.config, planRef: ref })
            }
          />
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

  if (node.type === "synthesize") {
    return (
      <InspectorSection title="配置">
        <div className="space-y-2">
          <ModelPresetField
            config={node.config}
            editing={editing}
            onChange={(config) => editing?.onChangeConfig(config)}
          />
          <RefField
            label="汇总谁的步骤观察"
            hint="留空则退化为普通汇总，不读取任何步骤观察"
            nodeId={node.id}
            definition={definition}
            field="observations"
            value={readRef(node.config.observationsRef)}
            editing={editing}
            optional
            onChange={(ref) => {
              // 保留其余字段：原先是整份覆盖 config，改引用会把 modelPreset 抹掉
              const next = { ...node.config };
              if (ref) {
                next.observationsRef = ref;
              } else {
                delete next.observationsRef;
              }
              editing?.onChangeConfig(next);
            }}
          />
        </div>
      </InspectorSection>
    );
  }

  if (node.type === "approval") {
    return (
      <InspectorSection title="配置">
        <div className="space-y-2">
          <Field
            label="审批门禁"
            hint="这一层只决定要不要请人过目计划；工具审批由能力注册表单独判定，不受它影响"
          >
            <Select
              value={
                typeof node.config.policy === "string"
                  ? node.config.policy
                  : "always"
              }
              disabled={!editing}
              onValueChange={(value) => {
                const next: Record<string, unknown> = {
                  ...node.config,
                  policy: value,
                };
                if (value === "model") {
                  if (typeof node.config.modelPreset !== "string") {
                    delete next.modelPreset;
                  }
                } else {
                  delete next.modelPreset;
                  delete next.reasoning;
                }
                editing?.onChangeConfig(next);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="always">总是等人工确认</SelectItem>
                <SelectItem value="never">自动通过，不等人</SelectItem>
                <SelectItem value="model">由模型判断是否需要人工</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {node.config.policy === "model" ? (
            <div className="space-y-2">
              <ModelPresetField
                config={node.config}
                editing={editing}
                onChange={(config) => editing?.onChangeConfig(config)}
              />
              <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                模型不可用、输出非法或额度耗尽时一律转人工确认（失败闭合）。
              </p>
            </div>
          ) : null}
          <RefField
            label="审哪份计划"
            hint="只能引用 plan 节点：打回重规划要用它声明的步数上限"
            nodeId={node.id}
            definition={definition}
            field="steps"
            value={readRef(node.config.planRef)}
            editing={editing}
            onChange={(ref) =>
              editing?.onChangeConfig({ ...node.config, planRef: ref })
            }
          />
        </div>
      </InspectorSection>
    );
  }

  if (node.type === "plan") {
    return (
      <InspectorSection title="配置">
        <div className="space-y-2">
          <ModelPresetField
            config={node.config}
            editing={editing}
            onChange={(config) => editing?.onChangeConfig(config)}
          />
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
        </div>
      </InspectorSection>
    );
  }

  if (node.type === "join") {
    return <JoinConfig node={node} definition={definition} editing={editing} />;
  }

  if (node.type === "condition") {
    return (
      <ConditionConfig node={node} definition={definition} editing={editing} />
    );
  }

  if (node.type === "loop") {
    return <LoopConfig node={node} definition={definition} editing={editing} />;
  }

  if (node.type === "structured-output") {
    return (
      <StructuredOutputConfig
        node={node}
        definition={definition}
        editing={editing}
      />
    );
  }

  if (node.type === "evaluate") {
    return (
      <EvaluateConfig node={node} definition={definition} editing={editing} />
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

function StructuredOutputConfig({
  node,
  definition,
  editing,
}: {
  node: EditableNode;
  definition: CanvasDefinition;
  editing?: InspectorEditing;
}) {
  const config = node.config as Record<string, unknown>;
  const fields = readStructuredFields(config.fields);
  const write = (next: Record<string, unknown>) =>
    editing?.onChangeConfig({ ...config, ...next });
  return (
    <InspectorSection title="结构化输出">
      <div className="space-y-3">
        <Field label="提取要求">
          <Textarea
            disabled={!editing}
            value={
              typeof config.instruction === "string" ? config.instruction : ""
            }
            onChange={(event) =>
              editing?.onChangeConfig({
                ...config,
                instruction: event.target.value,
              })
            }
          />
        </Field>
        <InputRefsField
          nodeId={node.id}
          definition={definition}
          value={config.inputRefs}
          editing={editing}
          onChange={(inputRefs) => write({ inputRefs })}
        />
        <Field label="输出字段" hint="字段类型和名称会在发布时严格校验">
          {fields.map((field, index) => (
            <div
              className="mb-2 flex items-center gap-1"
              key={`${field.name}-${index}`}
            >
              <Input
                className="h-8 min-w-0 flex-1"
                disabled={!editing}
                value={field.name}
                onChange={(event) =>
                  write({
                    fields: fields.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, name: event.target.value }
                        : item,
                    ),
                  })
                }
              />
              <Select
                disabled={!editing}
                value={field.type}
                onValueChange={(type) =>
                  write({
                    fields: fields.map((item, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...item,
                            type,
                            ...(type === "enum"
                              ? { values: item.values ?? ["value"] }
                              : { values: undefined }),
                          }
                        : item,
                    ),
                  })
                }
              >
                <SelectTrigger className="h-8 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">string</SelectItem>
                  <SelectItem value="number">number</SelectItem>
                  <SelectItem value="boolean">boolean</SelectItem>
                  <SelectItem value="enum">enum</SelectItem>
                </SelectContent>
              </Select>
              {field.type === "enum" ? (
                <Input
                  className="h-8 w-32"
                  disabled={!editing}
                  value={(field.values ?? []).join(", ")}
                  placeholder="枚举值"
                  onChange={(event) =>
                    write({
                      fields: fields.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              values: event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                            }
                          : item,
                      ),
                    })
                  }
                />
              ) : null}
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  disabled={!editing}
                  checked={field.required}
                  onChange={(event) =>
                    write({
                      fields: fields.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, required: event.target.checked }
                          : item,
                      ),
                    })
                  }
                />
                必填
              </label>
              {editing ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={`删除字段 ${field.name || index + 1}`}
                  title="删除字段"
                  onClick={() =>
                    write({
                      fields: fields.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          ))}
          {editing ? (
            <Button
              variant="outline"
              size="sm"
              disabled={fields.length >= 16}
              onClick={() =>
                write({
                  fields: [
                    ...fields,
                    {
                      name: `field_${fields.length + 1}`,
                      type: "string",
                      required: true,
                    },
                  ],
                })
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              添加字段
            </Button>
          ) : null}
        </Field>
        <ModelPresetField
          config={config}
          editing={editing}
          onChange={(next) => editing?.onChangeConfig(next)}
        />
      </div>
    </InspectorSection>
  );
}

function EvaluateConfig({
  node,
  definition,
  editing,
}: {
  node: EditableNode;
  definition: CanvasDefinition;
  editing?: InspectorEditing;
}) {
  const config = node.config as Record<string, unknown>;
  const write = (next: Record<string, unknown>) =>
    editing?.onChangeConfig({ ...config, ...next });
  return (
    <InspectorSection title="模型评估">
      <div className="space-y-3">
        <Field label="评估标准">
          <Textarea
            disabled={!editing}
            value={typeof config.criteria === "string" ? config.criteria : ""}
            onChange={(event) =>
              editing?.onChangeConfig({
                ...config,
                criteria: event.target.value,
              })
            }
          />
        </Field>
        <InputRefsField
          nodeId={node.id}
          definition={definition}
          value={config.inputRefs}
          editing={editing}
          onChange={(inputRefs) => write({ inputRefs })}
        />
        <p className="text-xs text-muted-foreground">
          固定输出：passed、score、reason
        </p>
        <ModelPresetField
          config={config}
          editing={editing}
          onChange={(next) => editing?.onChangeConfig(next)}
        />
      </div>
    </InspectorSection>
  );
}

/**
 * 结构化模型节点共用的有序输入引用编辑器
 * @param props 当前节点、引用值、整份草稿与编辑回调
 * @returns 返回最多八条可新增、删除和上下移动的引用行
 * @description 引用顺序会直接决定模型输入块顺序，因此排序是契约行为，不只是画布展示顺序。
 * 新增时选择当前尚未使用的第一个合法上游输出，避免默认制造重复引用。
 */
function InputRefsField({
  nodeId,
  definition,
  value,
  editing,
  onChange,
}: {
  nodeId: string;
  definition: CanvasDefinition;
  value: unknown;
  editing?: InspectorEditing;
  onChange: (refs: Array<{ $ref: [string, string] }>) => void;
}) {
  const refs = readFlowRefs(value);
  const used = new Set(refs.map((ref) => ref.$ref.join(".")));
  const nextOption = variableOptions(nodeId, definition).find(
    (option) => !used.has(option.ref.join(".")),
  );
  const replace = (index: number, ref: { $ref: [string, string] } | null) => {
    if (!ref) return;
    onChange(refs.map((item, itemIndex) => (itemIndex === index ? ref : item)));
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= refs.length) return;
    const next = [...refs];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <Field label="输入引用" hint="按顺序处理，至少一条、最多八条">
      <div className="space-y-2">
        {refs.length === 0 ? (
          <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
            暂无输入引用
          </p>
        ) : null}
        {refs.map((ref, index) => {
          const value = ref.$ref.join(".");
          return (
            <div className="flex items-start gap-1" key={`${value}-${index}`}>
              <div className="min-w-0 flex-1">
                <RefField
                  label={`输入 ${index + 1}`}
                  nodeId={nodeId}
                  definition={definition}
                  value={value}
                  editing={editing}
                  onChange={(next) => replace(index, next)}
                />
              </div>
              {editing ? (
                <div className="mt-5 flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={index === 0}
                    aria-label={`上移输入 ${index + 1}`}
                    title="上移"
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={index === refs.length - 1}
                    aria-label={`下移输入 ${index + 1}`}
                    title="下移"
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-[var(--lb-danger)]"
                    aria-label={`删除输入 ${index + 1}`}
                    title="删除输入"
                    onClick={() =>
                      onChange(
                        refs.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
        {editing ? (
          <Button
            variant="outline"
            size="sm"
            disabled={refs.length >= 8 || !nextOption}
            onClick={() =>
              nextOption &&
              onChange([
                ...refs,
                { $ref: [nextOption.sourceId, nextOption.field] },
              ])
            }
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            添加输入
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

/**
 * join 节点的等待配置
 * @param props 当前 join 节点、整份草稿与编辑能力
 * @returns 返回等待分支勾选与策略选择
 * @description waitFor 只能从**真正连进来的**上游里选（服务端 `join-wait-for`：等一个不会到达
 * 的分支就是死锁）。因此这里列的是入边来源，而不是全部节点——让用户勾出一个必然死锁的图，
 * 再由保存时的 400 告诉他，是把可以当场避免的错误推到了最后一步。
 *
 * 策略的措辞刻意点出后果：all 与 any 的区别不只是等多久，还决定下游能不能引用分支的输出
 * （any 语义下另一条分支可能还没跑完，引用会取到空值）。
 */
function JoinConfig({
  node,
  definition,
  editing,
}: {
  node: EditableNode;
  definition: CanvasDefinition;
  editing?: InspectorEditing;
}) {
  const incoming = definition.edges
    .filter((edge) => edge.to === node.id)
    .map((edge) => edge.from);
  const sources = [...new Set(incoming)];
  const waitFor = asStringArray(node.config.waitFor);
  const policy = node.config.policy === "any" ? "any" : "all";

  const toggle = (id: string) => {
    const next = waitFor.includes(id)
      ? waitFor.filter((item) => item !== id)
      : [...waitFor, id];
    editing?.onChangeConfig({ ...node.config, waitFor: next });
  };

  return (
    <InspectorSection title="配置">
      <div className="space-y-2">
        <Field
          label="等待哪些分支"
          hint="只能选连进本节点的上游；没被选中的分支会照常执行，但不会被等待"
        >
          {sources.length === 0 ? (
            <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
              还没有分支连进来。先从上游节点连线到这里，再回来选择要等的分支。
            </p>
          ) : (
            <div className="space-y-1">
              {sources.map((id) => (
                <label
                  key={id}
                  className="flex items-center gap-2 text-xs text-foreground"
                >
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={waitFor.includes(id)}
                    disabled={!editing}
                    onChange={() => toggle(id)}
                  />
                  <span className="font-mono">{id}</span>
                </label>
              ))}
            </div>
          )}
        </Field>
        <Field label="汇聚策略">
          <Select
            value={policy}
            disabled={!editing}
            onValueChange={(value) =>
              editing?.onChangeConfig({ ...node.config, policy: value })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">等齐全部选中的分支</SelectItem>
              <SelectItem value="any">任一分支完成即继续</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {policy === "any" ? (
          <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
            any
            语义下未完成的分支会继续跑完，但下游不能引用它们的输出——那时它可能还没有值。
          </p>
        ) : null}
        {sources.length > 0 && waitFor.length === 0 ? (
          <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
            还没有选中任何分支，保存时会被拒绝。
          </p>
        ) : null}
      </div>
    </InspectorSection>
  );
}

/**
 * 模型预设选择器
 * @param props 当前值、编辑能力与提交回调
 * @returns 返回闭集下拉，或只读态的文字
 * @description agent、plan、plan-loop executor、model approval 与 synthesize 共用：
 * 它们在契约里都是同义的可选 modelPreset，各写一份必然漂移。
 *
 * 闭集来自后端 listAvailableModels，与 FlowRuntimeValidator 同一判据，因此不会列出
 * 发布期会被拒的选项。
 */
function ModelPresetField({
  config,
  editing,
  onChange,
}: {
  config: Record<string, unknown>;
  editing?: InspectorEditing;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const presets = editing?.capabilities.modelPresets ?? [];
  const current =
    typeof config.modelPreset === "string" && config.modelPreset
      ? config.modelPreset
      : undefined;
  const selected = presets.find((preset) => preset.id === current);
  const stale = Boolean(current && !selected);

  return (
    <div className="space-y-2">
      <Field label="模型预设" hint="自定义 Flow 的每个模型节点必须选择具体预设">
        {editing ? (
          <Select
            value={current}
            onValueChange={(modelPreset) => {
              const preset = presets.find((item) => item.id === modelPreset);
              onChange(
                withModelSelection(
                  config,
                  modelPreset,
                  defaultReasoningSelection(preset?.reasoningCapability),
                ),
              );
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择具体模型" />
            </SelectTrigger>
            <SelectContent>
              {presets.map((preset) => (
                <SelectItem
                  key={preset.id}
                  value={preset.id}
                  textValue={`${preset.name} · ${preset.connectionName}`}
                  className="py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ModelProviderLogo
                      providerKey={preset.providerKey}
                      name={preset.connectionName}
                      className="h-7 w-7"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {preset.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {preset.connectionName} · {preset.model}
                      </span>
                    </span>
                  </span>
                </SelectItem>
              ))}
              {stale && current ? (
                <SelectItem value={current}>{current}（不可用）</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        ) : (
          <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
            {current ?? "未选择"}
          </p>
        )}
        {!current ? (
          <p className="text-xs text-[var(--lb-warning)]">
            必填：选择具体模型后才能保存并发布。
          </p>
        ) : null}
      </Field>
      <ReasoningControls
        capability={selected?.reasoningCapability}
        value={readReasoningSelection(config.reasoning)}
        disabled={!editing}
        onChange={(reasoning) =>
          current && onChange(withModelSelection(config, current, reasoning))
        }
      />
    </div>
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
      <ModelPresetField
        config={executor}
        editing={editing}
        onChange={onChange}
      />
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
 * Loop 节点的轮次与继续条件配置
 * @param props 当前 loop 节点、整份草稿与编辑能力
 * @returns 返回最大轮数输入和按组编辑的 breakWhen 条件
 * @description breakWhen 复用 condition 的判定结构，但组键不对应图上分支；任一组命中
 * 就走 done，全不命中或达到最大轮数时走 again。变量选项包含每轮回到 loop 前必定完成的
 * 体内输出，与后端 loop 边界引用校验使用共享图分析。
 */
function LoopConfig({
  node,
  definition,
  editing,
}: {
  node: EditableNode;
  definition: CanvasDefinition;
  editing?: InspectorEditing;
}) {
  const options = variableOptions(node.id, definition);
  const cases = readConditionCaseArray(node.config.breakWhen);
  const writeCases = (next: ConditionCase[]) => {
    editing?.onChangeConfig({
      ...node.config,
      breakWhen: serializeConditionCases(next),
    });
  };

  return (
    <InspectorSection title="循环配置">
      <div className="space-y-3">
        <Field label="最大轮数" hint="允许 1 至 20 轮；达到上限后无条件走 done">
          <Input
            type="number"
            min={1}
            max={20}
            value={String(node.config.maxIterations ?? "")}
            disabled={!editing}
            onChange={(event) =>
              editing?.onChangeConfig({
                ...node.config,
                maxIterations: Number(event.target.value),
              })
            }
          />
        </Field>

        <Field
          label="退出条件"
          hint="命中任意规则时退出；未命中且未达到最大轮数时继续。未配置规则将固定执行满最大轮数。"
        >
          <div className="space-y-2">
            {cases.map((branch, caseIndex) => (
              <div
                key={`${branch.key}:${caseIndex}`}
                className="space-y-2 rounded-md border border-border px-2 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-xs text-muted-foreground">
                    条件组 {caseIndex + 1}
                  </span>
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
                  {editing ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() =>
                        writeCases(
                          cases.filter((_, index) => index !== caseIndex),
                        )
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>

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
              disabled={options.length === 0}
              onClick={() =>
                writeCases([
                  ...cases,
                  {
                    key: nextCaseKey(cases),
                    logic: "and",
                    conditions: [defaultPredicate(options[0])],
                  },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" />
              添加继续条件组
            </Button>
          ) : null}
        </Field>
      </div>
    </InspectorSection>
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
      cases: serializeConditionCases(next),
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

/**
 * 引用选择字段
 * @param props 标签、可选项范围与变更回调
 * @returns 返回一个只列合法引用的下拉
 * @description 可选项来自共享 `flowDominators` 并按字段名过滤，与服务端的 ref-dominates /
 * ref-field 两条规则同判据。已选中但不在可选项里的引用显式标红，不静默显示成正常值——
 * 图改动后引用失效是很常见的，静默展示会让人以为还好着。
 */
function RefField({
  label,
  hint,
  nodeId,
  definition,
  field,
  value,
  editing,
  optional,
  onChange,
}: {
  label: string;
  hint?: string;
  nodeId: string;
  definition: CanvasDefinition;
  field?: string;
  value: string | null;
  editing?: InspectorEditing;
  optional?: boolean;
  onChange: (ref: { $ref: [string, string] } | null) => void;
}) {
  const options = variableOptions(nodeId, definition, field);
  const matched = options.find((option) => option.ref.join(".") === value);
  return (
    <Field label={label} hint={hint}>
      <Select
        value={matched ? (value ?? undefined) : undefined}
        disabled={!editing}
        onValueChange={(next) => {
          if (next === CLEAR_REF_VALUE) {
            onChange(null);
            return;
          }
          const option = options.find((item) => item.ref.join(".") === next);
          if (option) {
            onChange({ $ref: [option.sourceId, option.field] });
          }
        }}
      >
        <SelectTrigger>
          <SelectValue
            placeholder={
              value
                ? `${value}（当前不可引用）`
                : optional
                  ? "不引用"
                  : "请选择"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {optional ? (
            <SelectItem value={CLEAR_REF_VALUE}>不引用</SelectItem>
          ) : null}
          {options.map((option) => (
            <SelectItem key={option.ref.join(".")} value={option.ref.join(".")}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!matched && value ? (
        <p className="text-xs text-[var(--lb-danger)]">
          引用「{value}」不在可引用范围内，保存会被拒绝
        </p>
      ) : null}
      {!value && !optional ? (
        <p className="text-xs text-[var(--lb-warning)]">
          必填：没选之前这个节点保存会被拒绝
        </p>
      ) : null}
    </Field>
  );
}

/** Select 不接受空串作为选项值，用一个不会与引用冲突的哨兵表示「不引用」。 */
const CLEAR_REF_VALUE = "__none__";

/**
 * 读取 config 上的引用并压成可比较的字符串
 * @param value config 里的引用字段
 * @returns 形如 `plan.steps` 的字符串；读不到时返回 null
 */
function readRef(value: unknown): string | null {
  const ref = asRecord(value)?.$ref;
  return Array.isArray(ref) &&
    typeof ref[0] === "string" &&
    typeof ref[1] === "string"
    ? `${ref[0]}.${ref[1]}`
    : null;
}

/**
 * 从未知配置值读取合法引用列表
 * @param value 结构化节点的 inputRefs 候选值
 * @returns 返回可直接写回共享契约的引用元组数组
 * @description 草稿可能来自旧缓存或手工 JSON；损坏项不进入编辑状态，避免字符串拆分重建引用。
 */
function readFlowRefs(value: unknown): Array<{ $ref: [string, string] }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const ref = asRecord(item)?.$ref;
    return Array.isArray(ref) &&
      typeof ref[0] === "string" &&
      typeof ref[1] === "string"
      ? [{ $ref: [ref[0], ref[1]] }]
      : [];
  });
}

function readStructuredFields(value: unknown): Array<{
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  values?: string[];
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const candidate = asRecord(item);
    const name = candidate?.name;
    const type = candidate?.type;
    if (
      !candidate ||
      typeof name !== "string" ||
      (type !== "string" &&
        type !== "number" &&
        type !== "boolean" &&
        type !== "enum")
    ) {
      return [];
    }
    return [
      {
        name,
        type,
        required: candidate.required !== false,
        values: Array.isArray(candidate.values)
          ? candidate.values.filter(
              (item): item is string => typeof item === "string",
            )
          : undefined,
      },
    ];
  });
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

/**
 * 把面板内条件组序列化回共享契约形状
 * @param cases 已收窄的条件组
 * @returns 返回可写入 condition.cases 或 loop.breakWhen 的普通对象数组
 * @description 两种节点复用完全相同的判定契约，集中序列化避免引用元组或比较值在两处漂移。
 */
function serializeConditionCases(cases: ConditionCase[]) {
  return cases.map((item) => ({
    key: item.key,
    logic: item.logic,
    conditions: item.conditions.map((predicate) => ({
      ref: { $ref: predicate.ref },
      operator: predicate.operator,
      ...(predicate.value === undefined ? {} : { value: predicate.value }),
    })),
  }));
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
  return readConditionCaseArray(node.config.cases);
}

/**
 * 从未知配置值读取 condition case 数组
 * @param value condition.cases 或 loop.breakWhen 的未知草稿值
 * @returns 返回逐项收窄后的条件组；形状损坏的条目跳过
 * @description 草稿可能尚未通过服务端校验，两种节点的条件编辑器共用这一防御性读取路径。
 */
function readConditionCaseArray(value: unknown): ConditionCase[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: ConditionCase[] = [];
  for (const item of value) {
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

/**
 * 将模型与思考选择写回节点配置
 * @param config 当前节点或执行器配置
 * @param modelPreset 具体模型预设 ID
 * @param reasoning 与该模型能力匹配的思考选择
 * @returns 返回已清除旧模型思考残留的新配置
 * @description 更换模型时必须由调用方传入新模型的目录默认选择；普通或固定思考模型会删除
 * reasoning 字段，避免旧模型配置污染新模型。
 */
function withModelSelection(
  config: Record<string, unknown>,
  modelPreset: string,
  reasoning: ReasoningSelection | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config, modelPreset };
  if (reasoning) {
    next.reasoning = reasoning;
  } else {
    delete next.reasoning;
  }
  return next;
}

/** 从未校验的草稿配置中读取可供控件展示的思考选择。 */
function readReasoningSelection(
  value: unknown,
): ReasoningSelection | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const activation =
    source.activation === "enabled" ||
    source.activation === "disabled" ||
    source.activation === "auto"
      ? source.activation
      : undefined;
  const effort =
    source.effort === "minimal" ||
    source.effort === "low" ||
    source.effort === "medium" ||
    source.effort === "high" ||
    source.effort === "xhigh" ||
    source.effort === "max"
      ? source.effort
      : undefined;
  const budgetTokens =
    source.budgetTokens === "auto" ||
    (typeof source.budgetTokens === "number" &&
      Number.isInteger(source.budgetTokens) &&
      source.budgetTokens > 0)
      ? source.budgetTokens
      : undefined;
  return activation !== undefined ||
    effort !== undefined ||
    budgetTokens !== undefined
    ? { activation, effort, budgetTokens }
    : undefined;
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
