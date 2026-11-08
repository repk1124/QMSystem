# syntax=docker/dockerfile:1
# ── 第一階段：安裝全部依賴並打包（前端 vite build + 後端 esbuild）──
FROM node:22-alpine AS build
WORKDIR /app
# 小記憶體機器（例如 3 GB 的 VM）上 vite build 可能撞到 heap 上限
ENV NODE_OPTIONS=--max-old-space-size=2048
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts tailwind.config.ts postcss.config.js components.json ./
COPY client ./client
COPY server ./server
COPY shared ./shared
RUN npm run build

# ── 第二階段：只留正式環境需要的東西 ──
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=5000 \
    UPLOAD_DIR=/app/uploads
# 健康檢查用 wget（alpine 內建的 busybox 版本即可）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# 忘記密碼時用：docker compose exec app node scripts/reset-password.mjs <帳號> <新密碼>
COPY scripts/reset-password.mjs scripts/seed-demo.mjs ./scripts/
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
EXPOSE 5000
VOLUME ["/app/uploads"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:5000/api/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
