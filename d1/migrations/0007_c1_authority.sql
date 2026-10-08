CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(value IN ('LEGACY','PREPARED','IMPORTING','VERIFYING','CANONICAL')), updated_at TEXT NOT NULL);
INSERT OR IGNORE INTO system_state VALUES ('data_authority','LEGACY',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
