# AGENTS.md

## 项目概况

`Litter-Bear` 是一个 pnpm workspace + turbo 的 monorepo AI 应用项目：

- `apps/mobile/`：前端工程，基于 Taro + React，主要兼容微信小程序和 H5，样式方案以 Tailwind CSS 与 weapp-tailwindcss/vite 为主。
- `apps/api/`：后端工程，基于 NestJS，负责认证、用户、会话、聊天任务、SSE 流式任务、LLM 调用等服务能力。
- `packages/types/`：前后端共享类型（含 `./protocol` 流式通讯协议契约）。

## 目录规范

前后端的具体开发约束、接口约定、运行注意事项和历史问题说明，请优先查看对应目录下的文档：

- 前端开发明细：[apps/mobile/AGENTS.md](apps/mobile/AGENTS.md)
- 后端开发明细：[apps/api/AGENTS.md](apps/api/AGENTS.md)
- 提交指南：[ContributionGuide.md](ContributionGuide.md)

## 通用开发条款

- 务必保证代码的可读性和可维护性，命名、分层、注释和模块边界应尽量清晰。
- 在业务允许的情况下，不要将代码和项目架构复杂化。
- 只有在当前结构无法满足需求，或者新增抽象能够明显降低复杂度、重复代码或维护成本时，才引入新的层级、模式或通用封装。
- 修改应尽量保持范围可控，优先完成可验证、可回滚、对现有行为影响清晰的变更。
- 修改或开发完一个功能后，在用户没有特别说明需要提交的情况下，不要直接执行 `git commit`；应先保留在工作区，等待用户 review 或明确指令。
- 当用户输入 `commit` 或明确要求进行提交操作时，必须先阅读并遵循 [ContributionGuide.md](ContributionGuide.md)，按照其中的 commitlint 格式、scope 约定、分类提交原则和提交前检查流程执行。
- 每次修改完代码都要运行一次`format`,保证代码格式
- 不要主动手工修改 `apps/api/docs/openapi.json`；需要更新前端 API 类型或 OpenAPI 快照时，统一在 `apps/mobile/` 下执行 `pnpm generate:api:local`，由脚本导出 OpenAPI 并运行 Orval 生成。
