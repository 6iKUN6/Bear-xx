ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /workspace
ARG PNPM_REGISTRY=https://registry.npmjs.org/
# Prisma 引擎默认从 binaries.prisma.sh 下载，该域名在部分网络下会 ECONNRESET 导致
# 安装直接失败。留空即用官方源；需要镜像时由构建参数传入（例如
# https://registry.npmmirror.com/-/binary/prisma）。
ARG PRISMA_ENGINES_MIRROR=
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}

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
ARG PRISMA_ENGINES_MIRROR=
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}

# --ignore-scripts 是必需的，不是图快：--prod 不装 devDependencies，因此根 package.json
# 的 `prepare: husky` 会以 `husky: not found` 失败（HUSKY=0 要 husky 已安装才生效）。
# 生产依赖里没有需要原生编译的包，唯一真正需要的安装脚本是 prisma generate ——
# 下一行已显式执行。
ENV HUSKY=0

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

# 渲染 Activity 的运行时依赖：Chromium 负责逐帧截图，ffmpeg/ffprobe 负责合成与核对，
# 中文字体保证模型产出的中文文案不会截成方框。
#
# 刻意不装进 API 镜像：浏览器 + 字体 + ffmpeg 是几百 MB，只有渲染 Activity 用得上；
# 让处理 HTTP 的进程和编排 Worker 一起背上它，既拖慢每次发布，也白白扩大攻击面。
# 两个 activity 阶段各装一次是 Docker 多继承不支持的结果——比把 API 镜像一起养肥更划算。
#
# 这些包必须来自发行版而不是 npm：puppeteer 自带的下载器在受限网络下经常失败，而
# Debian 的 chromium 会一并装好 libnss3 等共享库，不需要再手工补依赖。
FROM development AS development-activity

ENV HTML_RENDER_CHROME_PATH=/usr/bin/chromium \
    HTML_RENDER_TMP_ROOT=/var/tmp/html-render \
    HTML_RENDER_MAX_CONCURRENCY=1

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      chromium-sandbox \
      fonts-noto-cjk \
      ffmpeg \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/tmp/html-render \
 && chown -R node:node /workspace /var/tmp/html-render
USER node

FROM production AS production-activity

ENV HTML_RENDER_CHROME_PATH=/usr/bin/chromium \
    HTML_RENDER_TMP_ROOT=/var/tmp/html-render \
    HTML_RENDER_MAX_CONCURRENCY=1

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      chromium-sandbox \
      fonts-noto-cjk \
      ffmpeg \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/tmp/html-render \
 && chown -R node:node /workspace /var/tmp/html-render
USER node

# Activity Worker 的入口；角色仍由 compose 的 TEMPORAL_WORKER_ROLE 指定，
# 这里只固定「这是独立进程」这一点。
WORKDIR /workspace/apps/api
CMD ["node", "dist/src/temporal/worker"]

# 未指定 --target 的既有构建仍交付 API；渲染 Worker 仅显式选择 production-activity。
FROM production AS production-api
