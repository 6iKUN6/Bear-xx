# ContributionGuide.md

## 目的

本文件用于约束 `Litter-Bear` 项目的提交信息格式、分类提交方式和提交前检查流程。

当用户输入 `commit`，或者明确要求执行提交操作时，应优先按照本文件的内容和引导完成提交。

## Commitlint 配置

项目根目录已经接入：

- `commitlint.config.mjs`
- `@commitlint/config-conventional`
- `husky` 的 `commit-msg` hook
- `commitizen` + `cz-git`

提交时会通过 `commitlint` 校验提交信息。推荐使用交互式提交：

```bash
pnpm commit
```

也可以直接提交：

```bash
git commit -m "type(scope): subject"
```

直接提交时必须保证格式符合本文件约定。

## 提交信息格式

标准格式：

```text
<type>(<scope>): <subject>
```

不需要 scope 时可以省略：

```text
<type>: <subject>
```

示例：

```text
feat(be): 补充 StreamTask 状态查询
fix(fe): 修复 h5 顶部安全距离错位
docs(all): 更新项目提交指南
chore(ci): 调整提交校验配置
```

## Type 规范

当前项目推荐使用以下 type：

- `feat`：新增功能
- `fix`：修复 bug
- `docs`：文档变更
- `style`：代码格式调整，不影响运行逻辑
- `refactor`：重构，不包含新功能或 bug 修复
- `perf`：性能优化
- `test`：测试相关
- `chore`：构建、工具、依赖、生成物等维护性变更
- `ci`：CI/CD 配置变更
- `revert`：回退提交

不要使用含义模糊的 type，例如 `update`、`change`、`misc`、`wip`。

## Scope 规范

当前项目推荐使用以下 scope：

- `fe`：前端工程 `frontend/`
- `be`：后端工程 `backend/`
- `all`：跨前后端、根目录或整体项目变更
- `ci`：CI/CD、提交校验、自动化流程

`commitlint.config.mjs` 允许自定义 scope，也允许省略 scope。

自定义 scope 应保持短小清晰，例如：

- `api`
- `auth`
- `stream-task`
- `agent`
- `db`

## Subject 规范

`subject` 是提交标题的简短描述，要求如下：

- 使用中文描述核心变更
- 保持简洁明确，推荐不超过 72 个字符
- 说明“做了什么”，不要只写“修改了代码”
- 不要以句号、感叹号等结尾
- 不要使用 emoji
- 不要写成空泛描述，例如 `fix: 修复问题`、`chore: 更新`

推荐写法：

```text
refactor(be): 收敛流式任务模块命名
chore(fe): 同步 StreamTask 接口类型
docs(all): 补充前后端开发条款
```

不推荐写法：

```text
fix: 修复问题
update: 更新代码
wip: 临时提交
feat: add something
```

## Body 规范

提交正文是可选项。当一次提交影响范围较大、包含迁移、接口变化或行为变化时，应补充正文。

正文建议说明：

- 本次提交改了哪些核心内容
- 是否影响接口、数据库、生成物或运行方式
- 是否包含兼容性处理
- 已执行哪些检查
- 还有哪些限制或后续事项

示例：

```text
refactor(be): 收敛流式任务模块命名

将业务层 sse-task 模块收敛为 stream-task。
SSE 仅保留为传输协议命名，业务任务使用 StreamTask 表达。
同步更新 ChatService 注入和 OpenAPI 文档。
```

## 分类提交原则

提交前应先根据改动性质分类，不要把无关内容混在同一个 commit 中。

推荐拆分方式：

- 数据库 schema 和 migration 单独提交
- 后端业务逻辑单独提交
- 前端页面或组件单独提交
- 前端 API 生成物单独提交
- 文档和协作规范单独提交
- 纯格式化或依赖变更单独提交

可以放在同一个 commit 的情况：

- 同一个功能必须同时修改 controller、service、dto
- 后端接口变更和对应 OpenAPI 更新属于同一 API 契约变更
- 一个 bug 修复需要同时调整测试用例

不建议放在同一个 commit 的情况：

- 业务重构混入无关格式化
- 前端 UI 调整混入后端接口改造
- 文档修订混入数据库迁移
- 生成物更新混入大量手写业务代码

## 提交前检查

提交前至少确认：

```bash
git status --short
git diff --check
```

根据改动范围执行必要检查：

- 后端改动：优先运行 `pnpm build`、相关测试或 e2e
- 前端改动：优先运行 `pnpm typecheck`、相关构建或页面验证
- API 契约变化：同步 OpenAPI 与前端 Orval 生成物
- 数据库变化：确认 Prisma schema、migration 和生成客户端是否一致

提交前还需要确认：

- 没有提交密钥、token、真实手机号、生产环境配置等敏感信息
- 没有提交无关缓存、日志、临时文件
- 没有把用户未要求提交的无关改动混入当前提交

## Agent 提交约束

对于 Codex 或其他自动化 agent：

- 用户没有明确要求提交时，不要直接执行 `git commit`
- 用户要求提交时，应先查看本文件，再进行分类提交
- 提交前应检查工作区，避免误提交用户未要求处理的改动
- 创建多个提交时，应在最终回复中列出提交哈希和提交标题
- 如果某些改动不适合提交，应保留在工作区并明确说明原因

## 常用提交示例

```text
feat(be): 补充 StreamTask 数据模型
refactor(be): 收敛流式任务模块命名
chore(fe): 同步 StreamTask 接口类型
docs(all): 更新流式任务协作文档
fix(fe): 修复小程序 wxss 编译错误
test(be): 补充流式任务恢复接口用例
```
