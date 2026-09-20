# Mi Tesla — FASE A: informe de entrega

**Fecha:** 2026-09-20
**Alcance:** exclusivamente FASE A (correcciones críticas), tal y como se instruyó explícitamente
("Empieza ahora exclusivamente por FASE A. No avances a FASE B hasta haber terminado, probado y
entregado FASE A completa."). No se ha tocado nada de FASE B/C/D en este informe.

**Regla seguida en cada punto:** localizar el código real → analizar el caso borde descrito →
crear una prueba que lo demuestre → ejecutarla → documentar el resultado. Ningún punto de este
informe se marca IMPLEMENTADO sin una prueba automatizada que lo respalde y que se ha ejecutado
realmente (ver sección "Resultado completo de la suite de pruebas" más abajo).

---

## 1. Checklist A1–A25

| # | Punto | Estado | Evidencia (test) |
|---|---|---|---|
| A1 | Bug de debounce en el emparejamiento de viajes/cargas (P→D en t30/t60 nunca confirmaba) | **IMPLEMENTADO** | `telemetry-bridge/test.js` — bloque "A1: máquina de estados candidato/confirmado", reproduce el escenario exacto t30/t60/t90 y el caso de reinicio del bridge y de flapping |
| A2 | Pérdida de eventos en la cola (`vaciar()` tras enviar borraba eventos en vuelo) | **IMPLEMENTADO** | `telemetry-bridge/test.js` — bloque "A2: ColaPersistente", evento encolado durante un envío en curso sobrevive al `ack()` parcial; también cubre fichero de cola corrupto |
| A3 | Unidades: Odometer en millas, VehicleSpeed en mph tratadas como km/km-h | **IMPLEMENTADO** | `telemetry-bridge/test.js` — 100mi→160.9344km, 60mph→96.56064km/h, delta 10mi→16.09344km, normalización solo en la frontera |
| A4 | Campo `Location` combinado (sustituye a `Latitude`/`Longitude` sueltos) | **IMPLEMENTADO** | `telemetry-bridge/test.js` — `extraerLocation()` + descomposición real en `actualizarEstado()` |
| A5 | `minimum_delta` en campos enum/string (`Gear`, `DetailedChargeState`) en el ejemplo de registro | **IMPLEMENTADO** | Corregido en `infra/README.md` (verificado además que `infra/fleet-telemetry.config.json.template` nunca lo tuvo — no aplicaba ahí) |
| A6 | `invalid:true` no soportado (podía abrir/cerrar viaje o cargar con un valor inválido) | **IMPLEMENTADO** | `telemetry-bridge/test.js` — una métrica `invalid:true` nunca sobreescribe el último valor válido, se anota `ultimo_invalido_en` |
| A7 | Contexto (lat/lng/odómetro/SoC) caducado se presentaba como actual | **IMPLEMENTADO** | `telemetry-bridge/test.js` — dato fresco → `data_quality:'full'`; dato caducado (>maxAgeMs) → `null` explícito + `data_quality:'partial'` |
| A8 | Timestamps: `observado_en_vehiculo` vs `recibido_en_bridge` confundidos | **IMPLEMENTADO** | `telemetry-bridge/test.js` — ambos campos se guardan por separado y nunca se confunden; fallback documentado cuando falta el de Tesla |
| A9 | Health check no distinguía bridge vivo / MQTT vivo / Tesla conectado / métricas reales | **IMPLEMENTADO** | `worker.js` `actualizarHeartbeat`/`obtenerAutomationMode` + tabla `bridge_heartbeats`; `tests/test_fase4a_telemetria_bridge.mjs` ejercita `/internal/health` con señales reales, nunca simuladas |
| A10 | Modo Sombra no forzado realmente por el backend | **IMPLEMENTADO** | `worker.js` `automation_mode` (off/shadow/active) en D1, `GET/POST /automatizacion/modo`; `tests/test_fase4b_viajes.mjs`/`test_fase4c_cargas.mjs` requieren modo activo explícito para procesar; UI real en `index.html`/`app.js` |
| A11 | `ADMIN_TOKEN` permanente expuesto en `/oauth/start?key=...` | **IMPLEMENTADO** | `worker.js` `/oauth/start-token` (token de un solo uso, 120s) + `/oauth/start?token=...`; `tests/test_worker.mjs` cubre sin-token, con-token, reutilización de token (401) |
| A12 | Lock de refresco de token entre isolates (KV get/put no atómico) | **IMPLEMENTADO** | `worker.js` `adquirirLockRefresh`/`liberarLockRefresh` vía D1 (INSERT + robo condicional por expiración); `tests/test_worker.mjs` prueba 2 peticiones concurrentes → 1 solo refresh real |
| A13 | Antireplay HMAC no atómico (KV get/put) | **IMPLEMENTADO** | `worker.js` `verificarFirmaBridge` vía D1 `telemetry_nonces` (INSERT con UNIQUE); `tests/test_fase4a_telemetria_bridge.mjs` prueba nonce nuevo → 200, nonce repetido → 401 |
| A14 | VIN no autorizado explícitamente (se aceptaba por "parecer" un VIN) | **IMPLEMENTADO** | `worker.js` `vinFormatoValido`/`vinAutorizado`/`autorizarVinEnAllowlist`, único punto de alta en `/seleccionar-vehiculo`; `tests/test_fase4a_telemetria_bridge.mjs` prueba VIN mal formado → 400, VIN no autorizado → 403 |
| A15 | `/internal/telemetry` sin validación exhaustiva antes de tocar D1 | **IMPLEMENTADO** | `worker.js` `validarPayloadTelemetria` (tamaño, tipos, rangos, finitud) + `ponerEnCuarentena`; cubierto en `tests/test_fase4a_telemetria_bridge.mjs` |
| A16 | `/callback` sin cabeceras de seguridad ni validación de `FRONTEND_RETURN_URL` | **IMPLEMENTADO** | `worker.js` añade `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, CSP restrictiva, validación de forma de `FRONTEND_RETURN_URL` |
| A17 | Scopes OAuth más amplios de lo necesario | **IMPLEMENTADO** | `OAUTH_SCOPE` reducido a `openid offline_access vehicle_device_data vehicle_location` (quitados `user_data`, `vehicle_charging_cmds`, no usados por el código) |
| A18 | Suite de pruebas no reproducible / rutas absolutas / fallos "conocidos" aceptados | **IMPLEMENTADO** | `package.json` + `package-lock.json` en raíz y en `telemetry-bridge/`, `npm ci` verificado desde cero (ver sección 3); `tests/helpers/browser.js` sin rutas absolutas; `tests/run-all.sh` sin ninguna excepción silenciosa; el bug real de `test_import_sync.js` (mock de GitHub mal formado) corregido, ya no hay "2 fallos conocidos" |
| A19 | Assets estáticos (iconos, Leaflet) nunca verificados con HTTP real | **IMPLEMENTADO** | `tests/test_assets_estaticos.js` (nuevo) — 13 rutas reales servidas por HTTP, todas 200 |
| A20 | `manifest.webmanifest` con `id` absoluto (`/index.html`) incorrecto bajo el despliegue real (`github.io/mitesla/`) + iconos maskable sin verificar | **IMPLEMENTADO** | `id` cambiado a `./index.html` (relativo); safe-zone del icono maskable verificado por medición real de píxeles (radio del glifo 151.8px dentro del radio seguro de 204.8px = 40% de 512px); cubierto también en `tests/test_assets_estaticos.js` |
| A21 | Ciclo de vida del Service Worker sin verificar (install/update/offline/asset ausente/app-shell) | **IMPLEMENTADO** | `tests/test_pwa.js` (install/offline/app-shell, ya existente) + `tests/test_sw_404.js` (asset ausente, ya existente) + `tests/test_sw_actualizacion.js` (**nuevo**, ciclo de actualización real). **Bug nuevo encontrado y corregido durante esta verificación** (ver sección 2) |
| A22 | Imagen Docker de `fleet-telemetry` sin fijar (`:latest`) | **IMPLEMENTADO** (parcial, ver limitación) | `infra/docker-compose.yml` cambiado a `tesla/fleet-telemetry:PIN_MANUAL_REQUERIDO` con instrucción explícita — **no se ha podido verificar en vivo cuál es la versión/digest real más reciente** (ver sección "Bloqueado externamente") |
| A23 | Renovación TLS sin automatización real (deploy hook) | **IMPLEMENTADO** | `infra/certbot-deploy-hook.sh` (nuevo, `bash -n` verificado): copia atómica + `docker compose restart` + comprobación opcional de `/internal/health` |
| A24 | Precio de la Fleet API sin re-verificar contra la documentación vigente | **IMPLEMENTADO** | `INFORME_FASE4_ECONOMICO.md` re-verificado 2026-09-20: **se encontró y corrigió un error real** — el precio de streaming usado (0,0001 $/señal) era ~15x más caro que el precio oficial vigente (0,0000067 $/señal = 1 $ por 150.000 señales), verificado contra `developer.tesla.com/docs/fleet-api/billing-and-limits` + `developer.tesla.com/#usage-based-pricing` y dos fuentes secundarias de contraste el mismo día |
| A25 | Contadores de coste conflacionaban eventos gratuitos con señales de pago | **IMPLEMENTADO** | `worker.js` `actualizarUsageCounters` separa `telemetry_signals_received`/`derived_events`/`vehicle_data_calls`/`wakes`/`commands`; expuesto en `/internal/health`; cubierto en `tests/test_fase4a_telemetria_bridge.mjs` |

**Resumen:** 25/25 IMPLEMENTADO. 0 NO APLICA. 0 PENDIENTE EXTERNO puro — A22 queda parcialmente
bloqueado por falta de acceso en vivo a un registro de imágenes Docker verificable desde este
entorno (ver más abajo), pero el código/infra ya no usa `:latest` y deja instrucción explícita y
verificable de qué hacer.

---

## 2. Bug nuevo encontrado y corregido durante FASE A (fuera de la lista A1–A25 original)

Al escribir la prueba real de A21 (`tests/test_sw_actualizacion.js`) se descubrió que **cualquier
usuario en su primerísima visita sufría una recarga automática de página no solicitada**, causada
por el listener de `controllerchange` en `app.js`: ese evento se dispara también quando
`self.clients.claim()` reclama por primera vez una pestaña sin controlador previo (no solo en
actualizaciones reales), y el código anterior recargaba incondicionalmente. Reproducido con un test
mínimo (`repro_reload.js`, 2 navegaciones tras la primera carga en vez de 1) y corregido en `app.js`
guardando si la pestaña ya tenía un controlador *antes* de registrar el Service Worker, y solo
recargando en ese caso — la misma condición que ya se usaba (correctamente) para decidir si mostrar
la banda "nueva versión". Verificado: tras el fix, la primera visita ya no recarga (`repro_reload.js`
→ 1 navegación) y el ciclo de actualización real sigue funcionando (`test_sw_actualizacion.js`, 5/5
aserciones). Pertenece a FASE A porque se descubrió y se puede resolver dentro del propio A21; no se
ha diferido.

---

## 3. Ficheros modificados o nuevos

### Backend / infraestructura
- `worker.js` — reescritura extensa: A9–A17, A25 (ver checklist); cabecera de rutas actualizada.
- `d1/schema.sql` — nuevas tablas: `telemetry_nonces`, `vehicle_vin_allowlist`, `vehicle_settings`,
  `bridge_heartbeats`, `usage_counters`, `quarantined_events` (+ índice), `oauth_start_tokens`,
  `oauth_refresh_lock`; columna `is_shadow` añadida a `trips`, `charging_sessions`, `pending_actions`.
- `infra/README.md` — A3/A4/A5 (ejemplo de registro corregido), A10 (Modo Sombra real), A23 (deploy
  hook de TLS).
- `infra/docker-compose.yml` — A22 (imagen sin `:latest`, instrucción de pin manual).
- `infra/certbot-deploy-hook.sh` — **nuevo**, A23.

### Bridge de telemetría (`telemetry-bridge/`)
- `lib/normalizador.js` — reescritura completa: A1, A3, A4, A6, A7, A8.
- `lib/cola.js` — reescritura completa: A2.
- `index.js` — adaptado a las nuevas APIs de `normalizador`/`cola` (single-flight, `peekBatch`/`ack`).
- `test.js` — reescrito para probar las nuevas firmas reales (antes probaba una API que ya no existe).
- `package.json` / `package-lock.json` — **nuevo** (`npm ci` reproducible, A18).

### Frontend
- `app.js` — A11 (`connectTesla()` usa el flujo de token de un solo uso), A10 (UI de modo de
  automatización), **fix del bug de recarga en primera visita** (sección 2).
- `index.html` — UI de "Modo de automatización"; CSS del botón activo.
- `manifest.webmanifest` — A20 (`id` relativo).

### Pruebas
- `package.json` / `package-lock.json` (raíz) — **nuevo**, A18.
- `tests/run-all.sh` — reescrito: sin rutas colgadas, sin fallos "conocidos" aceptados, dos tests
  nuevos añadidos a la lista.
- `tests/helpers/browser.js` — **nuevo**, A18 (sin rutas absolutas).
- `tests/helpers/mock_d1.js` — extendido con todas las tablas D1 nuevas y `_autorizarYActivar()`.
- `tests/test_worker.mjs` — adaptado al nuevo flujo de `/oauth/start` (A11); añadidas pruebas de
  token de un solo uso y su no-reutilización.
- `tests/test_fase4a_telemetria_bridge.mjs`, `tests/test_fase4b_viajes.mjs`,
  `tests/test_fase4c_cargas.mjs` — seeding de VIN autorizado + modo activo (A10/A14) en sus casos de
  extremo a extremo.
- `tests/test_import_sync.js` — bug real corregido en el propio mock de la prueba (A18).
- `tests/test_assets_estaticos.js` — **nuevo**, A19/A20.
- `tests/test_sw_actualizacion.js` — **nuevo**, A21.
- Renombrados a `.mjs` (resolución ESM limpia, A18): `test_fase4a_telemetria_bridge`,
  `test_fase4b_viajes`, `test_fase4c_cargas`, `test_fase4d_enriquecimiento`, `test_fase4e_alertas`.

### Documentación
- `INFORME_FASE4_ECONOMICO.md` — A24 (precio de streaming corregido, fuentes documentadas).
- `INFORME_FASE_A.md` — este informe.

## 4. Migraciones D1 requeridas

Todas las tablas/columnas nuevas están en `d1/schema.sql`. Como la infraestructura de Fase 4 nunca
ha llegado a desplegarse contra un D1 real con datos (no hay vehículo ni despliegue en producción
todavía), el `CREATE TABLE`/`ALTER` se ha añadido **directamente** en las sentencias existentes de
`trips`/`charging_sessions`/`pending_actions` (columna `is_shadow`) en vez de como migraciones
`ALTER TABLE` separadas — es seguro porque no hay datos reales que migrar. **Si en el futuro ya
existiera un D1 desplegado con datos, este mismo cambio necesitaría `ALTER TABLE ... ADD COLUMN
is_shadow INTEGER NOT NULL DEFAULT 0` en vez de tocar el `CREATE TABLE` original** — se deja anotado
en el propio `schema.sql`.

## 5. Variables de entorno / configuración

- Sin cambios en las variables ya existentes (`TELEMETRY_BRIDGE_SECRET`, `ADMIN_TOKEN`,
  `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_REDIRECT_URI`, `TESLA_DOMAIN`,
  `TESLA_PUBLIC_KEY_PEM`, `ALLOWED_ORIGIN`).
- **Nueva, opcional, con valor por defecto** (`telemetry-bridge/index.js`): `MAX_CONTEXT_AGE_MS`
  (por defecto 300000 = 5 min) — A7.
- **Nuevas, opcionales** (`infra/certbot-deploy-hook.sh`, A23): `MITESLA_HEALTH_URL`,
  `MITESLA_ADMIN_TOKEN` — si no se configuran, el hook sigue funcionando pero omite la comprobación
  automática de salud tras la renovación (avisa explícitamente, nunca falla en silencio).
- El binding D1 (`env.DB`) pasa de ser opcional a **requerido** para: antireplay HMAC (A13), lock de
  refresco (A12, con fallback a KV si no está configurado), VIN allowlist (A14), automation_mode
  (A10), heartbeat (A9), usage counters (A25), cuarentena (A15), tokens de un solo uso de OAuth
  (A11). Sin `env.DB`, estas rutas devuelven `501 d1_no_configurado` de forma explícita en vez de
  fallar en silencio o degradar la seguridad.

## 6. Resultado completo de la suite de pruebas

Ejecutado desde un checkout limpio (`rm -rf node_modules telemetry-bridge/node_modules`, `npm ci` en
ambos paquetes), 2026-09-20:

```
$ npm ci                    # raíz — reproducible, sin rutas absolutas
$ cd telemetry-bridge && npm ci && cd ..
$ npm run test:all          # tests/run-all.sh + telemetry-bridge/test.js

tests/run-all.sh: 41 scripts — 41 ✅, 0 ❌
TODO OK — 0 fallos, 0 fallos ocultos, 0 excepciones silenciosas.

telemetry-bridge/test.js: 55 aserciones — 55 ✅, 0 ❌
TODO OK — mitesla-telemetry-bridge (lógica pura, sin hardware real)
```

Ningún test está marcado como omitido (`SKIP_DOCUMENTADO` vacío) ni como "fallo conocido aceptado".

## 7. Bloqueado externamente (solo por falta de vehículo real / infraestructura desplegada)

Estos puntos **no** son "pendiente técnico" — el código y las pruebas de lógica pura están
completos — sino que requieren un vehículo Tesla real conectado y/o una VM desplegada en producción
para completarse de verdad:

1. **A9/A10 en producción real**: el heartbeat y el modo de automatización están implementados y
   probados con mocks; falta confirmar con tráfico MQTT real de un vehículo que `last_mqtt_message_at`
   / `last_tesla_message_at` se comportan como se espera bajo condiciones reales (reconexiones de
   red del vehículo, sueño/despertar real, etc.).
2. **A22 (versión/digest de la imagen Docker de `fleet-telemetry`)**: este entorno no tiene acceso a
   Docker Hub/GHCR para consultar en vivo cuál es la etiqueta o el digest más reciente y verificado
   de `teslamotors/fleet-telemetry`. Se ha dejado explícitamente `PIN_MANUAL_REQUERIDO` en vez de
   inventar una versión — el desplegador debe fijar un tag/digest real verificado en el momento del
   despliegue.
3. **A23 (`certbot renew --dry-run` real)**: el script se ha verificado sintácticamente
   (`bash -n`) y su lógica se ha revisado a mano, pero no se ha podido ejecutar un
   `certbot renew --dry-run` real porque no hay una VM con certbot instalado en este entorno.
4. **Coste real de la Fleet API (A24, sección 3 de `INFORME_FASE4_ECONOMICO.md`)**: la estimación de
   ≈0,66 $/mes (corregida) sigue siendo una proyección basada en un patrón de uso típico, no una
   medición — solo se puede confirmar con datos reales de `/internal/health` y del panel de
   facturación de developer.tesla.com tras desplegar con un vehículo.
5. **Prueba de campo del debounce (A1) y de la cola persistente (A2) bajo condiciones reales de
   red intermitente del vehículo** (no solo simuladas): la lógica está probada exhaustivamente de
   forma unitaria, pero el comportamiento bajo la variabilidad real de conectividad de un Tesla
   (reconexiones MQTT, mensajes fuera de orden reales del propio firmware) solo se puede confirmar
   en producción.

Nada de esto bloquea la entrega de FASE A: todo lo que se puede resolver sin un vehículo/despliegue
real está implementado, probado y documentado arriba.
