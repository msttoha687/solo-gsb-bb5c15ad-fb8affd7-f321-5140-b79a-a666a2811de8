'use strict';

const db = require('./db');

// 统一业务错误：前端按 code 给出中文原因
class ApiError extends Error {
  constructor(code, message, status = 400, stateVersion = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.stateVersion = stateVersion;
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// 校验有序字幕条目：序号必须为正整数、不可重复，文本不可为空白
// 返回按序号排序的标准条目 [{seq, text}]
function normalizeEntries(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError('EMPTY_SUBTITLE', '字幕条目为空：请至少录入一条字幕');
  }
  const out = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      throw new ApiError('INVALID_ENTRY', '字幕条目格式不正确');
    }
    const seq = Number(item.seq);
    if (!Number.isInteger(seq) || seq <= 0) {
      throw new ApiError('INVALID_SEQ', `序号必须为正整数（收到：${String(item.seq)}）`);
    }
    if (!isNonEmptyString(item.text)) {
      throw new ApiError('EMPTY_SUBTITLE', `第 ${seq} 条字幕为空，空字幕不允许发布`);
    }
    out.push({ seq, text: item.text.trim() });
  }
  out.sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].seq === out[i - 1].seq) {
      throw new ApiError('DUPLICATE_SEQ', `序号重复：${out[i].seq}（序号在同一版本内必须唯一）`);
    }
  }
  return out;
}

function decodeEntries(versionRow) {
  if (!versionRow) return [];
  try {
    const list = JSON.parse(versionRow.entriesJson);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// 控制权是否仍在有效期内（兼容原始行 snake_case 与快照别名 camelCase）
function isControlActive(session, now = Date.now()) {
  const token = session ? session.controlToken ?? session.control_token : null;
  const expiresAt = session ? session.controlExpiresAt ?? session.control_expires_at : null;
  return Boolean(token && expiresAt && expiresAt > now);
}

// 构造对外广播/返回的场次快照（观众页与操作员页共同依据）
function buildSnapshot(sessionId) {
  const s = db.getSession(sessionId);
  if (!s) throw new ApiError('SESSION_NOT_FOUND', '场次不存在', 404);

  const version = s.versionId ? db.getVersion(s.versionId) : null;
  const entries = decodeEntries(version);
  const now = Date.now();
  const active = isControlActive(s, now);

  let current = null;
  if (s.showing && s.currentIndex >= 1 && entries[s.currentIndex - 1]) {
    const e = entries[s.currentIndex - 1];
    current = { seq: e.seq, text: e.text };
  }

  return {
    sessionId: s.id,
    scriptId: s.scriptId,
    name: s.name,
    status: s.status,
    version: version
      ? { id: version.id, version: version.version, label: version.label, total: entries.length }
      : null,
    entries, // 操作员页需要完整条目；观众页只渲染 current，不影响正确性
    currentIndex: s.currentIndex,
    showing: !!s.showing,
    current,
    stateVersion: s.stateVersion,
    control: {
      active,
      heldByMe: false, // 由调用方按 token 填充
      holderName: active ? s.controlName : null,
      expiresAt: active ? s.controlExpiresAt : null,
      ttlRemainingMs: active ? s.controlExpiresAt - now : 0,
    },
    closedAt: s.closedAt || null,
  };
}

// 快照 + 标识当前连接是否为持控者
function snapshotFor(sessionId, token) {
  const snap = buildSnapshot(sessionId);
  const s = db.getSession(sessionId);
  snap.control.heldByMe = Boolean(token && s.controlToken === token && snap.control.active);
  return snap;
}

module.exports = {
  ApiError,
  isNonEmptyString,
  normalizeEntries,
  decodeEntries,
  isControlActive,
  buildSnapshot,
  snapshotFor,
};
