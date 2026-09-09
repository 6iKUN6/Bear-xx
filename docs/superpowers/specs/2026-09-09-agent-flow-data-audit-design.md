# AgentFlow 历史工件盘点与安全清理设计

## 目标

处理因 AgentFlow 契约持续演进产生的历史脏数据，同时保留运行审计事实。第一阶段提供一个后端运维脚本：默认只读盘点，只有显式传入 `--delete` 才清理满足严格保护条件的脏版本。

本阶段不修改 Flow Definition，不做 schema 兼容层，不改变任务执行语义，也不处理节点分类、结构化输出或 Flow 导入体验。

## 术语与数据边界

- **逻辑 Flow**：`AgentFlow`，承载名称、描述和版本集合。
- **Flow 工件**：`AgentFlowVersion`，保存不可变 Definition、digest、schemaVersion 和发布状态。
- **运行快照**：`StreamTask.flowVersionId` 与 `flowDigest`，代表任务启动时锁定的历史工件。
- **绑定关系**：Agent 的 `defaultFlowVersionId`，表示该版本当前被产品层 Agent 使用。
- **当前发布版本**：`AgentFlow.publishedVersionId` 指向的版本。
- **审计记录**：`AgentFlowAuditLog`，记录 Flow 控制面操作；删除版本时不单独删除日志，只有删除整个逻辑 Flow 时按现有级联关系处理。

历史版本按事实保留。仅“未发布、未被任务引用、未被 Agent 绑定”的不兼容草稿属于清理候选。

## 盘点脚本

文件：`apps/api/scripts/audit-agent-flow-versions.cjs`

命令：

```bash
node apps/api/scripts/audit-agent-flow-versions.cjs
node apps/api/scripts/audit-agent-flow-versions.cjs --format=json
node apps/api/scripts/audit-agent-flow-versions.cjs --delete
```

默认输出人类可读摘要；`--format=json` 输出机器可读报告。默认模式只执行查询，不写数据库。

每个版本报告以下事实：

- Flow ID、Flow 名称、版本 ID、版本号、状态、schemaVersion；
- Definition 是否能被解析；
- 当前 `validateFlowDefinition` 的校验结果和错误摘要；
- 是否为当前发布指针；
- 被多少条 `StreamTask` 引用；
- 被多少个 Agent 绑定；
- 是否存在审计日志；
- 是否满足删除候选条件。

解析失败与当前 schema 不兼容分开记录。仅因为旧 schemaVersion 不兼容，不足以成为删除理由；还必须满足草稿、无运行引用、无 Agent 绑定和非发布指针等条件。

## 删除规则

`--delete` 模式先重新查询候选记录，并在事务中再次检查保护条件，防止报告与实际删除之间发生竞态。

单个版本只有同时满足以下条件才删除：

1. `status = DRAFT`；
2. Definition 无法解析，或当前校验器判定不兼容；
3. `StreamTask.flowVersionId` 引用数为零；
4. Agent 的 `defaultFlowVersionId` 绑定数为零；
5. 不是 `AgentFlow.publishedVersionId` 当前发布版本。
6. 不属于系统维护的内置直接回复 Flow。

永不由本脚本删除：内置直接回复 Flow 的任何版本、已发布版本、被任务引用的版本、被 Agent 绑定的版本，以及仅因 schemaVersion 较旧但仍属于历史审计链的版本。

删除前打印版本 ID、Flow 名称、版本号和错误摘要；删除后打印实际删除结果。

## 空壳 Flow 处理

删除版本后，如果逻辑 Flow 不再有任何版本，仅当以下条件全部成立时删除 `AgentFlow`：

- 该 Flow 没有任务引用；
- 没有 Agent 绑定任何其版本；
- 没有发布指针；
- 所有原版本都已满足上述可删除条件。

只要存在任意受保护版本，就保留逻辑 Flow，不留下版本之外的隐式运行行为。删除逻辑 Flow 时沿用 Prisma 现有关系级联规则处理其 Flow 审计日志，不删除独立的任务运行记录。

## 并发与失败处理

- 删除事务使用现有 Prisma 客户端事务能力；删除前重新读取版本、Flow 发布指针、Agent 绑定和任务引用。
- 任一保护条件在事务内不满足，跳过该版本并报告“已变化”，不强制删除。
- 数据库错误导致事务回滚，并以非零退出码结束。
- 脚本不吞掉数据库错误，不返回伪成功。
- 脚本不执行迁移，不修改 `.env`，不输出 Definition 全文、用户凭据或模型密钥。

## 验证

- 使用测试数据库构造：合法草稿、不兼容草稿、已发布版本、被任务引用版本、被 Agent 绑定版本和空壳 Flow。
- 验证默认模式完全不改变记录数量。
- 验证 `--delete` 只删除安全候选，且重复执行具有幂等性。
- 验证发布指针、任务外键和 Agent 绑定不会因删除被破坏。
- 执行 `pnpm --filter ./apps/api run build` 与 `pnpm --filter ./apps/api run lint:check`。

## 后续阶段边界

节点分类、统一节点 `description`、JSON 导入与“创建并编辑”、结构化输出以及 Flow 生成 Flow 均作为独立阶段，不与本次数据清理脚本混合。分类先作为编辑器/文档元数据，不写入 Definition；`agent`、`synthesize` 的结构化输出在契约稳定后另行设计。
