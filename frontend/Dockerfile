# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22.16.0-alpine@sha256:41e4389f3d988d2ed55392df4db1420ad048ae53324a8e2b7c6d19508288107e
FROM ${NODE_IMAGE} AS base

ARG SOURCE_URL=https://github.com/jung0han/PageLM
ARG UPSTREAM_REVISION=b3b4895fb3a180088b897705816a5a9786d79a92
ARG FORK_REVISION=development

LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.revision=$FORK_REVISION \
      io.qai.pagelm.upstream-revision=$UPSTREAM_REVISION

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm i -g pnpm@10.13.1

WORKDIR /app

# deps
FROM base AS deps

COPY package*.json pnpm*.yaml ./

RUN pnpm i --frozen-lockfile

# build
FROM base AS build

ARG VITE_BACKEND_URL
ARG VITE_TIMEOUT
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_TIMEOUT=$VITE_TIMEOUT

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm build

# runtime
FROM base AS runtime

COPY --from=build /app/dist ./dist

RUN npm install -g serve@14.2.4

EXPOSE 5173

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD wget -qO- http://127.0.0.1:5173/ >/dev/null || exit 1

CMD ["serve", "-s", "dist", "-l", "5173"]
