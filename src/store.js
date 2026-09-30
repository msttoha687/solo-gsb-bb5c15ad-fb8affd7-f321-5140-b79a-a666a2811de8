'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const db = require('./db');
const cfg = require('./config');
const {
  ApiError,
  isNonEmptyString,
  normalizeEntries,
  snapshotFor,
  isControlActive,
} = require('./state');

// 状态变更后通过事件总线通知 WebSocket 层广播
const bus = new EventEmitter();
bus.on('error', () => {});

const emitScript = (scriptId) => bus.emit('script', scriptId);
const emitSession = (sessionId) => bus.emit('session', sessionId);

const now = () => Date.now();
const newToken = () => crypto.randomBytes(24).toString('hex');

function requireScript(scriptId) {
  const s = db.getScript(scriptId);
  if (!s) throw new ApiError('SCRIPT_NOT_FOUND', '剧本不存在', 404);
  return s;
}

function requireSession(sessionId) {
  // 内部事务使用原始列名行（control_token / state_version 等）
  const s = db.getSessionRow(sessionId);
  if (!s) throw new ApiError('SESSION_NOT_FOUND', '场次不存在', 404);
  return s;
}

// ---------- 编辑器：脚本 / 草稿 / 发布 ----------

function createScript({ title }) {
  if (!isNonEmptyString(title)) throw new ApiError('BAD_REQUEST', '剧本标题不能为空');
  const id = db.createScript(title.trim());
  emitScript(id);
  return { scriptId: id };
}

function saveDraft(scriptId, { entries }) {
  requireScript(scriptId);
  // 草稿允许任意中间态，仅做结构规范化，不强制校验空字幕/重复序号；
  // 但保存时同样去掉空白文本之外的危险内容——这里仅做基本类型检查
  if (!Array.isArray(entries)) throw new ApiError('BAD_REQUEST', 'entries 必须为数组');
  const safe = [];
  for (const item of entries) {
    if (item && typeof item === 'object' && Number.isInteger(Number(item.seq))) {
      safe.push({ seq: Number(item.seq), text: String(item.text ?? '') });
    }
  }
  db.saveDraft(scriptId, safe);
  emitScript(scriptId);
  return { saved: true, count: safe.length, updatedAt: now() };
}

function publishVersion(scriptId, { label, entries }) {
  requireScript(scriptId);
  // 发布即固化：空字幕、非正整数序号、重复序号一律拒绝
  const normalized = normalizeEntries(entries);
  const version = db.insertVersion(scriptId, isNonEmptyString(label) ? label.trim() : '', normalized);
  // 注意：新版本绝不影响任何已存在/演出中的场次，场次只锁定其 version_id
  emitScript(scriptId);
  return {
    version: { id: version.id, version: version.version, label: version.label, total: normalized.length },
  };
}

function createSession(scriptId, { name, versionId }) {
  requireScript(scriptId);
  if (!isNonEmptyString(name)) throw new ApiError('BAD_REQUEST', '场次名称不能为空');
  const v = db.getVersion(Number(versionId));
  if (!v || v.scriptId !== scriptId) {
    throw new ApiError('VERSION_NOT_FOUND', '请选择本场次要使用的已发布版本', 404);
  }
  const id = db.createSession(scriptId, name.trim(), v.id);
  emitScript(scriptId);
  emitSession(id);
  return { sessionId: id };
}

// 切换场次使用的版本：只允许在演出尚未开始（ready）时进行
function switchVersion(sessionId, { versionId, token }) {
  const sessionIdN = Number(sessionId);
  const versionIdN = Number(versionId);
  return db.getDb().transaction(() => {
    const s = requireSession(sessionIdN);
    if (s.status === 'closed') throw new ApiError('SESSION_CLOSED', '场次已结束，不能切换版本');
    if (s.status === 'live') {
      // 演出中切换版本必须拒绝：在场观众看到的版本不得改变
      throw new ApiError('VERSION_LOCKED', '演出进行中，版本已锁定，不能切换（新版本需另开场次）');
    }
    const v = db.getVersion(versionIdN);
    if (!v || v.scriptId !== s.script_id) {
      throw new ApiError('VERSION_NOT_FOUND', '版本不存在或不属于该剧本', 404);
    }
    db.getDb()
      .prepare('UPDATE sessions SET version_id = ? WHERE id = ?')
      .run(v.id, sessionIdN);
    emitSession(sessionIdN);
    return { switched: true, versionId: v.id, snapshot: snapshotFor(sessionIdN, token) };
  })();
}

function closeSession(sessionId, { token }) {
  const sessionIdN = Number(sessionId);
  return db.getDb().transaction(() => {
    const s = requireSession(sessionIdN);
    if (s.status === 'closed') throw new ApiError('SESSION_CLOSED', '场次已结束');
    if (!isControlActive(s)) throw new ApiError('NO_CONTROL', '只有持有控制权的操作员可以结束场次');
    if (s.control_token !== token) throw new ApiError('CONTROL_HELD', '控制权在他人手中');
    db.getDb().prepare(
      `UPDATE sessions
       SET status = 'closed', closed_at = ?, control_token = NULL, control_name = NULL, control_expires_at = NULL
       WHERE id = ?`
    ).run(now(), sessionIdN);
    emitSession(sessionIdN);
    return { closed: true, snapshot: snapshotFor(sessionIdN, null) };
  })();
}

// ---------- 控制权：限时、独占、过期可接管 ----------

function acquireControl(sessionId, { clientId, name, token }) {
  const sessionIdN = Number(sessionId);
  const operatorName = isNonEmptyString(name) ? name.trim().slice(0, 40) : '操作员';
  return db.getDb().transaction(() => {
    const s = requireSession(sessionIdN);
    if (s.status === 'closed') throw new ApiError('SESSION_CLOSED', '场次已结束，不能取得控制权');
    const t = now();
    const previousHolder = s.control_token && s.control_expires_at > t ? s.control_name : null;
    const previousWasMe = !!(token && s.control_token === token && previousHolder);
    let myToken;

    if (previousHolder) {
      // 有人持控且未过期
      if (previousWasMe) {
        // 同一持控者重连/重复取得：刷新 TTL，幂等返回
        myToken = token;
        const expiresAt = t + cfg.CONTROL_TTL_SECONDS * 1000;
        db.getDb()
          .prepare('UPDATE sessions SET control_expires_at = ? WHERE id = ?')
          .run(expiresAt, sessionIdN);
      } else {
        throw new ApiError(
          'CONTROL_HELD',
          `控制权在「${s.control_name}」手中且未过期，同一场次仅一人可持控；请等待其过期后接管`,
          409
        );
      }
    } else {
      // 无人持控或已过期：当前操作员接管（若现场有过期持控者则构成接管）
      myToken = newToken();
      const expiresAt = t + cfg.CONTROL_TTL_SECONDS * 1000;
      db.getDb()
        .prepare(
          'UPDATE sessions SET control_token = ?, control_name = ?, control_expires_at = ? WHERE id = ?'
        )
        .run(myToken, operatorName, expiresAt, sessionIdN);
    }
    const takenOver = !previousWasMe && !!s.control_token;
    emitSession(sessionIdN);
    return {
      token: myToken,
      ttlSeconds: cfg.CONTROL_TTL_SECONDS,
      snapshot: snapshotFor(sessionIdN, myToken),
      takenOver,
    };
  })();
}

function heartbeat(sessionId, { token }) {
  const sessionIdN = Number(sessionId);
  return db.getDb().transaction(() => {
    const s = db.getSessionRow(sessionIdN);
    if (!s) throw new ApiError('SESSION_NOT_FOUND', '场次不存在', 404);
    if (s.status === 'closed') throw new ApiError('SESSION_CLOSED', '场次已结束');
    if (!token || s.control_token !== token || !isControlActive(s)) {
      throw new ApiError('NOT_CONTROLLER', '控制权已失效（过期或被他人接管），请重新取得控制权', 403);
    }
    // 心跳仅续期 TTL，本身幂等、无需写入操作表
    const expiresAt = now() + cfg.CONTROL_TTL_SECONDS * 1000;
    db.getDb()
      .prepare('UPDATE sessions SET control_expires_at = ? WHERE id = ?')
      .run(expiresAt, sessionIdN);
    return { renewed: true, ttlSeconds: cfg.CONTROL_TTL_SECONDS, expiresAt };
  })();
}

function releaseControl(sessionId, { token }) {
  const sessionIdN = Number(sessionId);
  return db.getDb().transaction(() => {
    const s = requireSession(sessionIdN);
    const wasActive = isControlActive(s);
    if (token && s.control_token === token) {
      db.getDb()
        .prepare(
          'UPDATE sessions SET control_token = NULL, control_name = NULL, control_expires_at = NULL WHERE id = ?'
        )
        .run(sessionIdN);
      if (wasActive) emitSession(sessionIdN);
    }
    return { released: true, snapshot: snapshotFor(sessionIdN, null) };
  })();
}

// 定时清理过期控制权；返回本次过期的场次 id 供广播
function sweepExpiredControl() {
  const t = now();
  const expired = [];
  db.getDb().transaction(() => {
    const rows = db
      .getDb()
      .prepare(
        `SELECT id FROM sessions
         WHERE status != 'closed' AND control_token IS NOT NULL AND control_expires_at <= ?`
      )
      .all(t);
    for (const r of rows) {
      db.getDb()
        .prepare(
          'UPDATE sessions SET control_token = NULL, control_name = NULL, control_expires_at = NULL WHERE id = ?'
        )
        .run(r.id);
      expired.push(r.id);
    }
    db.cleanupOps(t);
  })();
  for (const id of expired) emitSession(id);
  return expired;
}

// ---------- 演出操作：start / advance / back / clear ----------
//
// 重要：better-sqlite3 的事务回调一旦抛异常，整笔事务会回滚，
// 幂等记录也会随之消失。因此事务内部对“业务拒绝”只返回结果对象、
// 不抛异常（保证 session_ops 落库），由外层统一转换为 ApiError。

function stageAction(sessionId, action, { token, opId, baseVersion }) {
  const sessionIdN = Number(sessionId);
  const opIdS = String(opId || '');
  if (!opIdS) throw new ApiError('BAD_REQUEST', '缺少 opId：每次操作必须带唯一请求标识');
  const base = Number(baseVersion);
  if (!Number.isInteger(base) || base < 0) {
    throw new ApiError('BAD_REQUEST', '缺少 baseVersion：操作必须基于页面所见的状态版本');
  }

  const outcome = db.getDb().transaction(() => {
    // 1) 重复提交：同一 op_id 已处理过，原样回放当时结论且不再改变状态
    const dup = db.findOp(sessionIdN, opIdS);
    if (dup) {
      return {
        duplicate: true,
        applied: dup.result === 'applied',
        reason: dup.result === 'rejected'
          ? dup.reason
          : '重复提交：该操作此前已生效，未重复执行',
        recordedOpType: dup.op_type,
        snapshot: snapshotFor(sessionIdN, token),
      };
    }

    const s = db.getSessionRow(sessionIdN);
    if (!s) return { rejected: { code: 'SESSION_NOT_FOUND', message: '场次不存在', status: 404 } };

    const reject = (code, message, httpStatus = 409) => {
      db.recordOp(sessionIdN, opIdS, action, base, 'rejected', message, s.state_version);
      return { rejected: { code, message, status: httpStatus, stateVersion: s.state_version } };
    };

    // 2) 场次状态
    if (s.status === 'closed') return reject('SESSION_CLOSED', '场次已结束，操作被拒绝', 409);

    // 3) 控制权校验：失效/非持控者不得改变状态
    if (!token || s.control_token !== token || !isControlActive(s)) {
      return reject('NOT_CONTROLLER', '控制权已失效或不在你手中：请先取得控制权后再操作', 403);
    }

    // 4) 旧版本：baseVersion 必须等于页面应当见到的最新状态版本
    if (base !== s.state_version) {
      return reject(
        'STALE_VERSION',
        `页面状态已过期（你的版本 ${base}，当前版本 ${s.state_version}）：请按最新画面重新操作`,
        409
      );
    }

    const version = s.version_id ? db.getVersion(s.version_id) : null;
    let entries = [];
    try {
      entries = version ? JSON.parse(version.entriesJson) : [];
    } catch {
      entries = [];
    }
    const total = entries.length;

    // 5) 动作特定规则
    let nextIndex = s.current_index;
    let nextShowing = s.showing;
    let nextStatus = s.status;

    if (action === 'start') {
      if (s.status === 'live') return reject('ALREADY_LIVE', '演出已经开始');
      if (!version || total === 0) return reject('NO_VERSION', '该场次尚未绑定可用的演出版本');
      nextStatus = 'live';
      nextIndex = 1;
      nextShowing = 1;
    } else {
      // advance / back / clear 仅演出中可用
      if (s.status !== 'live') return reject('NOT_LIVE', '演出尚未开始：请先点击“开始演出”', 409);

      if (action === 'advance') {
        if (!s.showing) {
          if (s.current_index === 0) {
            // 片头清屏态：推进 = 上第一条
            if (total < 1) return reject('AT_END', '没有可上的字幕了');
            nextIndex = 1;
            nextShowing = 1;
          } else if (s.current_index < 1 || s.current_index > total) {
            // 清屏后推进 = 重新亮起当前条
            return reject('AT_END', '没有可上的字幕了');
          } else {
            nextShowing = 1;
          }
        } else if (s.current_index >= total) {
          return reject('AT_END', '已是最后一条字幕，无法继续推进');
        } else {
          nextIndex = s.current_index + 1;
          nextShowing = 1;
        }
      } else if (action === 'back') {
        if (s.current_index <= 0) {
          return reject('AT_BEGINNING', '当前位于片头，没有上一条可回退');
        }
        nextIndex = s.current_index - 1;
        nextShowing = nextIndex === 0 ? 0 : 1; // 回到片头自动清屏
      } else if (action === 'clear') {
        if (!s.showing) return reject('ALREADY_CLEARED', '屏幕已经是清屏状态');
        nextShowing = 0;
      } else {
        return reject('BAD_REQUEST', `未知操作：${action}`);
      }
    }

    // 6) 提交：状态版本 +1
    db.getDb()
      .prepare(
        `UPDATE sessions
         SET status = ?, current_index = ?, showing = ?, state_version = state_version + 1
         WHERE id = ?`
      )
      .run(nextStatus, nextIndex, nextShowing ? 1 : 0, sessionIdN);
    db.recordOp(sessionIdN, opIdS, action, base, 'applied', null, s.state_version + 1);

    return { applied: true, stateVersion: s.state_version + 1 };
  })();

  // 事务已提交：业务拒绝在此转换为异常，幂等记录不会被回滚
  if (outcome.rejected) {
    const r = outcome.rejected;
    throw new ApiError(r.code, r.message, r.status, r.stateVersion ?? null);
  }

  if (outcome.duplicate) {
    // 重复提交：回放当时结论，不改变状态，也不额外广播
    return {
      duplicate: true,
      applied: outcome.applied,
      reason: outcome.reason,
      recordedOpType: outcome.recordedOpType,
      stateVersion: outcome.snapshot.stateVersion,
      snapshot: outcome.snapshot,
    };
  }

  // 首次提交生效：在事务外广播最新快照
  emitSession(sessionIdN);
  return { applied: true, stateVersion: outcome.stateVersion, snapshot: snapshotFor(sessionIdN, token) };
}

module.exports = {
  bus,
  createScript,
  saveDraft,
  publishVersion,
  createSession,
  switchVersion,
  closeSession,
  acquireControl,
  heartbeat,
  releaseControl,
  sweepExpiredControl,
  stageAction,
};
