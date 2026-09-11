# AgentFlow Loop 容器与 Definition 升级设计

**日期：** 2026-09-10
**状态：** 已落地并验收
**范围：** 将现有回边式 `loop` 优化为主画布内联、可折叠的容器，并建立可审计的 Definition 单向升级链。第一条迁移只保证 v9 到 v10。
**不包含：** `evaluate`、`structured-output`、嵌套 Loop、数组迭代、并行轮次、Loop 内人工审批、自由画环、旧版本原地改写。

## 背景

AgentFlow 已经支持通用 `loop`：`loop --again--> 循环体`，循环体通过唯一回边返回 `loop`，`loop --done--> 下游`。Workflow 持有轮次，节点执行 ID 带轮次，Activity 的幂等回放、最近一轮 `$ref`、预算和单层循环区域校验都已落地。

当前问题主要在编辑模型，而不是运行模型：

- 管理员必须手动画 `again` 和跨越整段流程的回边，画布容易混乱。
- 循环体归属只靠拓扑推导，编辑中的半成品难以表达“这个节点属于哪个 Loop”。
- Loop 卡片与普通节点外观接近，展开范围、内部入口和完成出口不直观。
- 当前严格版本解析会把所有旧 schemaVersion 直接判为不兼容。以后每次扩展节点闭集都要求重建旧 Flow，不适合长期演进。

本次保留已经验证的运行时循环语义，只把循环体归属显式化，并让 Admin 用容器隐藏技术边。与此同时建立版本化解析与顺序升级能力，使合法旧工件可以继续运行、显式升级，而不篡改历史版本。

## 目标

- Loop 在主画布中表现为可展开、可折叠的内联容器。
- 循环体节点通过 `loopId` 明确归属，画布归属与后端识别出的循环区域始终一致。
- 管理员只编辑循环体内的业务连线；`again` 和回边由编辑器维护并隐藏。
- `continueWhen` 保持当前确定性规则语义，不让 Loop 隐式调用模型。
- 合法 v9 Flow 可在不修改原文和 digest 的前提下规范化为 v10 并继续运行。
- 编辑旧版本时生成新的 v10 草稿，不原地修改发布或归档工件。
- 旧工件的状态能区分当前、可升级、数据损坏和尚不支持，不再用一个布尔值混在一起。

## 已选方案

采用“内联容器 + 显式归属 + 隐藏技术边”。未采用另外两种方案：

- 独立子画布会割裂主流程上下文，查看和连线成本较高。
- 允许任意自由回边会产生重叠环、轮次归属、join 重置和幂等键歧义，不能满足工具副作用安全要求。

Loop 容器只是编辑和契约模型的深化，不替换现有 Workflow/Activity 执行器。运行图仍使用已经验证的四类边：

```text
外部上游 -> loop
loop --again--> 循环体唯一入口
循环体唯一回流节点 -> loop
loop --done--> 外部下游
```

## v10 Definition 契约

### 循环体归属

`FlowNodeBase` 增加可选的 `loopId`：

```ts
interface FlowNodeBase {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly loopId?: string;
}
```

示例：

```json
{
  "id": "generate",
  "type": "agent",
  "name": "生成候选答案",
  "loopId": "quality_loop",
  "config": {
    "toolGroups": [],
    "skills": [],
    "maxToolIterations": 4
  }
}
```

约束如下：

- `loopId` 必须引用同一 Definition 中的 `loop` 节点。
- `start`、`end` 和 `loop` 本身不能声明 `loopId`。
- 第一版一个节点最多属于一个 Loop，且 Loop 内不能再包含 Loop。
- `loopId` 是执行语义，不属于 `layout`，因此参与 v10 digest。
- 没有 `loopId` 的节点属于主画布。
- 后端仍从技术边计算循环区域，并要求计算结果与所有 `loopId` 完全一致；不信任前端单独声明的归属。

### Loop 配置与分支

`FlowLoopNodeConfig` 保持现有字段：

```ts
interface FlowLoopNodeConfig {
  readonly maxIterations: number;
  readonly continueWhen: readonly FlowConditionCase[];
}
```

运行语义不变：

- 第一轮必定执行。
- 每轮回到 Loop 后计算 `continueWhen`。
- 命中任意 case 且尚未达到 `maxIterations` 时走 `again`。
- 未命中或达到最大轮数时走 `done`。
- `continueWhen: []` 表示固定执行满 `maxIterations`。

`again`、`done` 和循环体回边仍保存在 Definition 中。它们是编译器、循环区域分析、Workflow 重入和审计的事实，不改成只存在于前端的隐式信息。

### 布局

`layout.nodes[nodeId]` 扩展为：

```ts
interface FlowNodeLayout {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
  readonly collapsed?: boolean;
}
```

示例：

```json
{
  "layout": {
    "nodes": {
      "quality_loop": {
        "x": 400,
        "y": 180,
        "width": 620,
        "height": 280,
        "collapsed": false
      },
      "generate": {
        "x": 24,
        "y": 72
      }
    }
  }
}
```

- 主画布节点和 Loop 容器使用画布绝对坐标。
- 带 `loopId` 的内部节点使用相对于所属容器内容区的坐标。
- `width`、`height` 只对 Loop 容器生效；编辑器设置最小尺寸，并可随内部节点范围向外扩展。
- `collapsed` 只对 Loop 生效。缺省时视为 `false`。
- 整个 `layout` 继续从语义 digest 中排除。移动、缩放、展开和折叠不会产生新的执行语义。
- 只读画布读取已保存的折叠状态，也允许本地临时展开查看；只读操作不写回 Definition。

## 画布交互

### 展开状态

展开的 Loop 是主画布中的父容器，内部直接显示业务节点与业务边。容器外只暴露一个入口和一个 `done` 出口；不显示 `again` 端口、返回口或跨越整张图的回边。

新建 Loop 时默认展开并为空。容器头部显示名称、Loop 类型和折叠按钮；选中后在右侧 Inspector 编辑名称、描述、`maxIterations` 与 `continueWhen`。

### 折叠状态

折叠后内部节点、内部业务边、`again` 边和回边全部隐藏，Loop 变成稳定尺寸的摘要节点。摘要至少包含：

- 最大轮数；
- 继续条件摘要；
- 内部节点数量。

有继续条件时显示类似“最多 3 轮 · 质量未通过时继续”；空条件明确显示“固定执行 3 轮”。折叠不修改节点归属、技术边或运行语义，外部入边和 `done` 出边仍连接容器。

### 加入与移出

- 从左侧节点面板拖进展开的 Loop，直接创建带该 `loopId` 的内部节点。
- 把主画布已有节点拖进 Loop 时，命中容器后高亮；松手写入 `loopId`，并把坐标换算为容器相对坐标。
- 把内部节点拖出 Loop 时删除 `loopId`，并把相对坐标换算回画布绝对坐标。
- `start`、`end`、`loop` 拖入时直接拒绝；第一版不允许把一个 Loop 拖进另一个 Loop。
- 如果改变归属会留下非法跨边界边，操作直接拒绝并说明具体连线；不自动删除或改写用户已有边。

### 内部入口与回流

容器内部不增加不可删除的 Loop Start/Loop End 技术节点。管理员只连接业务节点，编辑器按拓扑推导：

- 没有内部前驱的唯一节点是本轮入口；
- 没有内部后继的唯一节点是本轮回流节点；
- 编辑器据此维护 `loop --again--> 入口` 与 `回流节点 --> loop`。

新增、删除或改变内部业务边后立即重新推导。能够唯一确定时同步重建两条技术边；不能唯一确定时删除编辑器此前生成的 `again` 和回边，不保留一条已经失真的旧边，也不猜测新端点。这里允许自动维护的只有技术边，用户创建的业务边绝不自动删除。空容器、多入口、多回流属于可保存的草稿中间态，画布以黄色警告说明原因，但禁止发布。

### 边界规则

- 容器外节点只能连接 Loop 容器入口，不能绕过入口直连内部节点。
- 内部节点只能连接同一 Loop 内部节点，不能直连容器外节点或另一个 Loop 的内部节点。
- 外部下游只能从 Loop 的 `done` 出口连接。
- 循环体每条路径都必须从唯一入口出发，并最终到达唯一回流节点。
- Loop 内可有 fan-out，但仍沿用当前约束：不允许 `approval`、`join(any)`、嵌套或重叠循环。
- 普通节点形成的环继续拒绝；唯一合法的环仍是由 Loop 容器圈定并回到该 Loop 的技术回边。

## 草稿与发布校验

容器编辑必然产生短暂的空 Loop、断边和多入口状态，因此保存草稿与发布不能继续使用完全相同的门槛。

草稿写入只接受当前 v10 结构，并执行不会妨碍渐进编辑的安全校验：JSON 形状、闭集节点配置、标识格式与唯一性、引用目标类型、布局数值上限等。它允许拓扑暂不完整，但必须把语义问题作为校验结果返回，不能把结构无法解析的数据写成可编辑草稿。

发布仍执行完整结构、拓扑和运行时校验。以下状态一律禁止发布：空 Loop、缺少或存在多个内部入口、缺少或存在多个回流节点、`loopId` 与技术边推导区域不一致、非法跨边界、普通环、嵌套/重叠 Loop，以及现有 validator/runtime validator 的任何错误。

Admin 自动校验应区分：

- 草稿可继续编辑的拓扑警告：黄色展示，允许保存，禁止发布；
- 结构损坏或字段非法：红色展示，拒绝保存；
- 完整合法：允许保存和发布。

保存接口不把非法拓扑伪装成合法，也不自动删除边来“修复”草稿。

## Definition 版本升级

### 状态模型

用闭集状态替换当前模糊的 `schemaCompatible: boolean`：

```ts
type FlowSchemaStatus =
  | "current"
  | "upgradeable"
  | "invalid"
  | "unsupported";
```

- `current`：当前 v10，能按 v10 schema 解析；是否可发布继续由完整校验结果决定。
- `upgradeable`：合法 v9，存在完整且确定的 v9 到 v10 迁移路径，规范化结果也通过 v10 完整校验。
- `invalid`：版本受识别，但原工件按它声明的版本已经损坏，或升级时不能唯一推导归属。
- `unsupported`：v1 到 v8、未来版本或无迁移链版本。第一版不猜测其旧语义。

版本响应保留原始 `schemaVersion`，并提供 `schemaStatus`、目标版本和明确错误摘要。Admin 必须同步手写 DTO，不保留 `schemaCompatible` 双字段兼容。

### 版本化解析与顺序迁移

统一入口按以下顺序处理 Definition：

```text
读取原始 schemaVersion
  -> 用该版本自己的只读 schema 解析
  -> 用该版本规则验证语义
  -> 依次执行 migrateVnToVnPlus1
  -> 用当前 v10 validator 再验证
  -> 返回当前内存 Definition + 迁移报告
```

运行时、版本状态投影、升级草稿和审计脚本共用这一入口，不能各自实现一套兼容判断。历史版本导出是刻意的例外：它返回数据库原件，只可复用版本识别和错误摘要，不返回规范化结果。运行时始终只编译当前内存模型，不保留多套 compiler、Workflow 或 Activity。

历史 schema/parser 只用于读取与迁移，不接受新增写入。新增或更新草稿只能写当前版本。未来升级继续追加 `v10 -> v11`，并按顺序组合迁移；不得跳过中间版本直接猜测。

### v9 到 v10

v9 原工件必须先通过 v9 的结构和语义校验。迁移器随后：

1. 使用 v9 已有的 `again`、回边和 `flowLoopRegions` 规则计算每个合法循环体。
2. 为区域内每个业务节点补上对应 `loopId`。
3. 校验循环区域互不重叠、不嵌套，且每个节点最多得到一个归属。
4. 将内部节点的绝对坐标转换为容器相对坐标；没有布局时保持缺省，由 Admin 自动排布。
5. 为 Loop 布局补确定性的 `width`、`height` 和 `collapsed: false`。
6. 将 `schemaVersion` 改为 10，其余执行字段、节点顺序、边顺序和配置保持不变。
7. 用 v10 完整 validator 验证迁移结果，并生成结构化升级报告。

布局转换只影响已被 digest 排除的 `layout`。有现有布局时，使用循环体节点的边界框、固定头部高度、内边距和最小尺寸计算容器范围，再把内部节点换算为相对位置；相关几何常量属于同一个纯布局迁移函数。同一份 v9 JSON 必须逐字节得到同一份规范化 v10 JSON，不能读取数据库时间、当前窗口尺寸或随机数。

没有 Loop 的合法 v9 只需升版本号并原样保留既有布局，不能改变其他字段。

### 历史工件与 digest

- 已发布或归档 v9 的数据库 Definition、schemaVersion 和 digest 永远不被升级器改写。
- v9 digest 只验证原始 v9 工件；规范化后的 v10 内存对象不会拿去和 v9 digest 比较。
- 任务继续锁定原 `flowVersionId + digest`。任务创建、Activity 加载和调试快照先校验原工件身份，再通过同一纯函数规范化后交给当前 validator/compiler。
- 同一原始工件在任务创建、Workflow 重试和 Activity 重试中必须得到完全相同的规范化结果。
- 新建的 v10 草稿按 v10 Definition 计算新 digest；它与 v9 历史版本是两个独立工件。
- 导出历史版本时默认导出数据库中的原始 Definition，保持审计真实性，不把内存规范化结果冒充原件。

### 升级为草稿

Flow 详情为 `upgradeable` 版本提供“升级为 v10 草稿”动作。服务端在事务中重新读取源版本并执行迁移，然后：

- 如果该逻辑 Flow 已有草稿，明确拒绝，不覆盖现有草稿；
- 创建下一个版本号的 v10 `DRAFT`；
- 不修改源版本、当前发布指针或 Agent 绑定；
- 写入审计记录，关联源版本、目标草稿和升级版本范围；
- 返回新草稿与升级摘要，Admin 跳转到新草稿编辑器。

升级摘要至少列出：Definition 从 v9 升到 v10、为哪些节点补了哪个 `loopId`、哪些节点坐标被转成相对坐标。新草稿必须重新校验并由管理员主动发布；创建升级草稿不等于发布，也不会让 Agent 自动改绑。

导入 v9 JSON 时可以复用同一预检与迁移器，但必须先展示升级结果，再按当前 v10 新建；不能把 v9 原文直接作为新的可编辑草稿写入。

## 运行时与失败处理

运行时继续只走 AgentFlow 和现有 Temporal 路径。容器不引入第二套调度器，不改变轮次、幂等键、最近一轮 `$ref`、join 重置或预算计数。

- 合法已发布 v9：自动规范化为 v10 后继续运行。
- v9 原文损坏或无法唯一推导循环体：状态为 `invalid`，不运行、不生成升级草稿。
- v1 到 v8 或未来版本：状态为 `unsupported`，第一版只允许查看原始信息、导出和按现有保护规则删除，不能编辑、发布或运行。
- 运行时规范化失败：任务创建前明确返回“Flow 版本无法升级”及安全错误摘要，不回退到内置 direct Flow 或旧编排链路。
- 如果工件在任务创建后被异常篡改导致 digest/版本不一致，Activity 继续以快照不一致失败，不尝试重新选择 Flow。
- 升级器不得 catch 后返回原 Definition、空图或默认成功。

## `continueWhen` 文案

本阶段不把 `continueWhen` 改成 `breakWhen`。旧条件的通用逻辑取反无法在当前 case 结构中保证无损迁移，改名会制造隐性行为变化。

Inspector 固定说明为：

```text
继续条件
命中任意规则时执行下一轮；未命中或达到最大轮数时退出。
未配置规则将固定执行满最大轮数。
```

自然语言质量判断不直接写进 `continueWhen`。后续的 `evaluate` 和 `structured-output` 会是独立、可复用的显式模型节点，Loop 仅通过 `$ref` 判断其结构化结果。该后续阶段不属于本设计的实现范围。

## 验证策略

### 契约与迁移

- 无 Loop 的合法 v9 能确定性升级为 v10，执行字段保持不变。
- 单 Loop 的 v9 能为全部且仅有循环体节点补齐 `loopId`。
- 非法、多义、嵌套或重叠循环不能被迁移器猜测修复。
- 同一输入重复规范化得到深度相等且规范序列化一致的结果。
- v9 原 Definition、数据库 schemaVersion、digest、发布指针和 Agent 绑定保持不变。
- v1 到 v8、未来版本、损坏 v9 分别得到正确的 `unsupported` 或 `invalid`。
- v10 `loopId` 与技术边区域不一致时发布校验失败。
- 布局移动、尺寸和折叠变化不改变 digest；`loopId` 变化会改变 digest。

### 控制面

- 版本列表和详情正确展示 `current / upgradeable / invalid / unsupported`。
- 有现存草稿时拒绝生成升级草稿。
- 升级动作创建新 v10 草稿，并返回节点归属和坐标转换摘要。
- 升级不替换发布版本、不修改源工件、不自动改绑 Agent。
- 空 Loop、多入口、多回流允许作为 v10 草稿中间态保存，但完整校验失败且不能发布。
- 结构损坏、未知节点类型和非法 `loopId` 拒绝保存。

### 画布

- 新节点拖入 Loop 时写入 `loopId` 和相对坐标；拖出时删除 `loopId` 并恢复绝对坐标。
- 非法跨边界连线存在时阻止移入或移出，且不删除原边。
- 内部拓扑唯一时自动维护 `again` 和回边；多义时不猜测并显示警告。
- 展开与折叠正确隐藏内部节点、内部边和技术边，外部入口与 `done` 出口保持连接。
- 保存后重新打开能恢复容器尺寸、内部布局和折叠状态。
- 只读版本可临时展开，但不产生保存请求。

### 运行时

- 已发布 v9 能创建任务、规范化并完整执行。
- v10 Loop 第二轮真实执行，不被第一轮节点记录短路。
- Temporal 重试同一轮仍命中相同 `nodeExecutionId`，不会重复执行工具副作用。
- `$ref` 在循环体内继续读取最近完成的一轮。
- 非收敛循环仍由 `maxIterations` 和 Flow 预算明确终止。
- 调试执行快照继续展示任务实际锁定的原 flowVersionId 与 digest。

### 必跑检查

实施完成后至少执行：

```bash
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check
pnpm --filter ./apps/admin run typecheck
pnpm --filter ./apps/admin run lint
pnpm --filter ./apps/admin run build
pnpm build
```

并运行 Definition schema/validator/digest、版本升级服务、Flow 编辑纯函数、画布交互和 Temporal AgentFlow 的定向测试。Temporal 集成套件按 `apps/api/AGENTS.md` 的约定，以 Jest 汇总判断结果。

## 实施边界与顺序约束

后续实施计划应拆成可独立验证的小步，但必须遵守以下依赖：

1. 先建立 v9 只读解析、v10 当前契约、顺序迁移器和状态模型。
2. 再让任务创建、Activity 加载、版本读取和升级入口统一走规范化入口。
3. 再实现 v10 `loopId` 的完整校验与草稿/发布两级门槛。
4. 最后实现 Admin 容器投影、拖入拖出、技术边维护、折叠和升级交互。

不在这一阶段顺手加入 `evaluate`、`structured-output` 或任意 JSON Schema。它们将在升级链稳定后作为下一次当前版本演进，通过新的顺序迁移继续支持旧 Flow。

## 已接受代价

- 为了让历史 v9 继续运行，代码库需要长期保留 v9 的只读 schema 与 `v9 -> v10` 迁移器。
- `loopId` 与技术边同时存在，需要后端一致性校验；这是换取清晰编辑归属和安全运行边界的必要冗余。
- 草稿保存和发布需要两级校验，控制面比当前单一严格校验更复杂。
- v1 到 v8 第一版仍不能自动恢复，需要人工重建或按数据审计结果处理。
- v9 升级草稿的布局可能需要管理员微调，但其运行语义必须无损且确定。

## 落地说明

- 当前可写契约为 v10，历史 v9 通过只读 schema 校验后确定性规范化。
- 升级审计使用 `UPGRADED` 动作，并在 `upgradeContext` 中记录源版本、目标草稿与版本范围。
- 数据库 schema 变更需要执行迁移 `add_agent_flow_upgrade_audit_context`。
- 自动化检查覆盖契约、迁移、digest、草稿/发布服务、运行快照与 Admin 编辑纯函数；真实浏览器中的拖入拖出、缩放、折叠和连线仍需手动验收。
