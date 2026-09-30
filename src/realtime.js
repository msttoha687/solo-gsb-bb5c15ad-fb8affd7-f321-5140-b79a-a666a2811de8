'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const db = require('./db');
const store = require('./store');
const { ApiError, snapshotFor } = require('./state');

// 连接表：按 channel(script:<id> / session:<id>) 索引，便于精准广播
// conn = { ws, id, channels:Set, token(本场次持控令牌) }
const connections = new Set();
const byChannel = new Map();

function addToChannel(conn, channel) {
  conn.channels.add(channel);
  let set = byChannel.get(channel);
  if (!set) {
    set = new Set();
    byChannel.set(channel, set);
  }
  set.add(conn);
}

function removeFromChannel(conn, channel) {
  const set = byChannel.get(channel);
  if (set) {
    set.delete(conn);
    if (set.size === 0) byChannel.delete(channel);
  }
}

function broadcast(channel, payload) {
  const set = byChannel.get(channel);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const conn of set) {
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.send(data);
    }
  }
}

function sessionChannel(sessionId) {
  return `session:${Number(sessionId)}`;
}
function scriptChannel(scriptId) {
  return `script:${Number(scriptId)}`;
}

function sendError(ws, id, err) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'error',
      id: id ?? null,
      code: err.code || 'INTERNAL',
      message: err.message || '服务器内部错误',
      stateVersion: err.stateVersion ?? null,
    })
  );
}

function startSweeper() {
  const timer = setInterval(() => {
    try {
      store.sweepExpiredControl();
    } catch {
      // 扫描失败不影响服务，下轮重试
    }
  }, Math.max(200, require('./config').SWEEP_INTERVAL_SECONDS * 1000));
  if (timer.unref) timer.unref();
}

function setup(wss) {
  // 业务状态变更 -> 向相关订阅者推送最新已确认状态
  store.bus.on('session', (sessionId) => {
    // 广播统一快照；是否持控按各连接自己的 token 判断
    const set = byChannel.get(sessionChannel(sessionId));
    if (!set) return;
    for (const conn of set) {
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      const snap = snapshotFor(sessionId, conn.token);
      conn.ws.send(JSON.stringify({ type: 'snapshot', sessionId, snapshot: snap }));
    }
  });

  store.bus.on('script', (scriptId) => {
    broadcast(scriptChannel(scriptId), {
      type: 'script_changed',
      scriptId,
      versions: db.listVersions(scriptId),
      sessions: db.listSessions(scriptId),
    });
  });

  wss.on('connection', (ws) => {
    const conn = {
      ws,
      id: crypto.randomBytes(8).toString('hex'),
      channels: new Set(),
      token: null,
    };
    connections.add(conn);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.send(JSON.stringify({ type: 'hello', clientId: conn.id }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return sendError(ws, null, new ApiError('BAD_REQUEST', '消息不是合法 JSON'));
      }
      handleMessage(conn, msg).catch((err) => {
        sendError(ws, msg && msg.id, err);
      });
    });

    ws.on('close', () => {
      connections.delete(conn);
      for (const ch of conn.channels) removeFromChannel(conn, ch);
    });
    ws.on('error', () => {});
  });

  // 僵尸连接探测
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, 30000);
  if (ping.unref) ping.unref();
  wss.on('close', () => clearInterval(ping));

  startSweeper();
}

// 每个可调用的 WS 方法返回 { event, ...result }，event 决定是否回推快照
const methods = {
  subscribeScript: async (conn, { scriptId }) => {
    const id = Number(scriptId);
    if (!db.getScript(id)) throw new ApiError('SCRIPT_NOT_FOUND', '剧本不存在', 404);
    addToChannel(conn, scriptChannel(id));
    return {
      script: db.getScript(id),
      draft: db.getDraft(id),
      versions: db.listVersions(id),
      sessions: db.listSessions(id),
    };
  },

  unsubscribeScript: async (conn, { scriptId }) => {
    removeFromChannel(conn, scriptChannel(Number(scriptId)));
    return { ok: true };
  },

  subscribeSession: async (conn, { sessionId }) => {
    const id = Number(sessionId);
    const s = db.getSession(id);
    if (!s) throw new ApiError('SESSION_NOT_FOUND', '场次不存在', 404);
    addToChannel(conn, sessionChannel(id));
    return { snapshot: snapshotFor(id, conn.token) };
  },

  unsubscribeSession: async (conn, { sessionId }) => {
    removeFromChannel(conn, sessionChannel(Number(sessionId)));
    return { ok: true };
  },

  // 持控令牌随连接保存；断线重连后前端可重新 acquire（同 token 刷新 TTL）
  setToken: async (conn, { token }) => {
    conn.token = token || null;
    return { ok: true };
  },

  saveDraft: async (conn, p) => store.saveDraft(Number(p.scriptId), p),
  publishVersion: async (conn, p) => store.publishVersion(Number(p.scriptId), p),
  createSession: async (conn, p) => store.createSession(Number(p.scriptId), p),
  switchVersion: async (conn, p) => store.switchVersion(Number(p.sessionId), p),
  closeSession: async (conn, p) => store.closeSession(Number(p.sessionId), p),

  acquireControl: async (conn, p) => {
    const r = store.acquireControl(Number(p.sessionId), p);
    conn.token = r.token; // 本连接记住持控令牌
    return r;
  },

  heartbeat: async (conn, p) => store.heartbeat(Number(p.sessionId), p),
  releaseControl: async (conn, p) => {
    const r = store.releaseControl(Number(p.sessionId), p);
    conn.token = null;
    return r;
  },

  start: async (conn, p) => store.stageAction(Number(p.sessionId), 'start', p),
  advance: async (conn, p) => store.stageAction(Number(p.sessionId), 'advance', p),
  back: async (conn, p) => store.stageAction(Number(p.sessionId), 'back', p),
  clear: async (conn, p) => store.stageAction(Number(p.sessionId), 'clear', p),
};

async function handleMessage(conn, msg) {
  const { ws } = conn;
  if (!msg || typeof msg !== 'object') {
    throw new ApiError('BAD_REQUEST', '消息格式不正确');
  }

  // 订阅类消息直接处理
  if (msg.type === 'subscribe') {
    const data = await (
      msg.channel === 'session' ? methods.subscribeSession : methods.subscribeScript
    )(conn, msg);
    ws.send(JSON.stringify({ type: 'subscribed', id: msg.id ?? null, ...data }));
    return;
  }
  if (msg.type === 'unsubscribe') {
    if (msg.channel === 'session') await methods.unsubscribeSession(conn, msg);
    else await methods.unsubscribeScript(conn, msg);
    ws.send(JSON.stringify({ type: 'unsubscribed', id: msg.id ?? null }));
    return;
  }

  // RPC：{id, method, params}
  if (msg.type === 'rpc' || (msg.method && msg.id !== undefined)) {
    const id = msg.id;
    const fn = methods[msg.method];
    if (!fn) {
      return sendError(ws, id, new ApiError('UNKNOWN_METHOD', `未知方法：${msg.method}`, 404));
    }
    try {
      const result = await fn(conn, msg.params || {});
      ws.send(JSON.stringify({ type: 'result', id, result: result ?? {} }));
    } catch (err) {
      sendError(ws, id, err);
    }
    return;
  }

  throw new ApiError('BAD_REQUEST', `无法识别的消息类型：${msg.type}`);
}

module.exports = { setup };
