CREATE TABLE sessions (
 id TEXT PRIMARY KEY NOT NULL,
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL CHECK(created_at>0),
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at),
 last_used_at INTEGER CHECK(last_used_at IS NULL OR last_used_at>=created_at),
 device_label TEXT NOT NULL DEFAULT '' CHECK(length(device_label)<=80)
);
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE INDEX sessions_active ON sessions(revoked_at, expires_at);
