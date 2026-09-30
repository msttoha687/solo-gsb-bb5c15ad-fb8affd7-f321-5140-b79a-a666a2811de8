import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 数据库初始化：全部状态持久化在单个 SQLite 文件中，服务重启后据此恢复。
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 场次
CREATE TABLE IF NOT EXISTS shows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 版本：draft=0 为唯一的编辑草稿（随编辑改变）；draft=1 为不可变的已发布版本
CREATE TABLE IF NOT EXISTS versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id     INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,           -- 发布版本号，从 1 开始；草稿恒为 0
  draft       INTEGER NOT NULL DEFAULT 1,
  published_at INTEGER,
  UNIQUE(show_id, version)
);

-- 有序字幕条目
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id  INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  UNIQUE(version_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_entries_version ON entries(version_id);

-- 演出现场状态（每场一行）
CREATE TABLE IF NOT EXISTS perf_states (
  show_id       INTEGER PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL DEFAULT 0,   -- 每次现场操作 +1，用于乐观版本控制
  is_live       INTEGER NOT NULL DEFAULT 0,
  active_ver_id INTEGER REFERENCES versions(id),
  cursor        INTEGER NOT NULL DEFAULT 0,   -- 0=空屏；>0 表示当前条目的 seq
  updated_at    INTEGER NOT NULL DEFAULT 0
);

-- 控台权（每场至多一条有效记录）
CREATE TABLE IF NOT EXISTS controls (
  show_id     INTEGER PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- 已确认操作记录，用于幂等：同一 op_id 只生效一次
CREATE TABLE IF NOT EXISTS op_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id     INTEGER NOT NULL,
  op_id       TEXT NOT NULL,
  action      TEXT NOT NULL,
  req_rev     INTEGER,
  result_rev  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(show_id, op_id)
);
`;

export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
