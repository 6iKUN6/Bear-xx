# Litter-Bear 开发规划

## 一、目标产品形态

参考豆包移动端，核心功能模块：

| 模块     | 说明                                       |
| -------- | ------------------------------------------ |
| AI 聊天  | 多轮对话、流式输出、Markdown 渲染、语音输入 |
| AI 画图  | 文生图、图片预览/保存/分享                  |
| 用户系统 | 微信登录、个人主页、设置                    |
| 会话管理 | 历史会话列表、新建/删除/重命名会话          |

## 二、技术架构

### 技术栈

- **框架：** Taro 4.1.11 + React 18
- **语言：** TypeScript 5
- **状态管理：** Zustand 5
- **样式：** TailwindCSS 3 + Sass + Taro UI 3
- **构建工具：** Vite
- **包管理：** pnpm
- **代码规范：** ESLint + StyleLint + Husky + Commitizen

### 目录结构规划

```
src/
├── api/                  # 请求层
│   ├── request.ts        # Taro.request 封装 (拦截器、token、错误处理)
│   ├── chat.ts           # 聊天相关 API
│   ├── image.ts          # 画图相关 API
│   └── user.ts           # 用户相关 API
├── components/           # 通用组件
│   ├── ChatBubble/       # 聊天气泡 (支持文本/图片/Markdown)
│   ├── ChatInput/        # 输入栏 (文本+语音切换)
│   ├── MessageList/      # 消息列表 (虚拟滚动)
│   ├── ImageCard/        # 图片展示卡片
│   ├── NavBar/           # 自定义导航栏
│   └── Empty/            # 空状态占位
├── hooks/
│   ├── useRecord.tsx     # 录音 (已有)
│   ├── useSSE.ts         # 流式响应处理
│   └── useAuth.ts        # 登录态管理
├── store/
│   ├── index.ts          # 已有
│   ├── chatStore.ts      # 聊天状态 (会话列表、当前消息)
│   ├── imageStore.ts     # 画图状态
│   └── userStore.ts      # 用户状态 (token、用户信息)
├── pages/
│   ├── index/            # 首页 → 改造为聊天门户
│   ├── chat/             # 聊天对话页
│   ├── image/            # AI 画图页
│   ├── history/          # 历史会话列表
│   ├── profile/          # 个人主页
│   └── login/            # 登录页
├── types/
│   ├── chat.d.ts         # 消息、会话类型
│   ├── image.d.ts        # 画图相关类型
│   └── user.d.ts         # 用户相关类型
└── utils/
    ├── storage.ts        # 本地缓存封装
    ├── format.ts         # 时间/文本格式化
    └── constants.ts      # 常量定义
```

### 核心类型定义

```typescript
// 消息
interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  type: "text" | "image" | "audio";
  status: "sending" | "streaming" | "done" | "error";
  createdAt: number;
}

// 会话
interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

// 用户
interface User {
  id: string;
  nickname: string;
  avatarUrl: string;
}
```

## 三、分阶段开发计划

### Phase 1 — 基础框架搭建

**目标：** 跑通页面路由、请求层和用户登录

- [ ] 封装 `api/request.ts`（统一请求、拦截器、token 注入、错误提示）
- [ ] 实现 `userStore`（登录态、用户信息持久化）
- [ ] 实现登录页（微信一键登录 `wx.login` → 后端换 token）
- [ ] 搭建 TabBar 底部导航（首页 / 画图 / 我的）
- [ ] 实现自定义 NavBar 组件
- [ ] 配置页面路由和权限守卫（未登录跳登录页）

### Phase 2 — AI 聊天核心

**目标：** 完整的多轮对话体验

- [ ] 实现 `chatStore`（会话 CRUD、消息列表管理）
- [ ] 首页改造：展示最近会话 + 快捷入口 + "新建对话" 按钮
- [ ] 聊天页核心：
  - `MessageList` 组件：消息渲染、自动滚底、加载历史
  - `ChatBubble` 组件：区分用户/AI 气泡样式
  - `ChatInput` 组件：文本输入 + 发送按钮
- [ ] 对接后端聊天 API（流式响应 SSE / WebSocket）
- [ ] 实现 `useSSE` Hook 处理流式输出、逐字渲染
- [ ] Markdown 简单渲染（加粗、代码块、列表）
- [ ] 消息状态处理（发送中 → 流式中 → 完成 / 错误重试）

### Phase 3 — 语音输入

**目标：** 利用已有的 `useRecord` hook 实现语音转文字

- [ ] `ChatInput` 增加语音/文本切换模式
- [ ] 语音录制 UI（按住说话 + 录音动画）
- [ ] 录音完成后调语音识别 API 转文字
- [ ] 转写结果填入输入框或直接发送

### Phase 4 — AI 画图

**目标：** 文生图功能

- [ ] 实现 `imageStore`（画图任务管理、历史记录）
- [ ] 画图页：提示词输入 + 风格/尺寸选择
- [ ] 对接文生图 API（轮询 / 回调获取结果）
- [ ] 生成结果展示：图片预览 + 保存到相册 + 分享
- [ ] 历史画作列表（瀑布流 / 网格布局）

### Phase 5 — 体验打磨

**目标：** 完善细节和用户体验

- [ ] 会话管理页：历史会话列表、搜索、删除、重命名
- [ ] 个人主页：用户信息展示、设置项（清除缓存等）
- [ ] 长列表性能优化（虚拟滚动）
- [ ] 全局错误处理与离线提示
- [ ] 骨架屏 / Loading 状态优化

## 四、后端依赖说明

小程序端需要配合后端提供以下接口：

| 接口                       | 说明                   |
| -------------------------- | ---------------------- |
| `POST /auth/login`         | 微信 code 换 token     |
| `GET /user/profile`        | 获取用户信息           |
| `POST /chat/completions`   | 聊天补全（流式返回）   |
| `GET /conversations`       | 会话列表               |
| `POST /conversations`      | 创建会话               |
| `DELETE /conversations/:id`| 删除会话               |
| `POST /image/generate`     | 文生图                 |
| `GET /image/tasks/:id`     | 查询画图任务状态       |
| `POST /speech/recognize`   | 语音识别               |

## 五、建议优先级

推荐从 **Phase 1 → Phase 2** 开始，这两步完成后就具备了可用的 AI 聊天小程序原型。Phase 3-5 可根据实际需求灵活调整顺序。
