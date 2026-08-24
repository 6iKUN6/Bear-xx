ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /workspace
ARG PNPM_REGISTRY=https://registry.npmjs.org/

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/assets/package.json packages/assets/
COPY packages/theme/package.json packages/theme/
COPY packages/types/package.json packages/types/
COPY apps/api/prisma apps/api/prisma

# 路径过滤器必须写成 {./apps/api}...：写作 ./apps/api... 时 pnpm 会把整串当路径
# glob，`...`（含依赖包）失效，packages/types 不会被安装，其 tsc 随之缺失。
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile \
      --filter "{./apps/api}..." \
      --store-dir=/pnpm/store \
      --registry="${PNPM_REGISTRY}" \
      --network-concurrency=4

FROM dependencies AS development

COPY packages/types packages/types
COPY apps/api apps/api
RUN pnpm --filter ./packages/types run build

WORKDIR /workspace/apps/api
EXPOSE 3000
CMD ["pnpm", "run", "start:dev"]

FROM dependencies AS builder

COPY packages/types packages/types
COPY apps/api apps/api
RUN pnpm --filter ./packages/types run build \
 && pnpm --filter ./apps/api run build

FROM ${NODE_IMAGE} AS production

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /workspace
ARG PNPM_REGISTRY=https://registry.npmjs.org/

# --ignore-scripts 是必需的，不是图快：--prod 不装 devDependencies，因此根 package.json
# 的 `prepare: husky` 会以 `husky: not found` 失败（HUSKY=0 要 husky 已安装才生效）。
# 生产依赖里没有需要原生编译的包，唯一真正需要的安装脚本是 prisma generate ——
# 下一行已显式执行。

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/assets/package.json packages/assets/
COPY packages/theme/package.json packages/theme/
COPY packages/types/package.json packages/types/
COPY apps/api/prisma apps/api/prisma

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter "{./apps/api}..." \
      --store-dir=/pnpm/store \
      --registry="${PNPM_REGISTRY}" \
      --network-concurrency=4 \
 && pnpm --filter ./apps/api exec prisma generate

COPY --from=builder /workspace/packages/types/dist packages/types/dist
COPY --from=builder /workspace/apps/api/dist apps/api/dist

WORKDIR /workspace/apps/api
EXPOSE 3000
CMD ["node", "dist/src/main"]
