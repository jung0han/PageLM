# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22.16.0-alpine@sha256:41e4389f3d988d2ed55392df4db1420ad048ae53324a8e2b7c6d19508288107e
FROM ${NODE_IMAGE} AS base

ARG SOURCE_URL=https://github.com/jung0han/PageLM
ARG UPSTREAM_REVISION=b3b4895fb3a180088b897705816a5a9786d79a92
ARG FORK_REVISION=development

LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.revision=$FORK_REVISION \
      io.qai.pagelm.upstream-revision=$UPSTREAM_REVISION

WORKDIR /app

# builder
FROM base AS builder

COPY package*.json ./

RUN npm ci --legacy-peer-deps

COPY backend/ ./backend/

RUN npm run build

# runtime
FROM base AS runtime

COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 5000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
  CMD wget -qO- http://127.0.0.1:5000/health/ready >/dev/null || exit 1

CMD ["npm", "start"]
