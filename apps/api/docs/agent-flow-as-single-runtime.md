# Flow 成为唯一执行路径

**状态**：第 1～3 步已落地；第 4、5 步待做。

- ✅ 第 1 步 内置 Flow + Flow 成为唯一编排路径
- ✅ 第 2 步 旧编排链路标记 `@deprecated`（**未删除**，过几个版本再删）
- ✅ 第 3 步 DTO 与 admin 表单收敛
- ⬜ 第 4 步 移动端工具标签改为从 Flow 推导
- ⬜ 第 5 步 数据库迁移删列

本文只描述**这一次收敛**：把 Agent 从"既是身份又是编排配置"收敛成"身份 + 执行绑定"，让 Flow 成为唯一的编排路径。V2 的并行 / 变量 / 条件模型见 `agent-flow-v2-model.md`，运行时分层见 `agent-flow-architecture.md`，本文不重复。

## 0. 为什么要收敛

同一件事现在能在两个地方配，而其中一处对绑了 Flow 的 Agent 完全不生效。

Flow 链路只读 Agent 的两个字段（`agent-flow.activities.ts` 的 `loadExecutionContext`）：

```ts
select: { modelPreset: true, systemPrompt: true }
```

因此对绑了 Flow 的 Agent，下面这些是**死字段**——后台表单在显示 5 个点了不起作用的输入：

| Agent 字段 | 旧 agent-loop | Flow 链路 |
| --- | --- | --- |
| `systemPrompt` | ✓ | ✓ |
| `modelPreset` | ✓ | ✓ |
| `defaultStrategy` | ✓ | **死** |
| `allowedStrategies` | ✓ | **死** |
| `toolGroups` | ✓ | **死**（Flow 节点各自声明） |
| `skills` | ✓ | **死** |
| `maxSteps` | ✓ | **死**（Flow 用 `policy.maxSteps`） |

更深一层的问题是**两层猜测叠加**：群聊先用模型选出一个 Agent，然后 `StrategyRouter` 再用模型猜这个 Agent 该走 direct 还是 plan_execute。图上画明白能消掉第二层。

## 1. 收敛后的划分

```
Agent = 身份 + 执行绑定
        name / description / avatar / systemPrompt / enabled / isDefault
        + defaultFlowVersionId
        + modelPreset   ← 仅作 agent-default 的解析源，不是"这个 Agent 用什么模型"

Flow  = 全部执行配置
        模型 / 工具 / 技能 / 预算 / 编排
```

`modelPreset` 保留是刻意的：它让内置模板不写死部署环境的模型，也让**同一个 Flow 被多个 Agent 复用、各用自己的模型**。这是特性，不是遗留。表单标签应改为「默认模型」并说明用途。

## 2. agent-loop 只删一半

`src/modules/ai/agent-loop/` 共 3304 行，但它不是一个整体。**删的是决策层，执行层 Flow 现在就在调用**（`grep` 可验证：activities 里在调 `capabilityResolver` / `planner` / `stepEvaluator` / `commonChatAgentService`）。

删：

```
strategy-router.service.ts                     656 行   LLM 猜策略 + 关键词降级
strategy-registry.service.ts                    48      策略闭集与收敛
agent-loop-runner.service.ts                   201      按决策装配并驱动
graphs/                                        240      4 张策略图
common-chat-agent-runner.service.ts            213      旧编排入口
agent/agent-definition.service.ts               99      仅被上面这个消费
                                             ─────
                                              ~1457 行
```

留（Flow 依赖）：

```
agent-loop/capability/      registry + resolver —— 工具装配
agent-loop/execution/       planner / step-evaluator / plan-graph / plan-prompt
agent-loop/hitl/            审批 interrupt
agent-loop/agent-loop.types Flow 复用其输入类型
CommonChatAgentService      ReAct 循环、工具往返、流式事件
ChatContextService          历史 / 记忆 / 群聊语境
group-router.service        群聊选人（在 Flow 之外，不受影响）
```

### 必须保留、不能顺手删的

历史 trace 是**已物化的数据行**，渲染端只读 `item.type`，因此删掉生产者不影响回显——**前提是枚举值还在**。库中现存 `STRATEGY_DECISION` 69 条、`WORKFLOW_STEP` 60 条、`HYBRID_NODE` 6 条。

```
⚠ Prisma enum ConversationTraceItemType 的全部值
⚠ packages/types/protocol 的 StrategySelected / SkillSelected 类型
⚠ admin trace-viewer 的 STRATEGY_DECISION 分支
```

## 3. 未绑 Flow 的 Agent：内置系统 Flow

**内置 Flow 必须真实入库**，不能只存在于代码里。

初稿设想的是"代码内置、不入库的隐式 direct Flow"，实做前发现走不通：`StreamTask.flowVersionId` 是外键（`onDelete: Restrict`），activity 要读 `task.flowVersion.definition`，且要比对 `task.flowDigest === task.flowVersion.digest`。不入库就得让外键可空 + 加判别字段 + **特例化 digest 校验**——最后一条是硬伤：digest 校验的意义正是保证"这次运行用的 Definition 与启动时完全一致"，而代码里的定义会随部署改变。

因此：

```
启动时幂等 ensure：
  AgentFlow        { name: "内置 · 直接回复", createdById: null }
  AgentFlowVersion { definition: directPreset(), status: PUBLISHED }
  AgentFlow.publishedVersionId → 该版本
```

`createdById` 可空，系统 Flow 不需要归属某个用户。下游**零改动**：外键成立、定义读得到、digest 保证不变。

内置定义将来要改，就发布一个**新版本**——在途任务保留旧版本，正是版本机制该有的行为。

**形态**：Direct 不带工具（`start → agent`，`toolGroups: []`，`maxToolCalls: 0`）。这对应「只指定 llm 就默认 direct」。另有一个实测理由见 §6。

**后台可见但只读**：能打开画布看结构、能另存一份改成自己的，但不能编辑 / 删除 / 发布新版。可见的理由是不让"未绑 Flow 的 Agent"成为黑箱——trace 里出现的 `flowVersionId` 必须在后台查得到。

## 4. 各功能的执行链路

| 功能 | 链路 | 变化 |
| --- | --- | --- |
| 单聊 | Agent → 绑定的 Flow → Temporal | 从"猜策略"变成"按图" |
| 群聊选人 | `group-router` → agentId | **不变**（在任务创建前，Flow 之外） |
| 群聊语境 | `chat-context` 注入身份 + 花名册 | **不变**（Flow 已在调同一个） |
| 直接问答 | 内置 direct Flow | 等价于原 `direct` 策略 |
| 计划执行 | plan_execute 模板 | 等价于原 `plan_execute` |
| HITL 审批 | approval 节点 + `AgentFlowApproval` | 已实现 |
| 工具审批 | `requiresApproval` → interrupt → `/approval` | **不变**，仍由注册表推导 |
| 会话标题 | `LlmService` 直接调 | **不变**（不属于任何 Agent 的编排） |
| 记忆 / 摘要 | `ChatContextService` | **不变** |

群聊在收敛后更清楚：

```
现在：群路由选 Agent → 模型再猜它用哪套策略   （两层猜测）
之后：群路由选 Agent → 该 Agent 按自己的 Flow  （一层猜测）
```

而且群成员可以各绑不同 Flow（客服绑 direct、研究绑 plan_execute），这是现在做不到的——策略是 Agent 级的单一配置。

注意：**群路由自己要调模型**，它留在 Flow 之外（选人是编排的前置，不是编排的一部分）。所以"删掉 agent-loop"不等于"所有模型调用都进 Flow"。

## 5. 工具的分配与注入

收敛后**只在 Flow 节点上配**，`Agent.toolGroups` / `Agent.skills` 删除。注入链路不变：

```
Flow 节点 config: { toolGroups: ["default"], skills: [] }
  ↓ compileExecutor（任务锁定时）
CapabilityRegistry.getToolsByGroup(group)     ← 代码注册的闭集，非数据库
  ↓ 展开 skills → toolNames，逐个问 requiresApproval
CompiledAgentFlowNode { modelPreset, toolGroups, skills, approvalToolNames }
  ↓ CapabilityResolver.resolve（运行期）
commonChatAgentService.streamEvents({ tools, approvalToolNames })
```

三条不能松的约束：

1. **工具是代码注册的闭集**。Flow JSON 只能引用组名，不可能凭空造出一个工具。
2. **审批等级只由注册表推导**。Flow JSON 没有降低工具风险等级的入口——否则"画布可编辑"就等于"审批可绕过"。
3. **装配在编译期完成**，不是运行期猜的。这带来收敛的主要收益：**工具集变成可静态审计**——看一眼图就知道这个 Agent 能调什么，不用推演模型会怎么路由。

## 6. 一个实测发现（影响内置 Flow 的形态）

一次 join 测试的实测数据（问一句"你好"，`flow_tool_calls = 0`）：

| 节点 | 工具 | 耗时 |
| --- | --- | --- |
| agent / agent_2 | `["default"]`（2 个工具） | **~50s** |
| synthesize | 无 | **1.8s** |

同一模型、同一上游、**零工具调用**。仅仅把工具挂上去就从 1.8 秒变成 50 秒。`default` 组只有 `getWeather` 和 `webSearch`，schema 很小，不是提示词膨胀。

**根因未定**（最可能是模型在"要不要用工具"上做了大量推理，也可能是上游代理对带 tools 的请求走了不同路径）。定因需要一次对照实验。

顺带发现一个观测缺口：**trace 没有记录 token 用量**（`metrics` 里只有 `contentLength`），因此 reasoning token 是否爆掉看不出来。

这条数据是内置 Flow 选择"不带工具"的另一个理由。

## 7. 实施步骤

每步可独立验证与回滚。

**第 1 步 · 内置 Flow + 未绑 Agent 走它**
- 启动时 ensure 系统 Flow（幂等 upsert）
- `resolveTaskFlowSnapshot` 对未绑 Flow 的 Agent 返回该版本的 `{ id, digest }`
- 此后所有聊天走 Flow 链路；`AgentDefinitionService` 与两个 runner 变成无人调用（**先不删**）
- 验证：全量测试 + 手动跑「未绑 Flow 的 Agent」「绑 direct 的」「绑 plan_execute 的」「群聊」
- **这是唯一有行为风险的一步**，可整步回滚

**第 2 步 · 标记废弃（暂不删除）**

初稿把这一步写成"纯删除、风险极低"，**不准确**。实测发现 `common-chat-agent-runner`
的唯一调用者是 `stream-task.service.ts` 的 `runChatTask`（约 370 行的进程内 SSE
producer 循环），而 `common-chat-agent-runner → agent-loop-runner → strategy-router`
是一条链，删任何一环都会把整条拽下来。真实规模约 **2000+ 行**，横跨 stream-task 核心。

因此改为：**先标记 `@deprecated`，过几个版本再删**。

这条链现在**已不可达**：`resolveTaskFlowSnapshot` 总会给聊天任务锁定 Definition
（找不到可用 Agent 则明确抛错，不再返回 null），因此 `ensureTaskExecution` 永远走
Flow 分支。留着不影响运行，只是读代码的人要多确认一次。

删除时要注意的边界（`registry` 不是 producer 专属）：

| | 用途 | 处置 |
| --- | --- | --- |
| `registry.publish()` | SSE 事件扇出，**Flow 链路也在用** | ⚠️ 必须保留 |
| `registry.markRunning / isRunning / clearRunning / abortRunning` | 进程内运行注册 | 随 producer 一起删 |

`AGENT_WORKFLOW` 这个 StreamTaskType 枚举值**没有任何地方创建**，是死值，可一并清理。

**第 3 步 · DTO 与 admin 表单**
- Agent 的 create / update DTO 与响应去掉 5 个字段
- admin 表单删「编排策略」「允许策略」「工具组」「技能」「最大步数」，只留身份 + 默认模型 + Flow 绑定
- admin 手写 `src/api/types.ts` 同步（**两边漂移不会有任何工具报错**，必须手动核对）

**第 4 步 · 移动端工具标签改为从 Flow 推导**
- Agent 卡片的工具标签（`apps/mobile/src/pages/agents/index.tsx:74` 读 `agent.toolGroups`）
  改为遍历绑定 Flow 节点的 `toolGroups` 求并集，由 Agent 列表接口返回
- 需在 `apps/mobile/` 跑 `pnpm generate:api:local` 重新生成 orval 客户端

**⚠️ 顺序修正**：初稿把迁移排在移动端之前，错了。`AgentResponseDto.toolGroups` 是
移动端与 admin **共用**的字段（`@Controller('agents')` 同时服务两端），在改为从 Flow
推导之前它仍读 `Agent.toolGroups` 列。先删列会让移动端标签直接空掉。

**第 5 步 · 数据库迁移**
- 改 `schema.prisma` 删 5 个字段与 `AgentStrategy` 枚举
- 迁移名：`drop_agent_strategy_and_capability_fields`
- 必须最后做：字段先没人读、再删列，任何一步回滚都不会撞上"代码读一个已删的列"
- 删列会让仍标记为 `@deprecated` 的 `AgentDefinitionService` 编译失败（它 select 那些
  字段）。到时最小处理是删掉那几行 select，不必被迫删整条链

- Agent 卡片的工具标签（`apps/mobile/src/pages/agents/index.tsx:74` 读 `agent.toolGroups`）改为**从绑定 Flow 推导**：遍历 Flow 节点的 `toolGroups` 求并集，由 Agent 列表接口返回
- 需在 `apps/mobile/` 跑 `pnpm generate:api:local` 重新生成 orval 客户端

## 8. 已确认接受的代价

**① Temporal 从可选变必需。** 每条消息都走 Flow 派发 → worker 挂了**全站聊天不可用**（现在只影响绑 Flow 的 Agent）。生产内存地板从 171 MiB 变 678 MiB。

按实测，性能不是问题——单节点 Temporal 开销约 74ms（一次完整往返加上 activity 自己的数据库读写）。这纯粹是**依赖面**的代价。

将来若要做分流，判据不用"长任务 / 短任务"猜，而是**静态可判**的：图上有没有能进 `WAITING_HUMAN` 的节点。理由是同步聊天时用户在场，跑挂了重试即可，持久执行价值低；而明天才有人批的审批用户不在场，持久性是刚需。这件事与本次收敛解耦，A 完成后再做不会更贵——状态已全在 Postgres。

**② 「模型自动选策略」能力移除。** 现在 `AUTO` 让模型判断走 direct 还是 plan_execute，收敛后由管理员在图上画死。这**不是纯粹的简化，是一个真实功能的移除**。要恢复类似效果需用 condition 节点显式表达判据。

**③ 每个 Agent 必须有模型预设**，因为内置 direct Flow 用 `agent-default`。

## 9. 附：Temporal 与"从表重建"的能力边界

`AgentFlowNodeExecution` **只有终局态，没有 RUNNING**（枚举只有 `COMPLETED` / `STOPPED_*`）。因此从表重建只知道"哪些节点做完了"，永远不知道"此刻有谁在飞"。

这不是缺陷而是设计：节点执行靠 `(taskId, nodeExecutionId)` 唯一键幂等，"从已完成集合重算前沿、把没完成的重跑"是安全的。**这个幂等性已经建好，是 trace 式恢复可行的前提。**

在此前提下，Temporal 真正独占的只剩四件事：

| | Temporal | 从表重建 |
| --- | --- | --- |
| 幂等 | — | ✅ 已有（数据库唯一键） |
| 节点输出 / 预算 / 审批事实 | — | ✅ 已有（Postgres） |
| 重算前沿 | ✅ | ✅ 集合足够（前沿执行器基于集合设计） |
| 长时定时器（审批到期） | ✅ | ❌ 需扫描器 |
| 死进程检测 | ✅ | ❌ 需租约 + 过期回收 |
| 跨重启的重试退避 | ✅ | ❌ 需持久化重试列 |
| "此刻卡在哪"的可观测 | ✅ | ❌ |

容易高估的几点，实际不是 Temporal 独占：**幂等**由数据库唯一键保证；**Signal 可靠投递**我们已在 Temporal 前自建 `AgentFlowSignalOutbox`（说明其原生投递不够用）；**调度顺序确定性**不需要重放，因为前沿执行器基于 `completed` / `scheduled` 集合。

审批等待期间 Temporal **不保持任何东西运行**——Workflow 挂起，不占 CPU 与内存。它提供的是持久定时器与信号到达时的保证继续，不是"保活"。
