import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Account archival extends the original schema without replacing any records.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, color TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('expense','income','transfer')),
  account_id TEXT NOT NULL REFERENCES accounts(id), category_id TEXT NOT NULL REFERENCES categories(id),
  note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id), PRIMARY KEY(transaction_id,tag_id)
);
CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag ON transaction_tags(tag_id);
CREATE TABLE IF NOT EXISTS budgets (
  tag_id TEXT NOT NULL REFERENCES tags(id), month TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0), PRIMARY KEY(tag_id,month)
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, snapshot TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shortcut_connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('toss','kb')),
  account_id TEXT REFERENCES accounts(id), match_text TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES categories(id), tag_ids TEXT NOT NULL DEFAULT '[]',
  auto_record INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  token_hash TEXT UNIQUE, last_received_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shortcut_events (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, connection_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('toss','kb')), title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, source_app TEXT NOT NULL DEFAULT '',
  occurred_at TEXT, transaction_time TEXT, received_at TEXT NOT NULL,
  external_event_id TEXT, fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','recorded','ignored','duplicate')),
  reason TEXT NOT NULL, parsed TEXT NOT NULL,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shortcut_event_external
  ON shortcut_events(connection_id,external_event_id) WHERE external_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shortcut_event_fingerprint
  ON shortcut_events(connection_id,fingerprint);
CREATE INDEX IF NOT EXISTS idx_shortcut_events_received ON shortcut_events(received_at);
`;

export const ACCOUNTS = [
  ['account-ibk', '기업은행', '월급 받는 통장', '#2563eb'],
  ['account-kb', '국민카드', '고정 생활비(식비 등)', '#eab308'],
  ['account-toss', '토스 카드', '당월 구독료, 전월 교통비', '#6366f1'],
  ['account-extra', '여유 생활비', '고정 생활비 외 여가·취미·데이트 등. 금융수단 미정', '#14b8a6'],
];
export const CATEGORIES = [
  ['category-food', '식사', '#f97316'], ['category-living', '생활', '#3b82f6'],
  ['category-subscription', '구독', '#8b5cf6'], ['category-transport', '교통', '#06b6d4'],
  ['category-hobby', '취미', '#ec4899'], ['category-other', '기타', '#64748b'],
];

export function createDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=20000; PRAGMA journal_mode=WAL;');
    db.exec(SCHEMA);
    db.exec('BEGIN IMMEDIATE');
    try {
      const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
      if (!db.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'archived')) {
        db.exec('ALTER TABLE accounts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
      }
      // Restored empty collections and explicitly deleted records remain empty.
      if (schemaVersion === 0) {
        const account = db.prepare('INSERT OR IGNORE INTO accounts(id,name,description,color) VALUES (?,?,?,?)');
        const category = db.prepare('INSERT OR IGNORE INTO categories(id,name,color) VALUES (?,?,?)');
        for (const row of ACCOUNTS) account.run(...row);
        for (const row of CATEGORIES) category.run(...row);
      }
      if (schemaVersion < 2) db.exec('PRAGMA user_version=2');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return db;
  } catch (error) { db.close(); throw error; }
}
