# syntax=docker/dockerfile:1
# One image, two process types:
#   API:    node dist/server.js   (default CMD)
#   Worker: node dist/worker.js   (override the command)
# Migrations run as a separate release step: `node dist/scripts/migrate.js` with DATABASE_URL set.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migration files so the release step can run from this image.
COPY src/platform/database/migrations ./src/platform/database/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1
CMD ["node", "dist/server.js"]
