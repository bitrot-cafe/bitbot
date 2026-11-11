FROM docker.io/library/node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Dev: source is bind-mounted by compose.yaml, so nothing is copied here.
FROM base AS dev
CMD ["sh", "-c", "pnpm install && exec node_modules/.bin/tsx watch src/index.ts"]

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM docker.io/library/node:22-alpine AS prod
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
