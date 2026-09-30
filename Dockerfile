# 小剧场网页走词台 —— 单镜像，内置 Node.js + SQLite，无外部服务
FROM node:20-bookworm-slim

# better-sqlite3 使用预编译二进制；保留最小构建兜底能力
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 再拷业务代码
COPY src ./src
COPY public ./public

# SQLite 数据目录（Compose 会在此挂载卷）
RUN mkdir -p /data
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/prompter.db \
    CONTROL_TTL_MS=30000

EXPOSE 8080
VOLUME ["/data"]

# 容器启动即自动建库建表（src/db.js 中 CREATE TABLE IF NOT EXISTS）
CMD ["node", "src/server.js"]
