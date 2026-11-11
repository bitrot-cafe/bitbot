FROM docker.io/library/node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Dev: source is bind-mounted by compose.yaml, so nothing is copied here.
FROM base AS dev
CMD ["sh", "-c", "pnpm install && exec node_modules/.bin/tsx watch src/index.ts"]

# Production dependencies only (includes tsx: the core and plugins run as TypeScript).
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM docker.io/library/node:22-alpine AS prod
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# Plugins aren't baked in: mount a folder of them at /app/plugins (see README, "Production").
RUN mkdir -p plugins public && chown node:node public
USER node
CMD ["node", "--import", "tsx", "src/index.ts"]
