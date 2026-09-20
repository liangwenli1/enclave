/**
 * 许可证服务的存储层。Node 内置 sqlite，没有 npm 依赖。
 *
 * 表结构一次建好，迁移用 user_version 递增。这个服务的数据量是"账号数"级别，
 * 不需要连接池，也不需要 ORM。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    pass_hash   TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS licenses (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan         TEXT NOT NULL DEFAULT 'free',
    expires_at   INTEGER,
    device_limit INTEGER NOT NULL DEFAULT 1,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS plan_requests (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS plan_requests_user ON plan_requests(user_id, status);

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    topic      TEXT NOT NULL,
    email      TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

export function openDb(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const current = db.prepare("PRAGMA user_version").get().user_version ?? 0;
  for (let v = current; v < SCHEMA.length; v += 1) {
    db.exec(SCHEMA[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
  return db;
}
