CREATE TABLE IF NOT EXISTS licenses (
  user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  updated_at BIGINT NOT NULL
);
