FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:client

FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY tsconfig.json drizzle.config.ts ./
COPY --from=builder /app/dist ./dist

VOLUME /data
EXPOSE 3000

# Run migrations then start server
CMD ["bun", "run", "src/server/index.ts"]
