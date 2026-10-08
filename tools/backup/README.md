# BACKUP_BACKEND — recuperación offline, sin coste de servicios

Este bloque implementa exportación lógica de SQLite local, verificación y restauración a un archivo nuevo. No contiene cliente Cloudflare, credenciales, endpoint Worker, programación automática ni opción de restauración remota. No es todavía una certificación de exportación/restauración D1 remota.

## Esquema certificado

Base frontend: fd145309c6745e626ae1d2bac950cfe72e7d1871. Backend de referencia del cutover: deacebbc-b883-4da1-8c19-ca45130e8bb2. El repositorio publicado contiene solo migraciones 0001–0002 y un Worker anterior: no sustituir el backend desplegado por ese Worker. Las ocho migraciones copiadas aquí proceden del paquete local certificado MI-TESLA-AI/source/d1/migrations del cutover. Sus hashes quedan fijados en migration-pins.json. Son fixtures de reconstrucción offline, no una migración nueva ni instrucciones para aplicar sobre producción.

Inventario incluido: vehicles, vehicle_vin_allowlist, vehicle_settings, automation_rules, locations, trips, charging_sessions, pending_actions, alerts, battery_snapshots, odometer_snapshots, power_snapshots, system_state. Preserva todas sus columnas, incluyendo revision y deleted_at. Conserva relaciones de trips/charging_sessions con vehículos, lugares y reglas; también las referencias circulares lugar/regla mediante FK diferidas.

Se excluyen sessions (incluido token_hash), oauth_start_tokens, oauth_refresh_lock, push_config, push_subscriptions, telemetry_nonces, quarantined_events, telemetry_events_short_retention, vehicle_snapshots, bridge_heartbeats, usage_counters, sync_state. Sesiones de carga son negocio; sesiones de autenticación no tienen relación FK necesaria con negocio. No se exporta KV, variables de entorno ni configuración del Worker. Los contadores operativos y datos temporales no se reconstruyen. La autorización VIN/configuración de automatización incluida debe revisarse antes de conectar una DB recuperada a un Worker real.

## Formato v1

JSON UTF-8: {manifest, collections, sha256}. manifest contiene schema_version=1, created_at UTC con zona, source_db_id, app_backend_version, migration_sha256, record_counts y collection_sha256. Hashes SHA-256 en hexadecimal. Colecciones con todas las columnas; filas ordenadas por sus bytes JSON canónicos. JSON canónico = claves ordenadas, sin espacios, Unicode literal, números finitos. SHA global cubre manifest y collections, excluyendo únicamente su propio campo sha256. Los hashes de colección cubren el array completo. Este formato usa la codificación de Python, no declara compatibilidad JCS; otras implementaciones deben producir los mismos bytes.

Exportación abre SQLite en mode=ro y usa una transacción de lectura única. Valida todo el esquema contra las ocho migraciones, integridad FK y autoridad CANONICAL estable. Rechaza IMPORTING/VERIFYING/LEGACY para evitar capturas parciales. El ledger D1 no se copia; la compatibilidad se representa mediante hashes de las migraciones. Todos los valores SQLite y los JSON almacenados como texto se preservan sin reinterpretarlos durante la escritura.

La verificación reconstruye en memoria el esquema y todos los registros, comprueba FK, tipos, inventarios exactos, hashes y equivalencia de cada fila. No acepta SQL ni esquema suministrados por el backup. Rechaza claves JSON duplicadas, columnas desconocidas y secretos reconocibles dentro de JSON anidado.

## Uso local

Desde el repositorio, Python 3 (solo biblioteca estándar):

```sh
python3 tools/backup/backup.py export canonical.sqlite backup-20261008.json --source-id synthetic-local --app-version fd145309/backend-deacebbc
python3 tools/backup/backup.py verify backup-20261008.json
python3 tools/backup/backup.py restore backup-20261008.json recovery-new.sqlite
python3 -m unittest discover -s tools/backup -p test_backup.py -v
```

El archivo fuente debe tener el esquema exacto de las ocho migraciones y autoridad CANONICAL. No usar un fixture como si fuera un backup de producción. Export y restore crean con O_EXCL y permisos 0600: rutas existentes, incluidos enlaces simbólicos, no se sobrescriben. Es append-only por herramienta; el propietario del archivo puede modificarlo y debe conservar copias fuera del equipo. Restore valida antes de crear, reconstruye el esquema fijado, usa una transacción con FK diferidas y verifica equivalencia antes de commit. Ante error elimina exclusivamente el destino que acaba de crear. Una interrupción del proceso puede dejar un archivo incompleto: nunca reutilizarlo, crear otro destino y verificar.

## Amenazas y límites

Hash detecta corrupción accidental, no autentica al autor frente a un atacante capaz de recalcular todos los hashes. Mantener archivos en almacenamiento privado, con controles de acceso y copias independientes; no publicar backups en un repositorio. VIN, ubicaciones y recorridos son datos personales. La allowlist de tablas impide exportar almacenes de credenciales conocidos; el escaneo rechaza nombres de campos y patrones reconocibles de credenciales, pero no puede demostrar que texto libre arbitrario no contiene un secreto sin etiqueta. No hay cifrado ni firma y no se inventa una garantía de detección universal.

Se rechazan esquema incompatible, FK rotas, autoridad inestable, hash incorrecto, registros duplicados y destino existente. La memoria requerida crece con el backup: límite práctico pendiente de medir con volumen real. No se ofrecen exportaciones paginadas sin snapshot consistente. Un origen SQL no se ejecuta desde un archivo no confiable.

## Promoción posterior

BACKUP → VERIFY → RESTORE_TO_FRESH_DB → VERIFY → OPTIONAL_CUTOVER. La autoridad CANONICAL se conserva como dato offline; no implica autorización de cutover. El destino recuperado no tiene sesiones autenticadas ni secretos OAuth/push.

Para integrar D1 remoto: recuperar primero el backend canónico en una rama versionada con sus módulos y ocho migraciones; diseñar un exportador con snapshot consistente y columnas fijadas; certificar en D1 staging/fresca con fixtures, IDs permitidos y denylist explícita del UUID producción 98d74aae-e2f2-40d0-8c20-3349f08ada1f. No introducir aquí un importador remoto ni ejecutar SQL contra producción. La adquisición de un snapshot D1 remoto aún no está implementada. No hace falta contratar almacenamiento; el artefacto local es el primer entregable de coste 0 €. La automatización y política de retención están pendientes.
