// B18 (FASE B): verifica que TODAS las migraciones de d1/migrations/ son SQL real y ejecutable (no
// solo "parece bien"), en orden, y que el resultado acumulado no ha quedado desincronizado de
// d1/schema.sql (la referencia legible) ni de la lista de tablas/columnas que el resto del código
// (worker.js, tests/helpers/mock_d1.js) da por hechas. D1 usa SQLite por debajo, así que se ejecuta
// contra una base SQLite real en memoria — la validación más fuerte disponible sin desplegar contra
// Cloudflare de verdad.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

let fallos = 0;
function check(cond, msg) {
  if (!cond) { console.log('❌ FALLO:', msg); fallos++; }
  else console.log('✅', msg);
}

const dirMigraciones = path.join(__dirname, '..', 'd1', 'migrations');
const rutaSchema = path.join(__dirname, '..', 'd1', 'schema.sql');

// B9 (FASE B): 0002 añade capacidad_nominal_kwh — las migraciones ahora son más de una, así que se
// aplican TODAS en orden numérico (igual que haría `wrangler d1 migrations apply`), no solo la 0001.
const ficherosMigracion = fs.readdirSync(dirMigraciones).filter((f) => f.endsWith('.sql')).sort();
check(ficherosMigracion.length >= 2, 'hay al menos 2 migraciones en d1/migrations/ (0001_initial + 0002_capacidad_nominal_vehiculo)');
check(ficherosMigracion[0] === '0001_initial.sql', 'la primera migración sigue siendo 0001_initial.sql (orden estable)');

const sqlMigracionesConcatenado = ficherosMigracion.map((f) => fs.readFileSync(path.join(dirMigraciones, f), 'utf8')).join('\n');
const sqlSchema = fs.readFileSync(rutaSchema, 'utf8');

// ---- Las migraciones son SQL real: se ejecutan EN ORDEN contra SQLite de verdad, no se asume ----
let db;
let ejecutoSinErrores = true;
let errorEjecucion = null;
let ficheroConError = null;
try {
  db = new DatabaseSync(':memory:');
  for (const f of ficherosMigracion) {
    try {
      db.exec(fs.readFileSync(path.join(dirMigraciones, f), 'utf8'));
    } catch (e) {
      ficheroConError = f;
      throw e;
    }
  }
} catch (e) {
  ejecutoSinErrores = false;
  errorEjecucion = e;
}
check(ejecutoSinErrores, 'todas las migraciones de d1/migrations/ se ejecutan en orden sin errores contra SQLite real' + (errorEjecucion ? (' — ERROR en ' + ficheroConError + ': ' + errorEjecucion.message) : ''));

if (ejecutoSinErrores) {
  // ---- Tablas que el resto del código (worker.js, mock_d1.js, FASE A) da por hechas ----
  const tablasEsperadas = [
    'vehicles', 'vehicle_snapshots', 'telemetry_events_short_retention',
    'trips', 'charging_sessions', 'battery_snapshots', 'odometer_snapshots',
    'telemetry_nonces', 'vehicle_vin_allowlist', 'vehicle_settings',
    'bridge_heartbeats', 'usage_counters', 'quarantined_events',
    'oauth_start_tokens', 'oauth_refresh_lock'
  ];
  const filas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const tablasReales = new Set(filas.map((f) => f.name));
  for (const t of tablasEsperadas) {
    check(tablasReales.has(t), 'las migraciones crean la tabla "' + t + '" (usada por worker.js/mock_d1.js)');
  }

  // ---- is_shadow (A10/FASE A) realmente presente en las tres tablas que lo necesitan ----
  for (const t of ['trips', 'charging_sessions', 'pending_actions']) {
    const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
    check(cols.indexOf('is_shadow') !== -1, 'la tabla "' + t + '" tiene la columna is_shadow (A10)');
  }

  // ---- B9: capacidad_nominal_kwh (0002) realmente presente en vehicles ----
  const colsVehiculos = db.prepare('PRAGMA table_info(vehicles)').all().map((c) => c.name);
  check(colsVehiculos.indexOf('capacidad_nominal_kwh') !== -1, 'B9: la migración 0002 añade capacidad_nominal_kwh a la tabla "vehicles"');

  // ---- Operaciones reales de humo: insertar y leer, no solo comprobar que existe la tabla ----
  db.prepare('INSERT INTO vehicles (vin, nombre, modelo, capacidad_nominal_kwh, creado_en, actualizado_en) VALUES (?,?,?,?,?,?)')
    .run('5YJ3E1EA1PF000001', 'Mi Model Y', 'Model Y', 75, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
  const vehiculo = db.prepare('SELECT * FROM vehicles WHERE vin = ?').get('5YJ3E1EA1PF000001');
  check(!!vehiculo && vehiculo.nombre === 'Mi Model Y', 'se puede insertar y leer una fila real en la tabla "vehicles" creada por las migraciones');
  check(vehiculo.capacidad_nominal_kwh === 75, 'B9: capacidad_nominal_kwh se guarda y se lee de verdad tras aplicar la migración 0002 sobre la 0001');

  // UNIQUE de telemetry_nonces (A13): un segundo INSERT con el mismo (vin, nonce) debe fallar.
  db.exec("CREATE TABLE IF NOT EXISTS _dummy_check (x INTEGER)"); // no-op, solo confirma que exec sigue operativo tras los INSERT anteriores
  let violoUnique = false;
  try {
    db.prepare('INSERT INTO telemetry_nonces (vin, nonce, creado_en) VALUES (?,?,?)').run('VIN1', 'nonceA', '2026-09-20T00:00:00.000Z');
    db.prepare('INSERT INTO telemetry_nonces (vin, nonce, creado_en) VALUES (?,?,?)').run('VIN1', 'nonceA', '2026-09-20T00:00:01.000Z');
  } catch (e) {
    violoUnique = true;
  }
  check(violoUnique, 'la restricción UNIQUE de telemetry_nonces (vin, nonce) es real en las migraciones ejecutadas — no solo declarada en un comentario (A13)');

  db.close();
}

// ---- No desincronizado de la referencia legible d1/schema.sql ----
// El contenido "funcional" (todo lo que no son comentarios) de TODAS las migraciones concatenadas
// en orden debe ser el mismo que el de schema.sql — si alguien edita uno sin el otro, este test debe
// detectarlo (antes de B9 esto comparaba solo 0001 contra schema.sql; ahora que hay más de una
// migración, se compara la concatenación completa, que es lo que `wrangler d1 migrations apply`
// termina aplicando de verdad).
function soloSql(texto) {
  return texto.split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}
check(soloSql(sqlMigracionesConcatenado) === soloSql(sqlSchema), 'd1/migrations/*.sql (todas, en orden) y d1/schema.sql tienen el mismo SQL real (solo difieren en comentarios) — no han quedado desincronizados');

console.log('\n' + (fallos === 0 ? 'TODO OK — migraciones D1 (B18/B9): SQL real, ejecutado en orden, verificado' : fallos + ' fallo(s).'));
process.exit(fallos === 0 ? 0 : 1);
