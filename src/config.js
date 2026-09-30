'use strict';

// 所有配置均通过环境变量注入，提供开箱即用的默认值
const path = require('path');

const int = (name, fallback) => {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const PORT = int('PORT', 8080);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'teleprompter.db');
// 控制权有效期（秒）：从取得或最近一次心跳起算
const CONTROL_TTL_SECONDS = int('CONTROL_TTL_SECONDS', 60);
// 心跳建议间隔（秒），前端实际使用，服务端只按 TTL 判定
const HEARTBEAT_INTERVAL_SECONDS = Math.max(5, Math.floor(CONTROL_TTL_SECONDS / 3));
// 失效控制权清理扫描间隔（秒）
const SWEEP_INTERVAL_SECONDS = int('SWEEP_INTERVAL_SECONDS', 1);
// 同一操作请求 id 的幂等保留时长（秒）
const IDEMPOTENCY_TTL_SECONDS = int('IDEMPOTENCY_TTL_SECONDS', 3600);

module.exports = {
  PORT,
  DB_PATH,
  CONTROL_TTL_SECONDS,
  HEARTBEAT_INTERVAL_SECONDS,
  SWEEP_INTERVAL_SECONDS,
  IDEMPOTENCY_TTL_SECONDS,
};
