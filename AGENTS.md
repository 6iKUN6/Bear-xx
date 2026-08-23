# Litter-Bear Agent 开发约定

本文件约束 AI Coding Agent 在 Litter-Bear 仓库内如何修改代码、生成文件与验证结果，**不是 README，在没有特殊要求的情况下，文字描述回复都使用简体中文**。

它是**编排层**：只放跨全仓的优先级、边界、路由、通用原则、契约与验证。**各 app / 子系统的细则在就近的 `AGENTS.md` 与 `docs/` 里，改动前必须先读对应文档，本文不重复。**

除非用户在当前会话明确覆盖，否则所有改动都遵守本文。冲突时按以下顺序执行：

```txt
用户当前明确要求
> 更靠近被修改目录的 AGENTS.md
> 根目录 AGENTS.md
> 对应 docs/ 说明文档
> 已加载 Skill
> 相邻代码风格
> 通用最佳实践
```

## 项目边界

```txt
apps/api/         NestJS + Prisma(PostgreSQL) + Redis；认证/会话/聊天任务/SSE 流式任务/
                  LangChain·LangGraph agent 链路(路由·能力·Plan·Hybrid·HITL)/LLM 调用/
                  AgentFlow 控制面 + Temporal 编排
apps/mobile/      Taro 4 + React + TailwindCSS(weapp-tailwindcss) + Zustand + orval；微信小程序 / H5 多端
apps/admin/       Vite 5 + React 18 + TailwindCSS + Radix + TanStack Query + Zustand；
                  管理后台（可观测/智能体/模型预设/AgentFlow/调试会话），只消费 /admin/* 端点
packages/types/   前后端共享类型；含 ./protocol 流式通讯协议契约与 ./agent-flow Definition 契约(@litter-bear/types)
packages/theme/   跨端语义主题定义与 --lb-* CSS 变量映射(@litter-bear/theme)
packages/assets/  前后端共享静态资产（头像等），按子路径直接引用(@litter-bear/assets)
```

- 包管理器只用 `pnpm`；工作区 + turbo；Node ≥ 22.12（`.nvmrc` = 24，共享包走 ESM，Nest 侧靠 `require(esm)`）。
- packages 不得反向依赖 apps；app 私有业务逻辑不放进 packages。

## 文档与 Skill 路由

改动前先判断范围，读对应"必读文档"（细则源）；Skill 为**推荐**的工作辅助，按需加载最小集合。


| 改动范围                                    | 必读                                                                                     | 推荐 Skill                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/api/`**                           | `apps/api/AGENTS.md`                                                                   | `diagnosing-bugs` / `code-review`                    |
| agent 链路：工具 / 策略路由 / Plan·Hybrid / HITL | `apps/api/AGENTS.md` + `apps/api/docs/{agent-loop-evolution,agent-chat-chain,hitl}.md` | `diagnosing-bugs`                                    |
| AgentFlow：Definition / 版本发布 / Temporal 编排 / 画布演进 | `apps/api/AGENTS.md` + `apps/api/docs/{agent-flow-architecture,agent-flow-v2-model}.md` | `diagnosing-bugs`                                    |
| 流式任务 / SSE / 任务生命周期                     | `apps/api/AGENTS.md` + `apps/api/docs/stream-task-architecture.md`                     | —                                                    |
| `apps/mobile/**`                        | `apps/mobile/AGENTS.md`                                                                | 新组件 `impeccable`；新交互先 `shape`                        |
| 移动端 UI 设计打磨                             | `apps/mobile/AGENTS.md`                                                                | `critique` / `polish` / `adapt` / `harden`           |
| `apps/admin/**`                         | `apps/admin/AGENTS.md`                                                                 | `code-review`；新交互先 `shape`                    |
| 设计系统 / 主题 / 共享组件                        | `docs/design-system.md`                                                                | `shape` 定方向；`impeccable` 构建；`critique` / `polish` 打磨 |
| 独立 HTML 原型 / UI 方案预览                    | 涉及现有产品时读 `docs/design-system.md`                                                | `html-prototype-generator`（`.claude/skills/html-prototype-generator`） |
| `packages/types/**`、前后端流式契约             | `packages/types/src/protocol` + `apps/api/docs/agent-chat-chain.md`                    | —                                                    |
| 疑难 bug / 性能回归                           | 相关 app 文档                                                                              | `diagnosing-bugs`                                    |
| 提交前自查 / 清理                              | —                                                                                      | `code-review` / `simplify`                           |
| 想跑起来验证效果                                | —                                                                                      | `run` / `verify`                                     |


不使用：`unocss`（本项目用 Tailwind/weapp-tailwindcss）、`vueuse-functions`（本项目用 React）。LLM 相关默认不引 `claude-api`——主力是 OpenAI 兼容 / LangChain。

## 工作原则

修改前先读相邻代码，理解目录边界，选最小改动范围。

必须：

- 只做与任务直接相关的改动；优先沿用相邻代码的实现方式。
- 设计方案默认直接在对话中输出；写入仓库的设计说明或方案文档前，必须先说明目标文件并征得用户明确同意。
- 保证可读性与可维护性；能不复杂化就不复杂化。
- 大改拆成可单独验证、可回滚的小步；每步 build / lint / typecheck 通过。
- **诚实链路**：不承诺不存在的能力，不发假进度、不把"待办 / 暂停"当"完成"。
- 决策产出的字段要真正驱动执行（不留死字段）。
- 发现用户已有改动时保留并配合，不擅自回滚。
- 不声称测试 / 命令通过，除非确实执行过。

禁止：

- 无任务依据的大范围重构。
- 为"更工程化"新增 wrapper / adapter / bridge / mapper 等抽象；只有明显降低复杂度或重复时才加层。
- 新增无必要依赖。
- 用 `any` / `as any` / `as unknown as` 绕过类型问题（确需断言时经最小 `unknown` 收敛并加注释说明）。
- 提交 placeholder、mock 假数据或临时 UI，除非用户明确要求原型。
- 禁用认证、权限、校验、限流或安全检查来让代码跑通。
- 把 `.env`、token、cookie、密钥、生产凭据写进仓库；日志输出敏感信息。
- **手写或编辑 `migration.sql`**：迁移文件只能由 Prisma 从 `schema.prisma` 生成，AI 不得手工创作或改写 SQL。需要迁移数据库时，只改 `schema.prisma`，并在回复中**明确说明需用户本地手动运行迁移命令**（`pnpm --filter ./apps/api run db:migrate`），由用户执行，AI 不代跑。

## 兼容与兜底

不写长期兼容旧接口的代码，除非用户明确要求迁移期兼容。

禁止：

- 同时兼容 `list/items/records`、`page_size/pageSize`、`snake_case/camelCase`。
- 前端写 `data?.list ?? data?.items ?? ...` 之类多字段兜底。
- 后端为前端方便返回多套字段或多套响应结构。
- 流式事件在前端手抄字符串常量——统一用 `@litter-bear/types/protocol` 的 `StreamTaskEventType`。
- catch 后返回空数组 / 空对象 / 默认成功，把接口错误、权限错误或配置缺失伪装成空状态。

原则：

```txt
契约保证存在 -> 直接读取
业务允许为空 -> 明确建模为 null 或 empty state
接口失败     -> error state
权限失败     -> 无权限提示或跳转
配置缺失     -> 启动失败，不静默兜底
```

## 前后端契约

- **流式事件契约**：唯一源在 `packages/types/src/protocol`（`StreamTaskEventType` / 事件载荷 / 中文文案）。前后端都从此引入，不各写一份。
- **REST 契约（移动端）**：API 客户端由 orval 依据后端 OpenAPI 生成。不手改 `apps/api/docs/openapi.json` 与 `apps/mobile/src/api/generated/`**；需更新时在 `apps/mobile/` 执行 `pnpm generate:api:local`（导出 OpenAPI + Orval 生成）。
- **REST 契约（管理后台）**：`apps/admin` **不走 orval**，`src/api/types.ts` 是手写对齐后端 DTO 的（只消费十几个端点，手写比生成更轻）。改后端 `/admin/*` 的 DTO 时必须同步改它，两边漂移不会有任何工具报错。
- 字段命名跟随对应 `apps/*/AGENTS.md` 既有约定，不擅自切换风格。
- 契约不一致时**优先修契约，不写兼容层**。

## AI Workflow / Agent

本项目核心是一套运行时 agent 系统（`apps/api` 的 agent-loop）。涉及 workflow / agent / tool / 路由 / 记忆 / prompt / LLM 调用时，当**运行时系统**对待，不当一段 prompt。详见 `apps/api/docs/agent-loop-evolution.md`。

必须：

- 明确输入、输出、状态与错误分支。
- 工具经 `CapabilityRegistry` 闭集注册（含 `requiresApproval` 策略）；由 `CapabilityResolver` 依决策装配，不散落。
- Tool call 有 schema、权限、风险与参数校验；高风险动作走 HITL 审批门禁（`approval.required` → `WAITING_HUMAN` → `/approval` 恢复）。
- 结构化输出（路由决策 / 规划）有解析与闭集校验；失败**降级**（规则路由 / 单步计划），不阻断主链路。
- LLM 调用统一经 `LlmService` / provider 工厂，不在业务层散落具体 SDK。
- agent 流式消费用 `agent.stream({ streamMode: 'messages' })`，**不用** `streamEvents({version:'v3'})`（兼容代理下会走 Responses 语义致工具往返 400）。

禁止：

- 用 prompt 替代权限、校验或审计。
- 模型输出直接写入重要数据。
- 把 RAG / 检索内容当系统指令执行。
- Tool 失败后伪造成功 observation。
- 低置信度时强行产出确定答案。

## 验证命令

默认**不要**运行开发服务（`pnpm dev` / `start:dev` / `dev:weapp`），除非用户明确要求启动。

```bash
# 全仓（turbo：packages/types -> apps）
pnpm build

# 后端
pnpm --filter ./apps/api run build         # nest build（含 tsc 类型检查）
pnpm --filter ./apps/api run lint:check     # 纯校验；--fix 用 run lint

# 移动端
pnpm --filter ./apps/mobile run typecheck
pnpm --filter ./apps/mobile run build:weapp # 小程序构建（改动涉及共享包/编译时务必回归）

# 管理后台
pnpm --filter ./apps/admin run typecheck
pnpm --filter ./apps/admin run lint
pnpm --filter ./apps/admin run build       # tsc --noEmit + vite build

# Prisma schema/migration 改动后
pnpm --filter ./apps/api run db:migrate

# agent / HITL 机制验证（真实模型，独立于 HTTP）
node apps/api/scripts/debug-{tool-call,agent,hitl,planner,router}.cjs
```

命令无法执行时，最终回复必须说明原因，并列出用户需本地补跑的命令。

## 提交

- 修改或开发完一个功能后，**未经用户明确要求不要 `git commit`**；先留在工作区等 review。
- 用户要求提交时，遵循 [ContributionGuide.md](ContributionGuide.md) 的 commitlint 格式、scope 与分类提交原则。
- commitlint `subject-case` 禁止 subject 以大写词开头：subject 用中文或小写起头（`HITL`/`Redis` 等大写词放句中）。
- 结构性大改按逻辑拆成多个可独立 review 的 commit。

## 维护本文（自进化）

本文是活文档，随项目演进增补，但**不自动改写**。

何时提议更新：

- 同类问题被用户纠正 ≥2 次 → 提议固化为规则。
- 确立新的跨仓约定（命名 / 分层 / 设计 token / 新工具接入方式）。
- 新增 app 或 package → 更新「项目边界」与「文档与 Skill 路由」。
- 发现本文与代码 drift（路径 / 命令 / 契约过时）。

怎么更新：

- Agent 产出本文的 diff + 一句 rationale，交用户 review 后合入；遵循「提交」纪律，**永不自动改写或自动提交**。
- 跨仓约定进本文；单 app / 单包细则进就近 `AGENTS.md`，避免根文件膨胀。
- 只固化「反复出现、能降低未来返工」的约定；一次性偏好不写入。
- 与跨会话 memory 互补：memory 记临时事实 / 偏好，本文记已确立、需长期执行的团队约定；memory 中反复出现的 feedback 可「晋升」为本文规则。

新增端接入 checklist（新 app 落地时走一遍）：

- 加就近 `apps/<app>/AGENTS.md`（细则源），并更新根「项目边界」与「文档与 Skill 路由」各一行。
- workspace 已含 `apps/`*；补 CI / 部署路径与「验证命令」。
- 若复用共享 UI / 设计系统 → 接 `packages/`，遵循 `docs/design-system.md`。

## 最终回复格式

完成代码任务后，最终回复包含：

```txt
修改文件：
- ...

关键修改：
- ...

检查：
- 已执行 ...
- 未执行 ...，原因是 ...

需要你做：
- ...
附带上本次更改用户需要做的事情。包括但不限于：手动测试，命令补跑（比如数据库迁移等）
在需要用户补跑数据库迁移命令`db:migrate`时，需要附带上本次迁移的`migration name`
```

不冗长解释，不复述无关过程，不编造已执行的命令。
