# Admin 智能体调试执行快照设计

## 目标

让管理员在调试智能体时明确看到两类不同事实：

1. 发送前，当前智能体配置预计使用的 Flow 与默认模型。
2. 发送后，每轮任务实际冻结的 Flow 版本、默认模型和节点模型配置。

展示不能把智能体后来修改后的配置冒充成历史任务的执行事实，也不能把 Flow 节点中“已配置但未经过本轮分支”的模型描述成已调用模型。

## 数据来源

### 当前配置预览

管理端使用现有智能体、Flow 列表和模型能力查询组装：

- `Agent.defaultFlowVersionId` 指向自定义发布版本；为空时显示“内置直接回复 Flow”。
- `Agent.defaultModelPresetId` 是 `agent-default` 的默认解析来源。
- Flow 名称和版本通过管理端 Flow 列表中的发布版本匹配。
- 模型展示名称通过能力列表的 `presetId` 匹配；无法匹配时显示原始 preset ID。

该区域明确标记为“当前配置”，不声称是某一历史任务的执行结果。

### 每轮冻结快照

测试会话详情从 assistant 消息关联的 `StreamTask` 读取：

- 任务 ID 与状态。
- `flowVersionId`、`flowDigest`。
- 关联 Flow 的 ID、当前名称和不可变版本号。
- `resolvedAgentModelPresetId`，即本轮 `agent-default` 冻结后的模型预设。
- 冻结 Definition 中每个模型节点的最终模型预设；区分“继承智能体默认”与“节点显式指定”。

Flow Definition 和版本号来自任务锁定的不可变 `AgentFlowVersion`。Flow 名称与模型友好名称属于当前展示元数据；若模型记录已不存在，保留 preset ID，不伪造名称。

## 后端契约

扩展 Admin 测试会话消息 DTO，新增可空 `execution`：

```ts
interface TestMessageExecution {
  taskId: string;
  taskStatus: string;
  flow: {
    id: string;
    name: string;
    versionId: string;
    version: number;
    digest: string;
  };
  agentDefaultModel: ModelSnapshot | null;
  nodeModels: Array<{
    nodeId: string;
    nodeName: string | null;
    nodeType: string;
    source: "agent-default" | "explicit";
    model: ModelSnapshot;
  }>;
}
```

`ModelSnapshot` 包含 `presetId`、可空名称、底层模型名和供应商标识。没有关联测试任务的用户消息或旧 assistant 消息返回 `execution: null`。

会话查询继续以 `userId + isTest=true` 隔离。只读取消息关联的测试任务，不把普通聊天任务混入 Admin 调试历史。

## 模型节点解析

节点模型配置按现有 Flow 编译语义解析：

- `agent`：`config.modelPreset`。
- `plan`：`config.modelPreset`。
- `plan-loop`：`config.executor.modelPreset`。
- `approval`：仅 `policy=model` 时读取 `config.modelPreset`。
- `synthesize`：`config.modelPreset`。
- 缺省值和 `agent-default` 均解析为任务冻结的 `resolvedAgentModelPresetId`。

这里描述的是冻结 Flow 的节点模型配置，不等同于“本轮实际调用过”。实际调用顺序继续由 `model.call.*` 事件和 trace 表达。

## 管理端交互

- 智能体选择器旁显示紧凑的“当前配置”摘要：Flow 名称/版本与默认模型。
- assistant 历史消息底部显示本轮 Flow 版本和模型数量摘要。
- 点击 assistant 消息进入现有轨迹面板时，在轨迹上方展示完整冻结快照。
- 实时运行期间复用 `flow.run.started` 与 `model.call.*` 事件更新右侧摘要，不新增协议事件。
- 配置缺失或无法解析时使用 warning 状态和原始稳定 ID；接口失败保留 error state，不展示为“未配置”。

## 验证

- 测试会话服务仅映射当前管理员的测试任务快照。
- 自定义 Flow 与内置直接回复 Flow 都能形成明确展示。
- `agent-default` 与节点显式模型能正确区分。
- 缺少关联任务或模型元数据时返回明确的空值或稳定 ID。
- API 单元测试、API build/lint、Admin typecheck/lint/build 通过。
- 手动验证发送前预览、运行中摘要、历史消息快照三种状态。

## 非目标

- 不修改数据库 schema，不新增迁移。
- 不新增或修改 SSE 事件。
- 不把节点配置模型统计成实际调用次数。
- 不改变智能体、Flow 或模型选择规则。
