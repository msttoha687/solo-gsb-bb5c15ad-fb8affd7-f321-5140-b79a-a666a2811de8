'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { IDEMPOTENCY_TTL_SECONDS } = require('./config');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  // WAL 在崩溃/重启后仍可恢复，且读写互不阻塞
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS scripts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drafts (
      script_id   INTEGER PRIMARY KEY REFERENCES scripts(id) ON DELETE CASCADE,
      entries_json TEXT NOT NULL DEFAULT '[]',
      updated_at  INTEGER NOT NULL
    );

    -- 已发布的演出版本：一经发布内容不可修改（新版本只能追加）
    CREATE TABLE IF NOT EXISTS versions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id   INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      label       TEXT NOT NULL,
      entries_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(script_id, version)
    );

    -- 场次：一个脚本可建多个场次；场次决定观众看到的字幕
    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id     INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      version_id    INTEGER REFERENCES versions(id) ON DELETE RESTRICT,
      status        TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','live','closed')),
      current_index INTEGER NOT NULL DEFAULT 0,   -- 当前条目序号；0 表示尚未上词
      showing       INTEGER NOT NULL DEFAULT 0,   -- 1 观众屏显示当前条目，0 清屏
      state_version INTEGER NOT NULL DEFAULT 0,   -- 每次有效演出操作 +1，作为乐观锁
      control_token TEXT,                        -- 持有者令牌；NULL 表示无人持控
      control_name  TEXT,
      control_expires_at INTEGER,
      closed_at     INTEGER,
      created_at    INTEGER NOT NULL
    );

    -- 操作幂等记录：同一场次同一 op_id 只生效一次
    CREATE TABLE IF NOT EXISTS session_ops (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      op_id       TEXT NOT NULL,
      op_type     TEXT NOT NULL,
      base_version INTEGER,
      result      TEXT NOT NULL,                  -- applied / rejected
      reason      TEXT,
      new_version INTEGER,
      created_at  INTEGER NOT NULL,
      UNIQUE(session_id, op_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_ops_time ON session_ops(created_at);
  `);

  const now = Date.now();
  // 首次启动播种一个默认脚本与空草稿
  const seed = db.prepare(
    'INSERT OR IGNORE INTO scripts (id, title, created_at) VALUES (1, ?, ?)'
  ).run('默认剧本', now);
  if (seed.changes > 0) {
    db.prepare(
      'INSERT INTO drafts (script_id, entries_json, updated_at) VALUES (1, ?, ?)'
    ).run('[]', now);
  }

  return db;
}

function getDb() {
  return db;
}

// ---------- 脚本 / 草稿 ----------

function listScripts() {
  return db.prepare('SELECT id, title, created_at AS created_at FROM scripts ORDER BY id').all();
}

function getScript(scriptId) {
  return db.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId);
}

function createScript(title) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO scripts (title, created_at) VALUES (?, ?)').run(title, now);
  db.prepare('INSERT INTO drafts (script_id, entries_json, updated_at) VALUES (?, ?, ?)')
    .run(info.lastInsertRowid, '[]', now);
  return info.lastInsertRowid;
}

function getDraft(scriptId) {
  return db.prepare('SELECT * FROM drafts WHERE script_id = ?').get(scriptId);
}

function saveDraft(scriptId, entries) {
  db.prepare('UPDATE drafts SET entries_json = ?, updated_at = ? WHERE script_id = ?')
    .run(JSON.stringify(entries), Date.now(), scriptId);
}

// ---------- 版本 ----------

function listVersions(scriptId) {
  return db.prepare(
    'SELECT id, script_id AS scriptId, version, label, entries_json AS entriesJson, created_at AS createdAt ' +
    'FROM versions WHERE script_id = ? ORDER BY version DESC'
  ).all(scriptId);
}

function getVersion(versionId) {
  return db.prepare(
    'SELECT id, script_id AS scriptId, version, label, entries_json AS entriesJson, created_at AS createdAt ' +
    'FROM versions WHERE id = ?'
  ).get(versionId);
}

function getLatestVersion(scriptId) {
  return db.prepare(
    'SELECT id, script_id AS scriptId, version, label, entries_json AS entriesJson, created_at AS createdAt ' +
    'FROM versions WHERE script_id = ? ORDER BY version DESC LIMIT 1'
  ).get(scriptId);
}

function insertVersion(scriptId, label, entries) {
  const now = Date.now();
  return db.transaction(() => {
    const latest = db.prepare('SELECT MAX(version) AS v FROM versions WHERE script_id = ?').get(scriptId).v;
    const next = (latest || 0) + 1;
    const info = db.prepare(
      'INSERT INTO versions (script_id, version, label, entries_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(scriptId, next, label, JSON.stringify(entries), now);
    return getVersion(info.lastInsertRowid);
  })();
}

// ---------- 场次 ----------

function listSessions(scriptId) {
  return db.prepare(
    `SELECT id, script_id AS scriptId, name, version_id AS versionId, status,
            current_index AS currentIndex, showing, state_version AS stateVersion,
            control_token AS controlToken, control_name AS controlName,
            control_expires_at AS controlExpiresAt, closed_at AS closedAt, created_at AS createdAt
     FROM sessions WHERE script_id = ? ORDER BY id DESC`
  ).all(scriptId);
}

function getSessionRow(sessionId) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

function getSession(sessionId) {
  return db.prepare(
    `SELECT id, script_id AS scriptId, name, version_id AS versionId, status,
            current_index AS currentIndex, showing, state_version AS stateVersion,
            control_token AS controlToken, control_name AS controlName,
            control_expires_at AS controlExpiresAt, closed_at AS closedAt, created_at AS createdAt
     FROM sessions WHERE id = ?`
  ).get(sessionId);
}

function latestSessionId() {
  const row = db.prepare('SELECT MAX(id) AS id FROM sessions').get();
  return row.id || null;
}

function createSession(scriptId, name, versionId) {
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO sessions (script_id, name, version_id, status, current_index, showing, state_version, created_at)
     VALUES (?, ?, ?, 'ready', 0, 0, 0, ?)`
  ).run(scriptId, name, versionId, now);
  return info.lastInsertRowid;
}

// ---------- 幂等表 ----------

function cleanupOps(now = Date.now()) {
  db.prepare('DELETE FROM session_ops WHERE created_at < ?').run(now - IDEMPOTENCY_TTL_SECONDS * 1000);
}

function findOp(sessionId, opId) {
  return db.prepare(
    `SELECT op_id AS opId, op_type AS opType, base_version AS baseVersion, result, reason,
            new_version AS newVersion, created_at AS createdAt
     FROM session_ops WHERE session_id = ? AND op_id = ?`
  ).get(sessionId, opId);
}

function recordOp(sessionId, opId, opType, baseVersion, result, reason, newVersion) {
  db.prepare(
    `INSERT INTO session_ops (session_id, op_id, op_type, base_version, result, reason, new_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, opId, opType, baseVersion ?? null, result, reason ?? null, newVersion ?? null, Date.now());
}

module.exports = {
  init,
  getDb,
  listScripts,
  getScript,
  createScript,
  getDraft,
  saveDraft,
  listVersions,
  getVersion,
  getLatestVersion,
  insertVersion,
  listSessions,
  getSessionRow,
  getSession,
  latestSessionId,
  createSession,
  cleanupOps,
  findOp,
  recordOp,
};
