-- B11 (FASE B): las columnas max_power_kw/average_power_kw ya existían en charging_sessions
-- (0001_initial.sql) pero nunca se rellenaban de verdad — no había ningún historial de muestras
-- de potencia del que calcularlas, solo la potencia instantánea en los 2 eventos de inicio/fin.
-- Esta migración añade ese historial (power_snapshots, una fila por cada snapshot periódico que
-- traiga potencia_carga_kw numérica) y un contador de cuántas muestras reales entraron en el
-- cálculo de cada sesión (power_samples_count) — para poder distinguir "0,0 kW porque no había
-- ninguna muestra" de "sí hay muestras y el promedio real es bajo".
CREATE TABLE IF NOT EXISTS power_snapshots (
  id TEXT PRIMARY KEY,
  vin TEXT NOT NULL REFERENCES vehicles(vin),
  power_kw REAL NOT NULL,
  observado_en TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_power_snapshots_vin_fecha ON power_snapshots(vin, observado_en);

ALTER TABLE charging_sessions ADD COLUMN power_samples_count INTEGER;
