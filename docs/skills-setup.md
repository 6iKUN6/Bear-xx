# Agent Skills 安装

本项目的 [AGENTS.md](../AGENTS.md) 路由表按改动范围**推荐**一些 Agent Skills（工作辅助，非"必须加载"）。这些 skill 来自开放生态 [skills.sh](https://skills.sh)（`npx skills`），**安装到用户级** `~/.claude/skills/`，不随仓库分发。团队成员各自安装一次即可。

> 也可选择把用到的 skill vendored 进本仓库 `.claude/skills/` 并提交（免安装、可移植），但需逐个确认各 skill 的开源许可，并自行维护更新。当前采用"用户级安装 + 本文档记录命令"的轻量方案。

## 推荐 skill 与来源

| Skill | 用途 | 来源 |
| --- | --- | --- |
| `impeccable` | 构建高质量前端组件/页面 | `pbakaus/impeccable` |
| `shape` | 写码前规划 UX/UI 方向与约束 | `pbakaus/impeccable` |
| `critique` / `polish` | UI 评审与收尾打磨 | `pbakaus/impeccable` |
| `adapt` / `harden` | 响应式适配 / 边界与健壮性 | `pbakaus/impeccable` |
| `diagnosing-bugs` | 疑难 bug、性能回归的诊断循环 | `mattpocock/skills` |
| `code-review` | 对当前 diff 做正确性/简化审查 | `mattpocock/skills` |
| `simplify` | 复用/简化/效率清理 | `mattpocock/skills` |
| `run` / `verify` | 跑起来验证改动、确认行为 | `mattpocock/skills` |
| `tdd` | 测试先行（可选） | `mattpocock/skills` |

不使用：`unocss`（本项目用 Tailwind/weapp-tailwindcss）、`vueuse-functions`（本项目用 React）。

## 安装

```bash
# 发现（返回 owner/repo@skill 与安装量）
npx skills find <关键词>

# 安装到用户级全局（~/.claude/skills）
npx skills add pbakaus/impeccable -g -y      # 设计类合集
npx skills add mattpocock/skills   -g -y      # 工程类合集

# 或只装单个
npx skills add mattpocock/skills@tdd -g -y
npx skills add pbakaus/impeccable@critique -g -y

# 维护
npx skills check      # 检查更新
npx skills update     # 更新全部
```

`-g` = 用户级（不绑定某仓库），`-y` = 跳过确认。

## 使用

安装后，Claude Code 会话即可用；也可手动 `/<skill-name>` 调用（如 `/impeccable`、`/critique`）。具体在什么改动范围下推荐哪个，见 [AGENTS.md](../AGENTS.md) 的「文档与 Skill 路由」。
