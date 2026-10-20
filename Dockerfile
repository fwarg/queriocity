FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:client

FROM oven/bun:1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN bunx playwright install --with-deps chromium
COPY src ./src
# Maintenance scripts run inside the container, against the same /data volume as the server
# (e.g. `docker compose run --rm queriocity bun run scripts/migrate-legacy-db.ts ...`).
COPY scripts ./scripts
COPY docker/data/global_news_rss_feeds.json ./src/server/data/news_feeds.json
COPY tsconfig.json ./
COPY --from=builder /app/dist ./dist

RUN mkdir -p /data

VOLUME /data
EXPOSE 3000

CMD ["bun", "run", "src/server/index.ts"]
