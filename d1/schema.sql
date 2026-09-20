-- Mi Tesla · Fase 4 · esquema Cloudflare D1 (referencia de solo lectura)
-- Diseñado para UN ÚNICO vehículo personal (no multi-tenant): sin overhead de particionado,
-- índices mínimos pero suficientes para las consultas reales de la app (nunca "SELECT *" sin
-- filtro de fecha/estado).
--
-- B18 (FASE B, 2026-09-20): este fichero YA NO es el método de despliegue — se mantiene solo como
-- referencia legible del esquema completo en un único lugar. El despliegue real usa las migraciones
-- versionadas de d1/migrations/ (0001_initial.sql = este mismo contenido tal y como estaba hoy, y
-- cada cambio posterior como un fichero nuevo 0002_*.sql...). Desplegar con:
--   wrangler d1 migrations apply mitesla-datos [--remote]
-- Si en el futuro se edita el esquema, el cambio real va en una migración nueva; este fichero se
-- actualiza a la vez solo para que la vista de conjunto no quede desactualizada, nunca al revés.
--
-- Política de retención (sección 5 de la Fase 4):
--   A. vehicle_snapshots      -> 1 fila "viva" por vehículo, se sobrescribe (UPSERT), no crece.
--   B. telemetry_events_short_retention -> eventos discretos (arranca/para/enchufa/etc.), purga >7 días.
--   C. trips / charging_sessions / battery_snapshots / odometer_snapshots -> consolidados, para siempre.
-- La telemetría CRUDA de alta frecuencia (posición cada pocos segundos, etc.) NUNCA se escribe
-- en D1 tal cual: el bridge (telemetry-bridge/) ya la agrega en la VM antes de enviar nada aquí.

CREATE TABLE IF NOT EXISTS vehicles (
  vin TEXT PRIMARY KEY,
  nombre TEXT,
  modelo TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

-- ============================================================================================
-- FASE A (auditoría externa, 2026-09-20) — tablas nuevas. Como la infraestructura de la Fase 4
-- NUNCA ha llegado a desplegarse contra D1 real (sección 0 del informe de auditoría), se han
-- podido modificar las CREATE TABLE existentes directamente en vez de añadir migraciones ALTER
-- TABLE aparte. Si en algún momento este schema.sql SÍ se ha ejecutado ya contra una base D1 real
-- con datos, hay que aplicar a mano las columnas nuevas marcadas "FASE A" más abajo con ALTER
-- TABLE antes de re-ejecutar este archivo (CREATE TABLE IF NOT EXISTS no las añadiría solo).
-- La migración a `wrangler d1 migrations` en condiciones (varios ficheros 0001_, 0002_...) queda
-- para la Fase B (punto B18) tal y como pide el encargo — aquí solo se corrige lo crítico de A.
-- ============================================================================================

-- A13 — antirreplay HMAC atómico: antes se comprobaba con un GET+PUT sobre KV (dos operaciones
-- separadas, sin garantía de atomicidad entre isolates concurrentes). Ahora el nonce se inserta
-- con INSERT (sin OR IGNORE) sobre una PRIMARY KEY: si el nonce ya existe, D1/SQLite lanza un
-- error de restricción UNIQUE de forma atómica y la petición se rechaza — no hay ventana de carrera.
CREATE TABLE IF NOT EXISTS telemetry_nonces (
  nonce TEXT PRIMARY KEY,
  creado_en TEXT NOT NULL
);

-- A14 — el VIN de telemetría debe pertenecer a un vehículo autorizado explícitamente (no "cualquier
-- string de 17 caracteres"). Se rellena una vez, a mano o desde /vehiculos, nunca automáticamente
-- a partir de un payload entrante.
CREATE TABLE IF NOT EXISTS vehicle_vin_allowlist (
  vin TEXT PRIMARY KEY,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL
);

-- A10 — Shadow Mode real (no solo un flag de frontend). off=no se procesa nada; shadow=se detecta
-- y se guarda todo con is_shadow=1 (ver trips/charging_sessions más abajo) SIN afectar Economía/
-- Stats/pendientes reales; active=modo normal, registros canónicos.
CREATE TABLE IF NOT EXISTS vehicle_settings (
  vin TEXT PRIMARY KEY REFERENCES vehicles(vin),
  automation_mode TEXT NOT NULL DEFAULT 'off', -- 'off' | 'shadow' | 'active'
  updated_at TEXT NOT NULL
);

-- A9 — Health check real: separa explícitamente "el bridge está vivo" de "MQTT tiene mensajes" de
-- "Tesla está conectado" de "Tesla está enviando métricas de verdad" — antes un snapshot reenviado
-- sin cambios podía aparentar actividad indefinidamente.
CREATE TABLE IF NOT EXISTS bridge_heartbeats (
  vin TEXT PRIMARY KEY REFERENCES vehicles(vin),
  last_bridge_heartbeat_at TEXT,   -- el bridge está vivo y ejecutando su ciclo (aunque no haya datos nuevos)
  last_mqtt_message_at TEXT,       -- ha llegado CUALQUIER mensaje MQTT (aunque sea metadatos)
  last_tesla_message_at TEXT,      -- ha llegado un valor de campo (Soc/Odometer/Gear/...) con valor VÁLIDO
  last_vehicle_metric_at TEXT,     -- alias explícito de last_tesla_message_at para claridad en el dashboard
  last_connectivity_at TEXT,       -- último mensaje del topic connectivity
  connectivity_status TEXT,        -- valor bruto del último mensaje de connectivity ('connected'/'disconnected'/...)
  updated_at TEXT NOT NULL
);

-- A25 — contadores de coste reales: antes se contaban trip_started/trip_finished como si fueran
-- "señales Tesla" cobradas, mezclando conceptos. Aquí se separan explícitamente las categorías que
-- SÍ tienen coste real en la Fleet API de las que son puramente derivadas (gratis, cómputo local).
CREATE TABLE IF NOT EXISTS usage_counters (
  vin TEXT PRIMARY KEY REFERENCES vehicles(vin),
  telemetry_signals_received INTEGER NOT NULL DEFAULT 0, -- señales de streaming recibidas (con coste, ~0,0001$/u)
  derived_events INTEGER NOT NULL DEFAULT 0,              -- trip_started/trip_finished/etc. calculados localmente (coste 0)
  vehicle_data_calls INTEGER NOT NULL DEFAULT 0,          -- llamadas polling vehicle_data (coste ~0,002$/u)
  wakes INTEGER NOT NULL DEFAULT 0,                       -- wake_up (coste ~0,02$/u)
  commands INTEGER NOT NULL DEFAULT 0,                    -- comandos (coste ~0,001$/u)
  errores_mes INTEGER NOT NULL DEFAULT 0,
  mes_referencia TEXT,
  actualizado_en TEXT NOT NULL
);

-- A15 — eventos rechazados por validación de /internal/telemetry, para poder inspeccionarlos en
-- vez de solo descartarlos (evita que un payload malformado desaparezca sin dejar rastro).
CREATE TABLE IF NOT EXISTS quarantined_events (
  id TEXT PRIMARY KEY,
  vin TEXT,
  motivo TEXT NOT NULL,
  payload_recortado TEXT NOT NULL, -- primeros N bytes del cuerpo recibido, para depurar sin guardar payloads gigantes
  recibido_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cuarentena_fecha ON quarantined_events(recibido_en);

-- A11 — tokens de un solo uso para iniciar OAuth sin exponer ADMIN_TOKEN en la URL de /oauth/start.
CREATE TABLE IF NOT EXISTS oauth_start_tokens (
  token TEXT PRIMARY KEY,
  creado_en TEXT NOT NULL,
  usado_en TEXT
);

-- A12 — lock de refresco de refresh_token con consistencia fuerte. Antes se usaba únicamente KV
-- (get + put separados, consistencia eventual entre regiones de Cloudflare) como red de seguridad
-- para el caso de dos isolates distintos refrescando a la vez — Tesla rota el refresh_token en
-- cada uso, así que dos refrescos simultáneos podían dejar un refresh_token inválido y desconectar
-- la cuenta. D1 es una única base SQLite (no replicada entre isolates como KV), así que un INSERT
-- sobre esta PRIMARY KEY de una sola fila es atómico de verdad: solo un isolate puede "tener" la
-- fila a la vez. Fila única con id fijo 'global' (esta app gestiona una sola cuenta Tesla).
CREATE TABLE IF NOT EXISTS oauth_refresh_lock (
  id TEXT PRIMARY KEY,
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- ============================================================================================

-- A. Estado actual: una sola fila por vehículo, siempre UPSERT (nunca INSERT nuevo por evento).
CREATE TABLE IF NOT EXISTS vehicle_snapshots (
  vin TEXT PRIMARY KEY REFERENCES vehicles(vin),
  soc_pct REAL,
  autonomia_km REAL,
  odometro_km REAL,
  estado TEXT,                    -- 'parked' | 'driving' | 'charging' | 'asleep' | 'desconocido'
  lat REAL, lng REAL,
  ubicacion_nombre TEXT,          -- resuelto por geofence si aplica, nunca escrito por el usuario aquí
  temperatura_exterior REAL,
  potencia_carga_kw REAL,
  tiempo_restante_carga_min REAL,
  fuente TEXT NOT NULL,           -- TESLA_TELEMETRY | TESLA_API
  observado_en TEXT NOT NULL,     -- timestamp del propio dato (no de inserción)
  recibido_en TEXT NOT NULL
);

-- B. Eventos discretos de corta retención — el "pulso" bruto ya agregado por el bridge.
CREATE TABLE IF NOT EXISTS telemetry_events_short_retention (
  id TEXT PRIMARY KEY,            -- event_id determinista (ver telemetry-bridge) — dedupe/idempotencia
  vin TEXT NOT NULL REFERENCES vehicles(vin),
  tipo TEXT NOT NULL,             -- trip_started | trip_finished | charge_started | charge_stopped | ...
  payload TEXT NOT NULL,          -- JSON compacto con los campos ya normalizados de ese evento
  observado_en TEXT NOT NULL,
  recibido_en TEXT NOT NULL,
  procesado_en TEXT               -- NULL hasta que el motor de viajes/cargas (Fase 4B/4C) lo consolida
);
CREATE INDEX IF NOT EXISTS idx_tesr_vin_fecha ON telemetry_events_short_retention(vin, observado_en);
CREATE INDEX IF NOT EXISTS idx_tesr_sin_procesar ON telemetry_events_short_retention(vin, tipo, observado_en) WHERE procesado_en IS NULL;

-- C. Sesiones consolidadas — lo que la app realmente lee para pintar Viajes/Estadísticas.
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  vin TEXT NOT NULL REFERENCES vehicles(vin),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  start_odometer_km REAL,
  end_odometer_km REAL,
  distance_km REAL,
  duration_min REAL,
  start_soc_pct REAL,
  end_soc_pct REAL,
  start_energy_remaining_kwh REAL,
  end_energy_remaining_kwh REAL,
  energy_used_kwh REAL,
  energy_source TEXT,             -- 'energy_remaining_delta' | 'soc_delta_estimado' | null
  consumption_is_estimated INTEGER NOT NULL DEFAULT 0,
  start_lat REAL, start_lng REAL, end_lat REAL, end_lng REAL,
  start_location_id TEXT REFERENCES locations(id),
  end_location_id TEXT REFERENCES locations(id),
  start_location_raw TEXT,        -- lo que devolvió Tesla/reverse-geocoding (sin corregir)
  end_location_raw TEXT,
  outside_temp_start REAL,
  outside_temp_end REAL,
  classification TEXT,            -- 'trabajo' | 'personal' | 'otro' | null (sin clasificar)
  classification_source TEXT,     -- 'rule' | 'manual' | null
  classification_rule_id TEXT REFERENCES automation_rules(id),
  manual_override TEXT,           -- JSON: qué campos ha tocado el usuario a mano (nunca se resincronizan)
  data_quality TEXT NOT NULL DEFAULT 'complete', -- complete | partial | reconstructed | estimated
  source TEXT NOT NULL,           -- MANUAL | TESLA_TELEMETRY (sección 67)
  is_shadow INTEGER NOT NULL DEFAULT 0, -- FASE A / A10: 1 = detectado en Shadow Mode, nunca alimenta Economía/Stats reales
  route_simplified TEXT,          -- JSON de puntos ya simplificados (sección 30), nunca crudo
  weather TEXT,                   -- JSON de clima asociado (job de enriquecimiento, 4D)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trips_vin_fecha ON trips(vin, started_at);
CREATE INDEX IF NOT EXISTS idx_trips_sin_clasificar ON trips(vin, classification) WHERE classification IS NULL;

CREATE TABLE IF NOT EXISTS charging_sessions (
  id TEXT PRIMARY KEY,
  vin TEXT NOT NULL REFERENCES vehicles(vin),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  start_soc_pct REAL,
  end_soc_pct REAL,
  start_odometer_km REAL,
  energy_kwh REAL,
  energy_source TEXT,             -- 'ac_energy_in' | 'dc_energy_added' | 'soc_delta_estimado'
  charging_current_type TEXT,     -- 'AC' | 'DC' | null
  charger_type TEXT,              -- 'supercharger' | 'domestica' | 'publico' | 'trabajo' | 'otro'
  fast_charger_present INTEGER,
  fast_charger_type TEXT,
  max_power_kw REAL,
  average_power_kw REAL,
  duration_min REAL,
  lat REAL, lng REAL,
  location_id TEXT REFERENCES locations(id),
  total_cost REAL,
  cost_source TEXT,                -- 'conocido' | 'estimado' | 'facturado' | 'gratuita'
  price_rule_id TEXT REFERENCES automation_rules(id),
  tesla_invoice_id TEXT,           -- si se reconcilia con charging history/invoice de Tesla
  manual_override TEXT,
  data_quality TEXT NOT NULL DEFAULT 'complete',
  source TEXT NOT NULL,
  is_shadow INTEGER NOT NULL DEFAULT 0, -- FASE A / A10
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cargas_vin_fecha ON charging_sessions(vin, started_at);
CREATE INDEX IF NOT EXISTS idx_cargas_sin_precio ON charging_sessions(vin, cost_source) WHERE total_cost IS NULL;

-- Geofences / lugares (sección 12). "casa" y "trabajo" son categorías especiales.
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  vin TEXT NOT NULL REFERENCES vehicles(vin),
  name TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  radius_m REAL NOT NULL DEFAULT 150,
  category TEXT,                   -- 'casa' | 'trabajo' | 'otro'
  default_trip_type TEXT,
  default_charging_price_rule_id TEXT REFERENCES automation_rules(id),
  privacy_level TEXT NOT NULL DEFAULT 'normal', -- 'normal' | 'oculta_en_exportaciones'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Reglas de automatización (secciones 13, 21, 37).
CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  vin TEXT NOT NULL REFERENCES vehicles(vin),
  tipo TEXT NOT NULL,              -- 'clasificacion_viaje' | 'precio_carga'
  condicion TEXT NOT NULL,         -- JSON: {origen_location_id, destino_location_id, ...}
  accion TEXT NOT NULL,            -- JSON: {classification:'trabajo'} o {price_kwh:0.39}
  activa INTEGER NOT NULL DEFAULT 1,
  veces_usada INTEGER NOT NULL DEFAULT 0,
  ultima_vez_usada TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Pendientes (sección 36) — lo único que de verdad requiere un toque del usuario.
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  vin TEXT NOT NULL REFERENCES vehicles(vin),
  tipo TEXT NOT NULL,              -- 'clasificar_viaje' | 'precio_carga' | 'confirmar_regla' | ...
  referencia_tabla TEXT NOT NULL,  -- 'trips' | 'charging_sessions'
  referencia_id TEXT NOT NULL,
  detalle TEXT,                    -- JSON con lo necesario para mostrar la pregunta mínima
  resuelto_en TEXT,
  resuelto_con TEXT,                -- JSON con la respuesta dada
  is_shadow INTEGER NOT NULL DEFAULT 0, -- FASE A / A10: en shadow no se generan pendientes "productivos"
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pendientes_abiertos ON pending_actions(vin, resuelto_en) WHERE resuelto_en IS NULL;

-- Alertas (sección 34) con dedupe/cooldown real, no solo en el cliente.
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  vin TEXT NOT NULL REFERENCES vehicles(vin),
  rule TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  severity TEXT NOT NULL,          -- 'critica' | 'accion' | 'informativa'
  mensaje TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alertas_dedupe ON alerts(vin, dedupe_key, created_at);

CREATE TABLE IF NOT EXISTS battery_snapshots (
  id TEXT PRIMARY KEY,
  vin TEXT NOT NULL REFERENCES vehicles(vin),
  fecha TEXT NOT NULL,
  soc_pct REAL,
  energy_remaining_kwh REAL,
  autonomia_km REAL,
  odometro_km REAL,
  temperatura REAL,
  soh_estimate REAL,
  soh_method TEXT,
  soh_confidence TEXT,
  soh_inputs TEXT,                 -- JSON: de qué datos se derivó, para poder recalcular después
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bateria_vin_fecha ON battery_snapshots(vin, fecha);

CREATE TABLE IF NOT EXISTS odometer_snapshots (
  id TEXT PRIMARY KEY,
  vin TEXT NOT NULL REFERENCES vehicles(vin),
  odometro_km REAL NOT NULL,
  observado_en TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_odometro_vin_fecha ON odometer_snapshots(vin, observado_en);

-- Estado de sincronización / diagnóstico (secciones 58-63).
CREATE TABLE IF NOT EXISTS sync_state (
  vin TEXT PRIMARY KEY REFERENCES vehicles(vin),
  ultimo_evento_en TEXT,
  telemetria_activa INTEGER NOT NULL DEFAULT 0,
  eventos_recibidos_mes INTEGER NOT NULL DEFAULT 0,
  vehicle_data_calls_mes INTEGER NOT NULL DEFAULT 0,
  wakes_mes INTEGER NOT NULL DEFAULT 0,
  errores_mes INTEGER NOT NULL DEFAULT 0,
  mes_referencia TEXT,             -- 'YYYY-MM' al que corresponden los contadores anteriores
  actualizado_en TEXT NOT NULL
);

-- B9 (FASE B, d1/migrations/0002_capacidad_nominal_vehiculo.sql) — capacidad nominal de la batería,
-- necesaria para poder ESTIMAR (nunca inventar) el consumo de un viaje por caída de SoC cuando no
-- hay lecturas de EnergyRemaining fiables al inicio y al final. Nullable: sin este dato, esa
-- estimación concreta simplemente no se calcula.
ALTER TABLE vehicles ADD COLUMN capacidad_nominal_kwh REAL;
