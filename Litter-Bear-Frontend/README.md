# Litter-Bear 小程序

基于 Taro 4.x 的跨端小程序项目，支持微信 / 支付宝 / H5 等多端适配。

## 技术栈

| 类别 | 选型 |
|------|------|
| 框架 | Taro 4.1.11 + React 18 |
| 语言 | TypeScript |
| UI 组件库 | Taro UI 3.3 |
| CSS | TailwindCSS 3.x + Sass |
| 小程序 TW 适配 | weapp-tailwindcss（Vite 插件模式） |
| 构建工具 | Vite |
| 包管理 | pnpm |
| 状态管理 | Zustand |

## 环境要求

- Node.js >= 18
- pnpm >= 8
- [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（微信小程序调试用）
- [支付宝小程序开发者工具](https://opendocs.alipay.com/mini/ide/overview)（支付宝小程序调试用，可选）

## 安装依赖

```bash
cd Litter-Bear
pnpm install
```

## 开发

### 微信小程序

```bash
pnpm dev:weapp
```

启动后用微信开发者工具打开项目根目录下的 `dist` 文件夹。

### 支付宝小程序

```bash
pnpm dev:alipay
```

启动后用支付宝小程序开发者工具打开 `dist` 文件夹。

### H5

```bash
pnpm dev:h5
```

启动后在浏览器中访问控制台输出的地址（默认 `http://localhost:10086`）。

### 其他平台

```bash
pnpm dev:swan      # 百度小程序
pnpm dev:tt        # 抖音小程序
pnpm dev:qq        # QQ 小程序
pnpm dev:jd        # 京东小程序
```

## 构建

将 `dev:` 替换为 `build:` 即可生成生产包：

```bash
pnpm build:weapp   # 微信小程序
pnpm build:alipay  # 支付宝小程序
pnpm build:h5      # H5
```

产物输出到 `dist/` 目录。

## 项目结构

```
Litter-Bear/
├── config/
│   ├── index.ts           # Taro 主配置（Vite 插件、PostCSS 注册）
│   ├── dev.ts             # 开发环境配置
│   └── prod.ts            # 生产环境配置
├── src/
│   ├── pages/
│   │   └── index/
│   │       ├── index.tsx  # 首页组件
│   │       └── index.scss
│   ├── store/
│   │   └── index.ts       # Zustand 全局状态
│   ├── app.config.ts      # 小程序全局配置（页面路由、窗口等）
│   ├── app.scss           # 全局样式入口（Taro UI + TailwindCSS）
│   ├── app.ts             # 应用入口
│   └── index.html         # H5 入口模板
├── tailwind.config.js     # TailwindCSS 配置
├── tsconfig.json
├── project.config.json    # 微信小程序项目配置
└── package.json
```

## 关键配置说明

### TailwindCSS

- Taro 4.x Vite 模式下 `postcss.config.js` 不生效，PostCSS 插件通过 `config/index.ts` 内联注册。
- `weapp-tailwindcss` 负责将 TailwindCSS 的 `rem` 单位转换为小程序 `rpx`，并处理类名转义。该插件在 H5 / Harmony / RN 平台自动禁用。
- `tailwind.config.js` 中已关闭 `preflight`（小程序环境不需要 CSS Reset）。

### Taro UI

- 全局样式在 `src/app.scss` 中通过 `@import 'taro-ui/dist/style/index.scss'` 引入。
- 也可按需引入单个组件样式以减小包体积：
  ```scss
  @import 'taro-ui/dist/style/components/button.scss';
  ```
- 组件文档：https://taro-ui.jd.com/#/docs/introduction

### Zustand

状态定义在 `src/store/index.ts`，在组件中通过 hook 使用：

```tsx
import { useAppStore } from '../../store'

const { count, increment } = useAppStore()
```

## 提交规范

项目使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范，通过 husky + commitlint 在提交时自动校验。

### 提交流程

```bash
git add .
pnpm commit
```

`pnpm commit` 会依次引导你完成：

1. **选择 type** — 从列表中选择本次提交的类型
2. **填写 scope** — 输入修改范围（可选，回车跳过）
3. **填写描述** — 输入简短的变更说明（不超过 72 个字符）
4. **填写详细描述** — 补充更多信息（可选，回车跳过）
5. **确认提交**

程序会自动拼接为 `<type>(<scope>): <subject>` 格式并执行 `git commit`。

如需手动提交，注意冒号后必须有一个空格：

```bash
git commit -m "feat(store): 新增用户状态管理"
```

### 可用 type

| type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修复 bug |
| `docs` | 文档变更 |
| `style` | 代码格式（不影响逻辑） |
| `refactor` | 重构（非新功能、非修复） |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `chore` | 构建 / 工具 / 依赖变更 |
| `ci` | CI 配置变更 |
| `revert` | 回退提交 |

## 常见问题

### 微信开发者工具提示 appid 无效

`project.config.json` 中 `appid` 默认为 `touristappid`（游客模式）。如需真机调试或发布，请替换为你在[微信公众平台](https://mp.weixin.qq.com/)注册的小程序 AppID。

### Sass 编译出现 deprecation warnings

taro-ui 的样式使用了 Sass 旧版 `@import` 语法和全局内置函数，Dart Sass 2.x 会输出弃用警告。这不影响编译结果，可忽略。

### pnpm install 提示 peer dependency 警告

React Native 相关的 peer dependency 警告可忽略，项目未使用 RN 平台。
