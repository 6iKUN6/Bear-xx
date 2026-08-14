# 智能体默认回复与首字头像 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除默认头像图片，以名称首字作为空头像回退，并允许管理员安全切换全局默认回复智能体。

**Architecture:** 复用 `Agent.isDefault`，通过管理员专用的无请求体接口完成默认项切换。服务层在可串行化 Prisma 事务中校验目标、清除旧默认并设置目标，对 P2034 冲突有限重试；停用或删除智能体也在同一并发控制边界内拒绝当前默认项。Admin 和小程序各自使用本端头像组件处理空 URL 与加载错误，小程序不再把“默认头像”伪装成图片 URL。

**Tech Stack:** NestJS 11、Prisma/PostgreSQL、Jest、React/Vite、Taro 4 React、TailwindCSS、TanStack Query。

---

## 文件结构

- `apps/api/src/modules/agent/agent.service.ts`：默认智能体切换、并发保护与停用保护。
- `apps/api/src/modules/agent/agent.controller.ts`：管理员切换默认回复智能体的 HTTP 入口。
- `apps/api/src/modules/agent/agent.service.spec.ts`：服务层事务、校验与缓存失效测试。
- `apps/api/docs/openapi.json`、`apps/mobile/src/api/generated/**`：由 OpenAPI/Orval 生成，反映新接口；不手工编辑。
- `apps/admin/src/api/endpoints.ts`、`apps/admin/src/hooks/queries.ts`、`apps/admin/src/pages/agent-manage.tsx`：列表中的默认切换操作与请求状态。
- `apps/admin/src/components/agent-identity.tsx`：Admin 的图片/首字头像统一渲染。
- `apps/admin/src/components/agent-form-sheet.tsx`：编辑抽屉预览复用首字头像。
- `apps/mobile/src/utils/agent.ts`、`apps/mobile/src/utils/agent.test.ts`：头像 URL 判定和 Unicode 首字纯函数。
- `apps/mobile/src/components/AgentAvatar/index.tsx`：小程序头像渲染及图片失败回退。
- `apps/mobile/src/components/{AgentSheet,MemberBar,ChatBubble,ChatInput,HistoryDrawer,NewChatPanel}/index.tsx`、`apps/mobile/src/pages/{agents,agent-picker}/index.tsx`：所有智能体身份展示改用 `AgentAvatar`。
- `apps/{admin,mobile}/package.json`、`pnpm-lock.yaml`：删除无用的 `@litter-bear/assets` 工作区依赖并同步锁文件。
- `packages/assets/README.md`：删除旧图片的导入示例和资产说明。

### Task 1: 默认智能体切换的后端契约与测试

**Files:**
- Create: `apps/api/src/modules/agent/agent.service.spec.ts`
- Modify: `apps/api/src/modules/agent/agent.service.ts`
- Modify: `apps/api/src/modules/agent/agent.controller.ts`

- [ ] **Step 1: 写出服务层失败测试**

```ts
import { Test } from '@nestjs/testing';
import { Agent, AgentStrategy } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentDefinitionService } from './agent-definition.service';
import { AgentService } from './agent.service';

function buildAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-default',
    name: '默认助手',
    description: '',
    avatar: null,
    systemPrompt: null,
    modelPreset: null,
    defaultStrategy: AgentStrategy.AUTO,
    allowedStrategies: [],
    toolGroups: [],
    skills: [],
    maxSteps: null,
    enabled: true,
    isDefault: true,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function buildService(overrides: Partial<Agent> = {}) {
  const target = buildAgent(overrides);
  const prisma = {
    agent: {
      findUnique: jest.fn().mockResolvedValue(target),
      update: jest.fn().mockResolvedValue({ ...target, isDefault: true }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: { agent: typeof prisma.agent }) => Promise<unknown>) =>
      callback({ agent: prisma.agent }),
  );
  const definitions = { invalidate: jest.fn() };
  const module = await Test.createTestingModule({
    providers: [
      AgentService,
      { provide: PrismaService, useValue: prisma },
      { provide: AgentDefinitionService, useValue: definitions },
    ],
  }).compile();

  return { service: module.get(AgentService), prisma, definitions };
}

it('设为默认时，在一个事务中取消旧默认、标记新默认并失效缓存', async () => {
  const { service, prisma, definitions } = await buildService({
    id: 'agent-new',
    name: '新助手',
    enabled: true,
    isDefault: false,
  });

  await service.setDefault('agent-new');

  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  expect(prisma.agent.updateMany).toHaveBeenCalledWith({
    where: { isDefault: true, id: { not: 'agent-new' } },
    data: { isDefault: false },
  });
  expect(prisma.agent.update).toHaveBeenCalledWith({
    where: { id: 'agent-new' },
    data: { isDefault: true },
  });
  expect(definitions.invalidate).toHaveBeenCalledTimes(1);
});

it('拒绝将停用智能体设为默认，且不修改默认标记', async () => {
  const { service, prisma } = await buildService({ enabled: false });

  await expect(service.setDefault('agent-disabled')).rejects.toThrow(
    '停用的智能体不可设为默认',
  );

  expect(prisma.agent.updateMany).not.toHaveBeenCalled();
});

it('拒绝停用当前默认智能体', async () => {
  const { service, prisma } = await buildService({ isDefault: true });

  await expect(service.update('agent-default', { enabled: false })).rejects.toThrow(
    '默认智能体不可停用',
  );

  expect(prisma.agent.update).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行测试，确认当前实现尚未提供所需行为**

Run: `pnpm --filter ./apps/api test -- --runInBand src/modules/agent/agent.service.spec.ts`

Expected: FAIL，提示 `setDefault` 不存在或停用保护未实现。

- [ ] **Step 3: 实现最小服务逻辑和受限路由**

```ts
/**
 * 设置全局默认回复智能体
 * @param id 目标智能体ID
 * @returns 返回设置完成后的智能体信息
 * @description 在可串行化事务内校验目标并先取消其他默认项，避免并发切换留下多个默认项；普通聊天未指定智能体时解析到该项。
 */
async setDefault(id: string): Promise<AgentResponseDto> {
  const agent = await this.runSerializableTransaction(async (tx) => {
    const target = await tx.agent.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('智能体不存在');
    if (!target.enabled) throw new BadRequestException('停用的智能体不可设为默认');
    await tx.agent.updateMany({
      where: { isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
    return tx.agent.update({ where: { id }, data: { isDefault: true } });
  });
  this.agentDefinitionService.invalidate();
  return this.toResponse(agent);
}

if (agent.isDefault && dto.enabled === false) {
  throw new BadRequestException('默认智能体不可停用');
}
```

```ts
@Patch(':id/default')
@UseGuards(RolesGuard)
@Roles('ADMIN')
@ApiOperation({ summary: '设为默认回复智能体（管理员）' })
@ApiOkResponse({ type: AgentResponseDto })
async setDefault(@Param('id') id: string) {
  return this.agentService.setDefault(id);
}
```

- [ ] **Step 4: 运行服务层测试确认通过**

Run: `pnpm --filter ./apps/api test -- --runInBand src/modules/agent/agent.service.spec.ts`

Expected: PASS，默认切换、可串行化隔离、P2034 重试、停用/删除默认保护均通过。

### Task 2: 生成 REST 契约并接入 Admin 列表操作

**Files:**
- Modify: `apps/api/docs/openapi.json`（生成）
- Modify: `apps/mobile/src/api/generated/**`（生成）
- Modify: `apps/admin/src/api/endpoints.ts`
- Modify: `apps/admin/src/hooks/queries.ts`
- Modify: `apps/admin/src/pages/agent-manage.tsx`

- [ ] **Step 1: 从后端控制器生成 OpenAPI 与移动端客户端**

Run: `pnpm --filter ./apps/mobile generate:api:local`

Expected: OpenAPI 中出现 `PATCH /agents/{id}/default`，生成客户端出现对应的管理员接口定义；不手工编辑生成文件。

- [ ] **Step 2: 添加 Admin 请求和 mutation**

```ts
export const setDefaultAgent = (id: string) =>
  request<Agent>(`/agents/${id}/default`, { method: 'PATCH' });

const setDefault = useMutation({
  mutationFn: (id: string) => setDefaultAgent(id),
  onSuccess: invalidate,
});

return { create, update, remove, setDefault };
```

- [ ] **Step 3: 在列表中提供单一、可见的切换操作**

```tsx
const handleSetDefault = async (agent: Agent) => {
  if (!window.confirm(`将「${agent.name}」设为默认回复智能体？`)) return;
  try {
    await setDefault.mutateAsync(agent.id);
    toast.success('已设为默认回复智能体');
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '设置失败');
  }
};

{!a.isDefault ? (
  <Button
    variant="ghost"
    size="icon"
    title={a.enabled ? '设为默认回复智能体' : '停用的智能体不可设为默认'}
    aria-label="设为默认回复智能体"
    disabled={!a.enabled || setDefault.isPending}
    onClick={() => void handleSetDefault(a)}
  >
    <Star className="h-4 w-4" />
  </Button>
) : null}
```

- [ ] **Step 4: 检查 Admin 类型和生产构建**

Run: `pnpm --filter ./apps/admin run build`

Expected: PASS，TypeScript 和 Vite 构建都成功。

### Task 3: Admin 首字头像与默认图片清理

**Files:**
- Modify: `apps/admin/src/components/agent-identity.tsx`
- Modify: `apps/admin/src/components/agent-form-sheet.tsx`
- Modify: `apps/admin/src/pages/agent-manage.tsx`
- Modify: `apps/admin/package.json`
- Modify: `packages/assets/README.md`

- [ ] **Step 1: 先写 Admin 头像组件的状态机**

```tsx
export function AgentAvatar({ name, avatar, className }: AgentAvatarProps) {
  const [failed, setFailed] = useState(false);
  const src = avatar?.trim() || null;
  const initial = Array.from(name.trim())[0] ?? '?';

  useEffect(() => setFailed(false), [src]);

  if (src && !failed) {
    return <img src={src} alt={name} className={className} onError={() => setFailed(true)} />;
  }
  return <span aria-label={`${name} 的头像`} className={cn(className, 'flex items-center justify-center bg-muted text-sm font-semibold text-muted-foreground')}>{initial}</span>;
}
```

- [ ] **Step 2: 让所有 Admin 智能体头像复用组件**

```tsx
// agent-identity.tsx
<AgentAvatar
  name={name}
  avatar={avatar}
  className={cn(
    'shrink-0 rounded-full border border-border',
    compact ? 'h-6 w-6' : 'h-8 w-8',
  )}
/>

// agent-form-sheet.tsx
<AgentAvatar
  name={form.name}
  avatar={form.avatar}
  className="h-10 w-10 shrink-0 rounded-full border border-border"
/>
```

`agent-manage.tsx` 也改为导入 `AgentAvatar`，移除其内联 `<img>` 和所有对静态 PNG 的回退。

- [ ] **Step 3: 删除资产引用和不再需要的工作区依赖**

```txt
删除旧图片资产
删除 packages/assets/README.md 中的旧图片 import 示例与资产清单行
删除 apps/admin/package.json 的 @litter-bear/assets 依赖
```

- [ ] **Step 4: 搜索确认静态图片零引用并构建 Admin**

Run: `rg -n "@litter-bear/assets" apps/admin packages --glob '!**/node_modules/**'`

Expected: 不再返回 Admin 或共享资产包中的旧图片引用；移动端替换在下一任务完成。

Run: `pnpm --filter ./apps/admin run build`

Expected: PASS。

### Task 4: 小程序统一首字头像

**Files:**
- Create: `apps/mobile/src/components/AgentAvatar/index.tsx`
- Modify: `apps/mobile/src/utils/agent.ts`
- Create: `apps/mobile/src/utils/agent.test.ts`
- Modify: `apps/mobile/src/components/{AgentSheet,MemberBar,ChatBubble,ChatInput,HistoryDrawer,NewChatPanel}/index.tsx`
- Modify: `apps/mobile/src/pages/{agents,agent-picker}/index.tsx`
- Modify: `apps/mobile/package.json`

- [ ] **Step 1: 为首字与 URL 判定写纯函数测试**

```ts
import { agentAvatarSrc, agentInitial } from './agent.js';

const cases = [
  ['办伴', '办'],
  ['  Sparkle', 'S'],
  ['   ', '?'],
] as const;

for (const [name, expected] of cases) {
  if (agentInitial(name) !== expected) {
    throw new Error(`首字不符合预期：${name}`);
  }
}

if (agentAvatarSrc(' https://example.com/a.png ') !== 'https://example.com/a.png') {
  throw new Error('头像 URL 未正确去除首尾空白');
}
if (agentAvatarSrc(null) !== null) {
  throw new Error('空头像不应回退为静态图片 URL');
}
```

- [ ] **Step 2: 运行纯函数测试，确认旧函数仍返回静态图片地址**

Run: `pnpm --dir apps/mobile exec tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --rootDir src --outDir /tmp/litter-bear-agent-avatar-test src/utils/agent.ts src/utils/agent.test.ts`

Run: `node /tmp/litter-bear-agent-avatar-test/utils/agent.test.js`

Expected: FAIL，空头像仍会返回默认图片路径。

- [ ] **Step 3: 实现纯函数和可处理图片失败的 Taro 组件**

```ts
export function agentAvatarSrc(avatar?: string | null): string | null {
  return avatar?.trim() || null;
}

export function agentInitial(name?: string | null): string {
  return Array.from(name?.trim() ?? '')[0] ?? '?';
}
```

```tsx
export default function AgentAvatar({ avatar, name, className }: AgentAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const src = agentAvatarSrc(avatar);

  useEffect(() => setImageFailed(false), [src]);

  if (src && !imageFailed) {
    return <Image className={className} src={src} mode="aspectFill" onError={() => setImageFailed(true)} />;
  }
  return (
    <View className={`${className} flex items-center justify-center overflow-hidden`}>
      <Text className="text-[0.75em] font-semibold leading-none text-[var(--lb-text-secondary)]">
        {agentInitial(name)}
      </Text>
    </View>
  );
}
```

- [ ] **Step 4: 替换所有智能体头像调用点**

```tsx
<AgentAvatar
  name={agent.name}
  avatar={agent.avatar}
  className="h-[2.25rem] w-[2.25rem] shrink-0 rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] box-border"
/>
```

对群聊历史头像先由成员 ID 找到 `AgentSummary`，再同时传入 `name` 与 `avatar`。`ChatBubble` 保留用户头像分支；助手分支传递发言智能体的 `avatar` 和已解析的 `displayName`，使空头像与加载失败都显示该助手的首字。

- [ ] **Step 5: 移除移动端的已废弃资产依赖**

```txt
删除 apps/mobile/package.json 的 @litter-bear/assets 依赖
```

- [ ] **Step 6: 运行首字测试、类型检查和小程序构建**

Run: `pnpm --dir apps/mobile exec tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --rootDir src --outDir /tmp/litter-bear-agent-avatar-test src/utils/agent.ts src/utils/agent.test.ts`

Run: `node /tmp/litter-bear-agent-avatar-test/utils/agent.test.js`

Expected: PASS。

Run: `pnpm --filter ./apps/mobile run typecheck`

Expected: PASS。

Run: `pnpm --filter ./apps/mobile run build:weapp`

Expected: PASS。

### Task 5: 全链路回归与工作区检查

**Files:**
- Modify: 仅限前述任务产生的文件。

- [ ] **Step 1: 执行后端质量检查**

Run: `pnpm --filter ./apps/api run lint:check && pnpm --filter ./apps/api run build`

Expected: PASS。

- [ ] **Step 2: 同步工作区依赖锁文件**

Run: `pnpm install --lockfile-only`

Expected: `pnpm-lock.yaml` 中 Admin 和 mobile 的 importer 不再声明 `@litter-bear/assets`。

- [ ] **Step 3: 复核生成物、删除项与未关联改动**

Run: `git status --short`

Run: `git diff --check`

Expected: 不再存在旧图片引用；只包含本计划相关改动和已有未提交的移动端 trace 改动。

- [ ] **Step 4: 手动验收清单**

```txt
1. Admin 中为启用的非默认智能体点击星标，确认提示后默认标签移动到该行。
2. Admin 中停用智能体的星标不可操作；当前默认智能体无法保存为停用。
3. Admin 列表、观测表格、任务详情和编辑抽屉中，空头像显示名称首字；坏 URL 加载失败后也显示首字。
4. 小程序的智能体页、选择弹层、成员条、聊天消息、输入栏、新对话页、群聊选择页和历史会话均不再显示静态默认图片。
5. 普通未指定智能体的新聊天使用新默认；会话已指定智能体与群聊路由不受影响。
```

## 计划自查

- 规格覆盖：Task 1 覆盖默认唯一性、缓存失效与停用保护；Task 2 覆盖管理员入口和 REST 契约；Task 3-4 覆盖所有端的空头像与加载失败；Task 5 覆盖回归与群聊/会话级优先级的人工验收。
- 占位检查：计划中没有 TBD、TODO 或“后续实现”步骤。
- 类型一致性：接口为 `PATCH /agents/:id/default`，前端使用 `setDefaultAgent`/`setDefault`，首字工具固定为 `agentInitial`，两端组件均命名为 `AgentAvatar`。
- 提交：当前仓库约定要求用户明确提出后才提交，因此本计划不包含自动提交步骤。
