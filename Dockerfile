# 小剧场走词台 —— 单机镜像，构建期编译 better-sqlite3，运行期无需外部服务
FROM node:20-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 走预编译二进制（prebuild），通常无需工具链；
# 若目标平台无预编译包，安装编译依赖后从源码构建
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---------- 运行镜像 ----------
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# 从构建阶段拷贝完整 node_modules（含 better-sqlite3 原生 .node）与源码
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# 数据目录（SQLite WAL 文件所在），交给 node 用户
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=8080 \
    DB_PATH=/app/data/teleprompter.db \
    CONTROL_TTL_SECONDS=60 \
    SWEEP_INTERVAL_SECONDS=1

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
