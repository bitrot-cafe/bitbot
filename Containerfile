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
# git: the bot clones and updates plugin repos itself (!admin plugins add/update). npm ships with node.
RUN apk add --no-cache git
ENV NODE_ENV=production
# Set by CI (image.yml); shown in logs, and in the status while debug mode is on.
ARG BITBOT_VERSION=unknown
ARG BITBOT_COMMIT=unknown
ENV BITBOT_VERSION=$BITBOT_VERSION BITBOT_COMMIT=$BITBOT_COMMIT
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# Plugins aren't baked in: the bot manages them in /app/plugins (mount it writable; see deploy/README.md).
RUN mkdir -p plugins public && chown node:node plugins public
USER node
CMD ["node", "--import", "tsx", "src/index.ts"]
