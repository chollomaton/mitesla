-- DATA_CANONICAL / lifecycle mínimo para sesiones consolidadas.
-- No migra contenido ni cambia la autoridad todavía: solo añade concurrencia optimista y tombstone.
ALTER TABLE trips ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trips ADD COLUMN deleted_at TEXT;
ALTER TABLE charging_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE charging_sessions ADD COLUMN deleted_at TEXT;
