# AgentFlow evaluate 与 structured-output 节点设计

- 日期：2026-09-11
- 状态：设计已确认，实施已落地，待 review
- 适用版本：AgentFlow Definition v11

## 1. 背景与目标

Loop 已经是 AgentFlow 中唯一合法的显式循环边界。它需要一种确定、可审计的方式判断当前轮次是否已经达到目标，同时业务 Flow 也需要把模型结果转换为可供下游引用的有限结构化字段。

本设计新增两个独立节点：

- `structured-output`：按管理员声明的有限扁平字段，从一个或多个显式输入中提取结构化结果。
- `evaluate`：按管理员声明的评估标准，对一个或多个显式输入进行受限模型评估，固定产出是否通过、分数和原因。

两个节点共享内部结构化模型执行器，但在 Definition、Inspector、输出契约和图上意图上保持独立。Loop 只消费节点输出，不隐式调用模型。

## 2. 非目标

- 不开放任意 JSON Schema、对象/数组输出、递归结构或用户自定义算子；输入仍可引用现有节点声明的数组值，并按 JSON 序列化传入模型。
- 不把自然语言评估写进 Loop 配置，也不让 Loop 自己发起模型调用。
- 不恢复或扩展已废弃的 `strategy-router`、`strategy-registry`、`agent-loop-runner` 和 `graphs/` 路径。
- v11 编译器不混合兼容 `continueWhen` 与 `breakWhen`；历史 v10 工件由既有版本路径保持原语义运行。
- 不把结构化结果正文作为终端用户消息增量发送。

## 3. Definition v11 契约

### 3.1 版本与节点闭集

`AGENT_FLOW_SCHEMA_VERSION` 从 10 升为 11，节点闭集新增 `structured-output` 与 `evaluate`。所有 v11 工件必须使用新契约；旧版本不在 v11 编译器中隐式兼容。

### 3.2 公共模型选择

两个节点均支持：

```ts
modelPreset?: string;
reasoning?: ReasoningSelection;
```

缺省时继承任务创建时锁定的 Agent 默认模型和默认 reasoning。编译期把模型选择解析为具体预设，并按该预设能力校验 reasoning。节点配置不会从 Loop 隐式继承模型。

### 3.3 结构化输出节点

```ts
interface FlowStructuredOutputNodeConfig {
  readonly inputRefs: readonly FlowRef[];
  readonly instruction: string;
  readonly fields: readonly FlowStructuredField[];
  readonly modelPreset?: string;
  readonly reasoning?: ReasoningSelection;
}

type FlowStructuredField =
  | {
      readonly name: string;
      readonly type: "string";
      readonly required: boolean;
    }
  | {
      readonly name: string;
      readonly type: "number";
      readonly required: boolean;
    }
  | {
      readonly name: string;
      readonly type: "boolean";
      readonly required: boolean;
    }
  | {
      readonly name: string;
      readonly type: "enum";
      readonly values: readonly string[];
      readonly required: boolean;
    };
```

约束：

- `inputRefs` 1 至 8 个，按配置顺序处理，不允许重复引用。
- `instruction` 必填，去首尾空白后不可为空，并有服务端长度上限。
- `fields` 1 至 16 个；字段名唯一，只允许小写字母、数字、下划线，且以小写字母开头。
- `enum` 至少有一个值，最多 32 个；值非空、唯一，并有长度上限。
- 不允许额外字段。动态输出 schema 由 `fields` 生成，并由共享类型函数暴露给前后端。

### 3.4 评估节点

```ts
interface FlowEvaluateNodeConfig {
  readonly inputRefs: readonly FlowRef[];
  readonly criteria: string;
  readonly modelPreset?: string;
  readonly reasoning?: ReasoningSelection;
}
```

约束：

- `inputRefs` 1 至 8 个，按配置顺序处理，不允许重复引用。
- `criteria` 必填，去首尾空白后不可为空，并有服务端长度上限。
- 输出固定为严格闭集：

```ts
{
  passed: boolean;
  score: number; // 0-100 的整数
  reason: string; // 审计与调试用途
}
```

`reason` 不作为面向终端用户的回复内容。

### 3.5 动态输出与引用类型

现有 `FLOW_NODE_OUTPUTS` 继续作为固定节点输出的来源，并扩展为可按节点配置解析输出的共享函数。`structured-output.fields` 成为该节点的静态输出字段源；例如 `extract.score` 的类型在发布期和 Admin 变量选择器中都解析为 `number`。`evaluate` 固定声明 `passed: boolean`、`score: number`、`reason: string`。

所有输入和 `breakWhen` 引用都必须使用结构化 `$ref`，不保存模板字符串。引用节点必须存在、可达、在读取点之前完成，并且引用字段的类型必须匹配所选算子。

## 4. Loop 语义调整

### 4.1 `breakWhen`

v11 的 Loop 配置为：

```ts
interface FlowLoopNodeConfig {
  readonly maxIterations: number;
  readonly breakWhen: readonly FlowConditionCase[];
}
```

命中任一条件组即走 `done`，未命中且未达到 `maxIterations` 才走 `again`。空数组表示只按 `maxIterations` 执行。典型配置如下：

```json
{
  "maxIterations": 3,
  "breakWhen": [
    {
      "key": "complete",
      "logic": "and",
      "conditions": [
        {
          "ref": { "$ref": ["evaluate", "passed"] },
          "operator": "isTrue"
        }
      ]
    }
  ]
}
```

Loop 的 `breakWhen` 只能引用当前循环体中每轮必定完成且位于唯一回边之前的节点。第一版禁止嵌套 Loop、跨 Loop 引用和引用可能未执行的分支结果。

### 4.2 轮次与最近一轮

Workflow 持有循环轮次并将其随 Activity 输入下传。节点执行 ID 包含确定的轮次段，Temporal 重试同一轮时 ID 必须完全一致，以保留幂等回放并避免重复工具副作用。

循环体再次调度时清除体内 `scheduled` 和 `completed` 集合。`$ref` 解析为被引用节点最近一次完成的输出；读取顺序必须由轮次或确定性序列保证，不能依赖数据库默认返回顺序。

## 5. v10 到 v11 迁移

迁移只在管理员主动创建升级草稿时发生，不修改源版本、发布指针或 Agent 绑定。旧 v10 版本仍按原 `continueWhen` 语义运行。

- `continueWhen: []` 可确定转换为 `breakWhen: []`，行为等价。
- 第一版除空数组外不自动转换条件；后续只有在条件闭集内能证明整体行为等价时才可扩展转换，并在升级报告记录转换内容。
- 无法在现有条件闭集内无损表示补集的 `continueWhen` 不自动迁移，升级操作返回明确原因，要求管理员人工编辑后保存为 v11 草稿。
- 不把字段直接改名，不对条件做未经证明的逐条取反，不让已发布 Flow 因升级悄悄改变循环次数。
- v9 仍按既有 v9→v10 规则先升级，再由 v10→v11 处理；任一步无法确定性迁移都保持原版本并标记不可升级。

## 6. 运行时与模型调用

编译器将模型选择、reasoning 和动态字段 schema 冻结到运行快照。Activity 执行步骤如下：

1. 按 `inputRefs` 顺序解析上游输出，构造成带来源标签的模型输入块。
2. 通过 `LlmService.generateStructured` 调用模型。优先使用 provider 原生结构化能力；不可用时允许使用现有提示词约束与 JSON 提取降级路径。
3. 原生路径和降级路径都必须通过同一 Zod schema；拒绝额外字段、错误类型、越界分数和非法枚举值。
4. 成功结果写入本轮 `AgentFlowNodeExecution.outputs`，并记录节点执行 ID、loop iteration、耗时和 trace 摘要。
5. 每个节点模型调用计入一次 `policy.maxModelCalls`。

节点失败、模型不可用、输出为 `null`、JSON 不可解析、schema 校验失败或引用缺失时，Flow 进入明确失败终态。不得伪造 `passed=false`、默认分数、空字段，也不得读取上一轮结果继续循环。

SSE 仅发送已有的节点状态、完成和失败事件；结构化字段与评估 `reason` 留在节点执行记录和调试 trace，不作为用户消息增量。

## 7. 发布校验与草稿

草稿可以是不完整的，允许先保存再编辑。Inspector 对缺失项显示明确错误，但保存草稿不要求完整图契约。

发布校验必须拒绝：

- 空的 `instruction` 或 `criteria`；缺少输入；字段为空、重名、命名非法或 enum 非法。
- 不存在、不可达、类型不匹配或跨循环的引用。
- `breakWhen` 引用非每轮必定完成的节点，或存在非法回边、嵌套 Loop、循环体旁路。
- 模型预设不存在、不可用或不支持所选 reasoning。
- 动态输出字段无法生成严格 schema。

## 8. Admin Inspector

- `structured-output` 提供可增删、可排序的引用行；多行 `instruction` 编辑器；字段表格（名称、类型、必填、删除）；`enum` 类型显示枚举值编辑器。
- `evaluate` 提供同样的多引用编辑器和多行 `criteria` 编辑器；`passed`、`score`、`reason` 作为只读固定输出展示。
- 两个节点复用现有模型预设与 reasoning 控件；切换模型时清除不适用的 reasoning。
- Loop Inspector 将“继续条件”改为“退出条件”，读写 `breakWhen`，并显示“命中任意规则时退出；未命中且未达到最大轮数时继续”。
- 变量选择器从共享动态输出函数读取字段与类型，只展示后端发布校验允许的来源。
- 节点卡片只显示摘要：`结构化输出 · N 个字段` 或 `模型评估`，不展开长提示词。

## 9. 测试与验收

### 契约与校验

- v11 节点闭集、动态输出类型和固定 evaluate 输出。
- 字段数量、命名、enum、输入引用、提示词长度和模型配置限制。
- 引用可达性、类型匹配、Loop 边界、跨循环引用、嵌套与旁路拒绝。
- 草稿允许不完整，发布仍严格拒绝不完整配置。

### 迁移与编译

- v10 空 `continueWhen` 自动迁移为 v11 空 `breakWhen`。
- 空条件得到自动升级，所有非空条件都得到明确拒绝并要求人工处理。
- 源版本、digest、发布指针和 Agent 绑定不被升级草稿改变。
- 编译期模型继承、reasoning 能力和动态 Zod schema 正确冻结。

### Activity 与 Workflow

- structured-output 成功、原生能力降级、非法 JSON、schema 不匹配和模型异常。
- evaluate 的 `passed=true/false`、分数边界和 reason 落库。
- 缺失引用失败且不读取旧结果；节点失败不伪造 Loop 条件。
- 多轮执行 ID 唯一；Temporal 重试回放同一轮；最近一轮引用确定；预算和 `maxIterations` 都能终止不收敛循环。
- 并行/join 与 Loop 组合不因轮次重置而死锁或重复调度。

### Admin 与端到端

- 字段、enum、引用和 `breakWhen` 编辑器的增删改保存。
- 不完整草稿可保存；发布错误原样显示服务端原因。
- 收敛样例：第二轮 `evaluate.passed=true` 后走 `done`，执行记录保留两轮。
- 不收敛样例：由 `maxIterations` 或 Flow 预算以 `budget_exceeded`/对应终态结束。

## 10. 实施边界

实施必须沿现有 AgentFlow Definition、compiler、Temporal Activity 和 Admin Inspector 分层落地。不得修改 deprecated agent-loop 路径，不新增 Prisma migration；若后续确需数据库字段变化，只修改 Prisma schema 并由用户执行迁移命令。
