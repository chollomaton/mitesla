# Runtime certificado reconciliado

Entrada: `backend/clean-production-adapter.mjs`. El Worker raíz reexporta esta entrada y las funciones del Worker para las pruebas. Dependencias activas exactas: `backend/worker.js` y `backend/session-auth.mjs`. Estos tres archivos y d1/schema.sql/migraciones 0001–0008 mantienen los hashes SOURCE-PINS del paquete MI-TESLA-AI. No se incorporan production-adapter legacy, baseline-g1.json ni los módulos de importación/cutover que no requiere la entrada activa.

No se despliega ni se modifica main. El frontend permanece en la base inicial; esta certificación local no autoriza promoción ni cutover. La configuración remota actual no se consulta. version_id certificado de referencia: deacebbc-b883-4da1-8c19-ca45130e8bb2; deployment id histórico: 7ceae60d-0481-48ed-b076-7de12bb2c966.

El arnés SQLite aplica las ocho migraciones y activa FK. prepare sin bind y con bind comparte first/all/run reales. Los fixtures de negocio inicializan CANONICAL sintética, vehículos y relaciones válidas. Los tests existentes mantienen sus assertions funcionales y pasan con credenciales de sesión SHA-256 sintéticas; setup conserva ADMIN_TOKEN. El bootstrap opaco, rechazo de ADMIN como sesión, revoke/expiry, fail-closed, revisión y tombstones se verifican mediante peticiones al runtime activo, sin fetch externo real.

La política certificada BUSINESS_WRITE_GUARD permite LEGACY/PREPARED/CANONICAL y bloquea IMPORTING/VERIFYING. Los tests comprueban esa compatibilidad, no imponen una política distinta. Un tombstone no se revive mediante create/patch; restore explícito es una operación separada del producto.

Checks ejecutables: npm test (48 scripts), npm run test:backup (19 casos), npm run test:backup:remote-contract (9 casos), npm run test:bridge. Node >=22.13 con node:sqlite es necesario para el arnés de SQLite real (entorno certificado: Node 24.21.0). No hay scripts de type/lint/build en el proyecto.
