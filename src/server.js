'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const cfg = require('./config');
const db = require('./db');
const { ApiError, snapshotFor } = require('./state');
const realtime = require('./realtime');

db.init(cfg.DB_PATH);

const app = express();
app.use(express.json({ limit: '2mb' }));

// 健康检查（容器 HEALTHCHECK 使用，无需外部工具）
app.get('/healthz', (_req, res) => {
  try {
    db.getDb().prepare('SELECT 1').get();
    res.json({ ok: true, ts: Date.now() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 首屏需要的数据：观众页可凭 /api/latest 找到最新场次
app.get('/api/scripts', (_req, res) => {
  res.json({ scripts: db.listScripts() });
});

app.get('/api/scripts/:scriptId', (req, res, next) => {
  try {
    const scriptId = Number(req.params.scriptId);
    const script = db.getScript(scriptId);
    if (!script) throw new ApiError('SCRIPT_NOT_FOUND', '剧本不存在', 404);
    res.json({
      script,
      draft: db.getDraft(scriptId),
      versions: db.listVersions(scriptId),
      sessions: db.listSessions(scriptId),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/sessions/:sessionId', (req, res, next) => {
  try {
    const id = Number(req.params.sessionId);
    res.json({ snapshot: snapshotFor(id, null) });
  } catch (err) {
    next(err);
  }
});

// 观众入口：未指定场次时自动使用最新场次
app.get('/api/latest', (_req, res) => {
  const id = db.latestSessionId();
  res.json({ sessionId: id });
});

// 静态页面
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// 错误处理
app.use((err, _req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.code, message: err.message, stateVersion: err.stateVersion ?? null });
  }
  // body-parser 等系统错误
  return res.status(400).json({ error: 'BAD_REQUEST', message: err.message });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
realtime.setup(wss);

server.listen(cfg.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[走词台] http://0.0.0.0:${cfg.PORT}  (控制权有效期 ${cfg.CONTROL_TTL_SECONDS}s, 数据库 ${cfg.DB_PATH})`
  );
});

function shutdown(sig) {
  // eslint-disable-next-line no-console
  console.log(`[走词台] 收到 ${sig}，关闭中…`);
  wss.clients.forEach((c) => c.close(1001, 'server shutting down'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
