FROM node:24-bookworm-slim
ENV NODE_ENV=production APP_ENV=production HOST=0.0.0.0 PORT=8000 DB_PATH=/app/data/moa.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && groupadd --gid 10001 moa && useradd --uid 10001 --gid 10001 --create-home moa \
    && mkdir -p /app/data && chown moa:moa /app/data
COPY --chown=moa:moa src ./src
USER moa
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8000/api/health', {signal: AbortSignal.timeout(3000)}).then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "src/index.js"]
