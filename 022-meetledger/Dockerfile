# MeetLedger server + PWA (single container). PostgreSQL runs separately (see deploy/docker-compose.yml).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN npm ci --no-audit --no-fund && npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
RUN npm ci --omit=dev --no-audit --no-fund -w @meetledger/server && npm cache clean --force
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data /models && chown -R node:node /data /models
USER node
WORKDIR /app/apps/server
ENV HOST=0.0.0.0 PORT=8787 WEB_DIST_DIR=/app/apps/web/dist STORAGE_DIR=/data/storage TMP_DIR=/data/tmp LOCAL_ASR_MODEL_DIR=/models
VOLUME ["/data", "/models"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
