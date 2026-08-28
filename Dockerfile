FROM oven/bun:1.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run typecheck
RUN bun run build

FROM oven/bun:1.2-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && mkdir -p /data /data/originals /data/whatsapp-auth /run/secrets && chown -R bun:bun /app /data /run/secrets
COPY --from=build --chown=bun:bun /app/dist ./dist
USER bun
ENV APP_HOST=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD bun -e 'fetch("http://127.0.0.1:3000/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["bun", "run", "dist/server.js"]
