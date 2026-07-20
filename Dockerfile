FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 falls back to compiling its native binding from source on
# platforms without a prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
WORKDIR /app
COPY . .
RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Prisma's query engine needs libssl at runtime for migrate/introspection.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/src/generated ./src/generated
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# Volume mount point for the SQLite database file. Documented in
# docker-compose.yml and docs/setup — this is what makes uploads,
# credentials, and job history survive a restart or upgrade.
RUN mkdir -p /app/data

EXPOSE 3000
ENV PORT=3000
ENV DATABASE_URL="file:/app/data/omnipost.db"

# Run next directly (not via `npm start`) so this process is PID 1 and
# receives SIGTERM straight from Docker — npm's wrapper does not reliably
# forward signals to its child, which would break the graceful drain.
CMD ["node_modules/.bin/next", "start"]
