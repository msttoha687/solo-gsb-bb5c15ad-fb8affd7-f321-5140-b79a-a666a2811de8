import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { openDb } from './db.js';

// ---------------------------------------------------------------------------
// 配置（全部通过环境变量，无需任何外部服务）
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const DB_PATH = process.env.DB_PATH || '/data/prompter.db';
const CONTROL_TTL_MS = parseInt(process.env.CONTROL_TTL_MS || String(30 * 1000), 10);
const EDITOR_TOKEN = process.env.EDITOR_TOKEN || '';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const db = openDb(DB_PATH);
const now = () => Date.now();

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// 基础 helper
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const payload = { error: code, message: err.message };
  // 拒绝时附带当前现场状态等信息，便于客户端立即同步“页面所见”
  for (const key of ['state', 'currentRevision', 'holderName', 'expiresAt', 'ttlMs']) {
    if (err[key] !== undefined) payload[key] = err[key];
  }
  sendJson(res, status, payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 512 * 1024) {
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new ApiError(400, 'BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getShow(showId) {
  return db.prepare('SELECT id, name, created_at AS createdAt FROM shows WHERE id=?').get(showId);
}

function requireShow(showId) {
  const show = getShow(showId);
  if (!show) throw new ApiError(404, 'SHOW_NOT_FOUND', '场次不存在');
  return show;
}

function getStateRow(showId) {
  return db
    .prepare(
      `SELECT revision, is_live AS isLive, active_ver_id AS activeVerId, cursor, updated_at AS updatedAt
       FROM perf_states WHERE show_id=?`
    )
    .get(showId);
}

function getControlRow(showId) {
  const row = db
    .prepare(
      `SELECT token, holder_name AS holderName, acquired_at AS acquiredAt, expires_at AS expiresAt
       FROM controls WHERE show_id=?`
    )
    .get(showId);
  if (!row) return null;
  return { ...row, expired: row.expiresAt <= now() };
}

// 取当前条目文本及位置（位置序号从 1 开始，便于观众/操作员阅读）
function getCurrentEntry(activeVerId, cursor) {
  if (!activeVerId || cursor === 0) return { currentText: '', position: { index: 0, total: 0 } };
  const entry = db
    .prepare('SELECT text FROM entries WHERE version_id=? AND seq=?')
    .get(activeVerId, cursor);
  const total = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE version_id=?').get(activeVerId).c;
  const before = db
    .prepare('SELECT COUNT(*) AS c FROM entries WHERE version_id=? AND seq<=?')
    .get(activeVerId, cursor).c;
  return { currentText: entry ? entry.text : '', position: { index: before, total } };
}

function buildStatePayload(showId, viewerToken = null) {
  const row = getStateRow(showId);
  const controlRow = getControlRow(showId);
  const { currentText, position } = getCurrentEntry(row.activeVerId, row.cursor);
  let activeVersionNo = null;
  if (row.activeVerId) {
    const v = db.prepare('SELECT version FROM versions WHERE id=?').get(row.activeVerId);
    activeVersionNo = v ? v.version : null;
  }
  const controlActive = controlRow && !controlRow.expired;
  return {
    revision: row.revision,
    isLive: !!row.isLive,
    activeVersionId: row.activeVerId,
    activeVersionNo,
    cursor: row.cursor,
    currentText,
    position,
    updatedAt: row.updatedAt,
    control: controlActive
      ? {
          holderName: controlRow.holderName,
          expiresAt: controlRow.expiresAt,
          expired: false,
          // 只有持令牌本人能看到 mine=true；其他观众只知道持有者名字
          mine: viewerToken != null && viewerToken === controlRow.token,
        }
      : null,
    serverTime: now(),
  };
}

// ---------------------------------------------------------------------------
// 实时房间：按场次广播（控制权归属因连接而异，按各连接的令牌定制）
// ---------------------------------------------------------------------------
const rooms = new Map(); // showId -> Set<WebSocket>

function joinRoom(showId, ws) {
  if (!rooms.has(showId)) rooms.set(showId, new Set());
  rooms.get(showId).add(ws);
}
function leaveRoom(showId, ws) {
  rooms.get(showId)?.delete(ws);
}
function sendTo(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}
function broadcast(showId, build) {
  const set = rooms.get(showId);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState !== ws.OPEN) continue;
    sendTo(ws, build(ws.controlToken || null));
  }
}
function broadcastState(showId) {
  broadcast(showId, (viewerToken) => ({ type: 'state', state: buildStatePayload(showId, viewerToken) }));
}
function broadcastControl(showId, reason) {
  broadcast(showId, (viewerToken) => ({
    type: 'control',
    reason: reason || null,
    state: buildStatePayload(showId, viewerToken),
  }));
}

// ---------------------------------------------------------------------------
// 业务校验
// ---------------------------------------------------------------------------
function normalizeEntries(input) {
  if (!Array.isArray(input)) {
    throw new ApiError(400, 'INVALID_ENTRIES', 'entries 必须是数组');
  }
  if (input.length > 5000) throw new ApiError(400, 'TOO_MANY_ENTRIES', '单场字幕条目不能超过 5000 条');
  const seen = new Set();
  return input.map((e, i) => {
    if (!e || typeof e !== 'object') {
      throw new ApiError(400, 'INVALID_ENTRY', `第 ${i + 1} 行格式无效`);
    }
    const seq = Number(e.seq);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new ApiError(400, 'INVALID_SEQ', `第 ${i + 1} 行序号无效，序号必须是 >=1 的整数`);
    }
    if (seen.has(seq)) {
      throw new ApiError(400, 'DUPLICATE_SEQ', `序号重复：${seq}`);
    }
    seen.add(seq);
    const text = String(e.text ?? '').trim();
    if (!text) {
      throw new ApiError(400, 'EMPTY_TEXT', `序号 ${seq} 的字幕内容为空`);
    }
    if (text.length > 2000) {
      throw new ApiError(400, 'TEXT_TOO_LONG', `序号 ${seq} 的字幕过长（上限 2000 字）`);
    }
    return { seq, text };
  });
}

function requireEditor(req) {
  if (!EDITOR_TOKEN) return;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== EDITOR_TOKEN) {
    throw new ApiError(401, 'EDITOR_UNAUTHORIZED', '缺少或错误的编辑令牌');
  }
}

function requireControl(showId, token) {
  if (!token || typeof token !== 'string') {
    throw new ApiError(401, 'CONTROL_TOKEN_REQUIRED', '缺少控台令牌');
  }
  const ctl = db.prepare('SELECT * FROM controls WHERE show_id=?').get(showId);
  if (!ctl) throw new ApiError(409, 'NO_CONTROL', '当前无人持有控制权，请先取得控制权');
  // 令牌不匹配：若当前持有者也已过期，则提示过期/可接管，而不是误报在他人手中
  if (ctl.token !== token) {
    if (ctl.expires_at <= now()) {
      throw new ApiError(409, 'CONTROL_EXPIRED', '控制权已过期，请重新取得或接管');
    }
    throw new ApiError(403, 'CONTROL_HELD_BY_OTHER', `控制权在 ${ctl.holder_name} 手中`, {
      holderName: ctl.holder_name,
      expiresAt: ctl.expires_at,
    });
  }
  if (ctl.expires_at <= now()) {
    throw new ApiError(409, 'CONTROL_EXPIRED', '控制权已过期，请重新取得或接管');
  }
  return ctl;
}

// 事务内使用：以 SQL 原子条件判定控制权，避免“检查与写入之间过期/被接管”的竞态
function assertControlInTx(showId, token) {
  if (!token || typeof token !== 'string') {
    throw new ApiError(401, 'CONTROL_TOKEN_REQUIRED', '缺少控台令牌');
  }
  const row = db
    .prepare(
      `SELECT holder_name AS holderName, expires_at AS expiresAt,
              (expires_at > ?) AS active, (token = ?) AS mine
       FROM controls WHERE show_id=?`
    )
    .get(now(), token, showId);
  if (!row) throw new ApiError(409, 'NO_CONTROL', '当前无人持有控制权，请先取得控制权');
  if (!row.active) throw new ApiError(409, 'CONTROL_EXPIRED', '控制权已过期，请重新取得或接管');
  if (!row.mine) {
    throw new ApiError(403, 'CONTROL_HELD_BY_OTHER', `控制权在 ${row.holderName} 手中`, {
      holderName: row.holderName,
      expiresAt: row.expiresAt,
    });
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'shows', ':id', ...]

  // GET /api/health
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, time: now() });
  }

  // GET /api/shows
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'shows') {
    const shows = db
      .prepare(
        `SELECT s.id, s.name, s.created_at AS createdAt,
                ps.revision, ps.is_live AS isLive, ps.cursor,
                (SELECT MAX(version) FROM versions v WHERE v.show_id=s.id AND v.draft=0) AS publishedVersion,
                (SELECT COUNT(*) FROM versions v WHERE v.show_id=s.id AND v.draft=0) AS publishedCount
         FROM shows s JOIN perf_states ps ON ps.show_id=s.id
         ORDER BY s.id DESC`
      )
      .all()
      .map((r) => ({ ...r, isLive: !!r.isLive }));
    return sendJson(res, 200, { shows });
  }

  // POST /api/shows
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'shows') {
    requireEditor(req);
    const body = await readJsonBody(req);
    const name = String(body.name || '').trim();
    if (!name) throw new ApiError(400, 'NAME_REQUIRED', '场次名称不能为空');
    if (name.length > 100) throw new ApiError(400, 'NAME_TOO_LONG', '场次名称不能超过 100 字');

    const showId = db.transaction(() => {
      const info = db.prepare('INSERT INTO shows (name, created_at) VALUES (?,?)').run(name, now());
      db.prepare('INSERT INTO versions (show_id, version, draft, published_at) VALUES (?,0,1,NULL)').run(info.lastInsertRowid);
      db.prepare('INSERT INTO perf_states (show_id, revision, updated_at) VALUES (?,0,?)').run(info.lastInsertRowid, now());
      return info.lastInsertRowid;
    })();
    return sendJson(res, 201, { show: getShow(showId) });
  }

  const showId = Number(parts[2]);
  if (parts[1] === 'shows' && parts.length >= 3 && (!Number.isInteger(showId) || showId < 1)) {
    throw new ApiError(400, 'INVALID_SHOW_ID', '场次 ID 无效');
  }

  // GET /api/shows/:id
  if (req.method === 'GET' && parts.length === 3) {
    const show = requireShow(showId);
    const draftVersion = db
      .prepare('SELECT id FROM versions WHERE show_id=? AND draft=1')
      .get(showId);
    const draftEntries = db
      .prepare('SELECT seq, text FROM entries WHERE version_id=? ORDER BY seq ASC')
      .all(draftVersion.id);
    const versions = db
      .prepare(
        `SELECT v.id, v.version, v.published_at AS publishedAt,
                (SELECT COUNT(*) FROM entries e WHERE e.version_id=v.id) AS count
         FROM versions v WHERE v.show_id=? AND v.draft=0 ORDER BY v.version DESC`
      )
      .all(showId);
    // 操作员台首屏可用查询参数带上控制令牌，使首帧就带权威的 mine 标记
    const viewerToken = url.searchParams.get('controlToken') || null;
    return sendJson(res, 200, {
      show,
      draft: { entries: draftEntries },
      versions,
      state: buildStatePayload(showId, viewerToken),
      controlTtlMs: CONTROL_TTL_MS,
    });
  }

  // GET /api/shows/:id/versions
  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'versions') {
    requireShow(showId);
    const versions = db
      .prepare(
        `SELECT v.id, v.version, v.published_at AS publishedAt,
                (SELECT COUNT(*) FROM entries e WHERE e.version_id=v.id) AS count
         FROM versions v WHERE v.show_id=? AND v.draft=0 ORDER BY v.version DESC`
      )
      .all(showId);
    return sendJson(res, 200, { versions });
  }

  // PUT /api/shows/:id/draft  —— 整体替换草稿（发布后的演出不受影响）
  if (req.method === 'PUT' && parts.length === 4 && parts[3] === 'draft') {
    requireEditor(req);
    requireShow(showId);
    const body = await readJsonBody(req);
    const entries = normalizeEntries(body.entries);
    const draftVersion = db
      .prepare('SELECT id FROM versions WHERE show_id=? AND draft=1')
      .get(showId);
    const tx = db.transaction((rows) => {
      db.prepare('DELETE FROM entries WHERE version_id=?').run(draftVersion.id);
      const stmt = db.prepare('INSERT INTO entries (version_id, seq, text) VALUES (?,?,?)');
      for (const e of rows) stmt.run(draftVersion.id, e.seq, e.text);
    });
    tx(entries);
    return sendJson(res, 200, { ok: true, count: entries.length });
  }

  // POST /api/shows/:id/publish —— 把草稿固化为新的不可变演出版本
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'publish') {
    requireEditor(req);
    requireShow(showId);
    const draftVersion = db
      .prepare('SELECT id FROM versions WHERE show_id=? AND draft=1')
      .get(showId);
    const draftEntries = db
      .prepare('SELECT seq, text FROM entries WHERE version_id=? ORDER BY seq ASC')
      .all(draftVersion.id);
    if (draftEntries.length === 0) {
      throw new ApiError(400, 'EMPTY_ENTRIES', '草稿为空，无法发布：请先录入字幕');
    }
    const result = db.transaction(() => {
      const maxRow = db
        .prepare('SELECT MAX(version) AS m FROM versions WHERE show_id=? AND draft=0')
        .get(showId);
      const nextVersion = (maxRow.m || 0) + 1;
      const ts = now();
      const info = db
        .prepare('INSERT INTO versions (show_id, version, draft, published_at) VALUES (?,?,0,?)')
        .run(showId, nextVersion, ts);
      const stmt = db.prepare('INSERT INTO entries (version_id, seq, text) VALUES (?,?,?)');
      for (const e of draftEntries) stmt.run(info.lastInsertRowid, e.seq, e.text);
      return { id: info.lastInsertRowid, version: nextVersion, publishedAt: ts, count: draftEntries.length };
    })();
    broadcastState(showId); // 让编辑页等看到新版本号（现场状态本身不变）
    return sendJson(res, 201, { version: result });
  }

  // POST /api/shows/:id/control/acquire
  if (req.method === 'POST' && parts.length === 5 && parts[3] === 'control' && parts[4] === 'acquire') {
    requireShow(showId);
    const body = await readJsonBody(req);
    const holderName = String(body.name || '').trim();
    if (!holderName) throw new ApiError(400, 'NAME_REQUIRED', '请填写操作员名称');
    if (holderName.length > 40) throw new ApiError(400, 'NAME_TOO_LONG', '操作员名称不能超过 40 字');

    const token = cryptoRandomToken();
    const ts = now();
    const expiresAt = ts + CONTROL_TTL_MS;
    const acquired = db.transaction(() => {
      const existing = db.prepare('SELECT * FROM controls WHERE show_id=?').get(showId);
      if (existing && existing.expires_at > ts) {
        return { conflict: existing };
      }
      db.prepare(
        `INSERT INTO controls (show_id, token, holder_name, acquired_at, expires_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(show_id) DO UPDATE SET token=excluded.token, holder_name=excluded.holder_name,
           acquired_at=excluded.acquired_at, expires_at=excluded.expires_at`
      ).run(showId, token, holderName, ts, expiresAt);
      return { conflict: null, takeover: !!existing };
    })();
    if (acquired.conflict) {
      const e = acquired.conflict;
      throw new ApiError(409, 'CONTROL_HELD', `控制权已被 ${e.holder_name} 持有，等待过期后可接管`, {
        holderName: e.holder_name,
        expiresAt: e.expires_at,
        ttlMs: CONTROL_TTL_MS,
      });
    }
    broadcastControl(showId, acquired.takeover ? 'takenover' : 'acquired');
    return sendJson(res, 200, {
      token,
      holderName,
      expiresAt,
      ttlMs: CONTROL_TTL_MS,
      state: buildStatePayload(showId, token),
    });
  }

  // POST /api/shows/:id/control/renew
  if (req.method === 'POST' && parts.length === 5 && parts[3] === 'control' && parts[4] === 'renew') {
    requireShow(showId);
    const body = await readJsonBody(req);
    const expiresAt = now() + CONTROL_TTL_MS;
    const info = db
      .prepare('UPDATE controls SET expires_at=? WHERE show_id=? AND token=? AND expires_at>?')
      .run(expiresAt, showId, body.token, now());
    if (info.changes === 0) {
      const ctl = db.prepare('SELECT * FROM controls WHERE show_id=?').get(showId);
      if (!ctl) throw new ApiError(409, 'NO_CONTROL', '当前不存在控制权，请先取得控制权');
      if (ctl.token !== body.token) {
        throw new ApiError(403, 'CONTROL_HELD_BY_OTHER', `控制权已被 ${ctl.holder_name} 接管`, {
          holderName: ctl.holder_name,
          expiresAt: ctl.expires_at,
        });
      }
      throw new ApiError(409, 'CONTROL_EXPIRED', '控制权已过期，请重新取得或接管');
    }
    broadcastControl(showId, 'renewed');
    return sendJson(res, 200, { expiresAt, ttlMs: CONTROL_TTL_MS, state: buildStatePayload(showId, body.token) });
  }

  // POST /api/shows/:id/control/release
  if (req.method === 'POST' && parts.length === 5 && parts[3] === 'control' && parts[4] === 'release') {
    requireShow(showId);
    const body = await readJsonBody(req);
    const ctl = db.prepare('SELECT * FROM controls WHERE show_id=?').get(showId);
    if (!ctl) throw new ApiError(409, 'NO_CONTROL', '当前不存在控制权');
    if (ctl.token !== body.token) {
      throw new ApiError(403, 'CONTROL_TOKEN_MISMATCH', '无法释放：令牌与当前持有者不符');
    }
    db.prepare('DELETE FROM controls WHERE show_id=?').run(showId);
    broadcastControl(showId, 'released');
    return sendJson(res, 200, { ok: true, state: buildStatePayload(showId) });
  }

  // POST /api/shows/:id/ops —— 现场操作（开始/停止/推进/回退/清屏），全部走乐观版本 + 幂等
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'ops') {
    requireShow(showId);
    const body = await readJsonBody(req);
    const { action, token, opId } = body;
    const expectedRevision = Number(body.expectedRevision);

    if (!opId || typeof opId !== 'string') {
      throw new ApiError(400, 'OP_ID_REQUIRED', '缺少操作 ID（opId），无法进行重复提交判定');
    }
    if (opId.length > 100) throw new ApiError(400, 'OP_ID_TOO_LONG', 'opId 过长');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new ApiError(400, 'INVALID_REVISION', 'expectedRevision 必须是非负整数');
    }
    const allowed = ['start', 'stop', 'advance', 'retreat', 'clear'];
    if (!allowed.includes(action)) {
      throw new ApiError(400, 'INVALID_ACTION', `未知操作：${action}`);
    }
    // 控制权先校验（无效控制权绝不能改变状态）
    requireControl(showId, token);

    const applyOp = db.transaction(() => {
      // 事务内原子校验控制权（过期/被接管的并发变化在此刻最终判定）
      assertControlInTx(showId, token);
      // 幂等：同一 (show, opId) 已确认过则直接拒绝并回传当前状态
      const dup = db
        .prepare('SELECT result_rev AS resultRev FROM op_log WHERE show_id=? AND op_id=?')
        .get(showId, opId);
      if (dup) return { duplicated: true };

      const state = getStateRow(showId);
      if (state.revision !== expectedRevision) {
        throw new ApiError(409, 'STALE_REVISION',
          `页面状态已过期（所见版本 r${expectedRevision}，当前 r${state.revision}），请刷新后重试`,
          { currentRevision: state.revision, state: buildStatePayload(showId) });
      }

      let cursor = state.cursor;
      let isLive = !!state.isLive;
      let activeVerId = state.activeVerId;

      if (action === 'start') {
        if (isLive) throw new ApiError(409, 'ALREADY_LIVE', '演出已经在进行中，不能重复开始');
        let verId = body.versionId ? Number(body.versionId) : null;
        if (verId) {
          const v = db
            .prepare('SELECT id FROM versions WHERE id=? AND show_id=? AND draft=0')
            .get(verId, showId);
          if (!v) throw new ApiError(404, 'VERSION_NOT_FOUND', '指定的演出版本不存在或未发布');
        } else {
          const latest = db
            .prepare('SELECT id FROM versions WHERE show_id=? AND draft=0 ORDER BY version DESC LIMIT 1')
            .get(showId);
          if (!latest) throw new ApiError(409, 'NO_PUBLISHED_VERSION', '还没有已发布版本，无法开始演出');
          verId = latest.id;
        }
        // 演出中切换版本由 ALREADY_LIVE 拒绝；开始时固化所选版本
        activeVerId = verId;
        cursor = 0;
        isLive = true;
      } else if (action === 'stop') {
        if (!isLive) throw new ApiError(409, 'NOT_LIVE', '演出尚未开始，无需停止');
        isLive = false;
        cursor = 0;
      } else {
        if (!isLive) throw new ApiError(409, 'NOT_LIVE', '演出尚未开始');
        const seqs = db
          .prepare('SELECT seq FROM entries WHERE version_id=? ORDER BY seq ASC')
          .all(activeVerId)
          .map((r) => r.seq);
        const idx = seqs.indexOf(cursor);
        if (action === 'advance') {
          if (cursor === 0) {
            if (seqs.length === 0) throw new ApiError(409, 'NO_ENTRIES', '当前版本没有字幕条目');
            cursor = seqs[0];
          } else {
            if (idx === seqs.length - 1) throw new ApiError(409, 'AT_END', '已经是最后一条字幕，无法继续推进');
            cursor = seqs[idx + 1];
          }
        } else if (action === 'retreat') {
          if (cursor === 0) throw new ApiError(409, 'AT_START', '已经清屏，无法回退');
          cursor = idx <= 0 ? 0 : seqs[idx - 1];
        } else if (action === 'clear') {
          if (cursor === 0) throw new ApiError(409, 'ALREADY_CLEAR', '屏幕已经是清空状态');
          cursor = 0;
        }
      }

      const ts = now();
      db.prepare(
        `UPDATE perf_states SET revision=revision+1, is_live=?, active_ver_id=?, cursor=?, updated_at=?
         WHERE show_id=?`
      ).run(isLive ? 1 : 0, activeVerId, cursor, ts, showId);
      const newRev = state.revision + 1;
      db.prepare(
        'INSERT INTO op_log (show_id, op_id, action, req_rev, result_rev, created_at) VALUES (?,?,?,?,?,?)'
      ).run(showId, opId, action, expectedRevision, newRev, ts);
      // 清理 24 小时前的幂等记录
      db.prepare('DELETE FROM op_log WHERE show_id=? AND created_at<?').run(showId, ts - 24 * 3600 * 1000);
      return { duplicated: false };
    });

    const result = applyOp();
    if (result.duplicated) {
      const s = buildStatePayload(showId);
      throw new ApiError(409, 'DUPLICATE_OP', '该操作已提交过，为避免重复执行已忽略（幂等保护）', { state: s });
    }
    broadcastState(showId);
    return sendJson(res, 200, { ok: true, state: buildStatePayload(showId) });
  }

  throw new ApiError(404, 'API_NOT_FOUND', '接口不存在');
}

function cryptoRandomToken() {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
      }
      await handleApi(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url);
    } else {
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
    }
  } catch (err) {
    if (err instanceof ApiError) {
      sendError(res, err);
    } else {
      console.error(err);
      sendError(res, new ApiError(500, 'INTERNAL_ERROR', '服务器内部错误'));
    }
  }
});

// ---------------------------------------------------------------------------
// WebSocket：观众/编辑/操作员共用，按 showId 加入房间
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const showId = Number(url.searchParams.get('showId'));
  if (!Number.isInteger(showId) || showId < 1 || !getShow(showId)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const controlToken = url.searchParams.get('controlToken') || null;
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.showId = showId;
    ws.controlToken = controlToken;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const showId = ws.showId;
  joinRoom(showId, ws);
  sendTo(ws, { type: 'state', state: buildStatePayload(showId, ws.controlToken) });
  ws.on('close', () => leaveRoom(showId, ws));
  ws.on('error', () => leaveRoom(showId, ws));
});

// 控制权过期巡检：每秒清理过期持有者并广播
setInterval(() => {
  const expired = db
    .prepare('SELECT show_id AS showId FROM controls WHERE expires_at<=?')
    .all(now());
  for (const row of expired) {
    db.prepare('DELETE FROM controls WHERE show_id=? AND expires_at<=?').run(row.showId, now());
    broadcastControl(row.showId, 'expired');
  }
}, 1000).unref();

server.listen(PORT, () => {
  console.log(`走词台已启动: http://0.0.0.0:${PORT}  (数据库: ${DB_PATH}, 控制权时限: ${CONTROL_TTL_MS}ms)`);
});
