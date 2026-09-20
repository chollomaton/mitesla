# Mi Tesla — Fase 4: Automatización total, coste cero — Informe funcional

Fecha: 2026-09-20 · Estado: implementación y pruebas completas para los 5 subbloques (4A-4E). **Validación
end-to-end con el vehículo físico: PENDIENTE** (el usuario todavía no dispone del coche). Nada de lo que
sigue se presenta como "probado con telemetría real" — donde algo depende del coche, se dice explícitamente.

## 1. Resumen ejecutivo

Se ha construido el backend completo (Worker + D1 + bridge de telemetría) que convierte "Mi Tesla" de una
app de registro manual a un sistema que detecta y cierra viajes y cargas solo, a partir de la telemetría de
Tesla, sin coste recurrente. Todo el código está probado (47/47 tests automatizados en verde, más los 2
fallos conocidos y documentados de `test_import_sync.js`, ajenos a esta fase). Lo que **no** se ha podido
hacer, honestamente, es la validación de extremo a extremo contra un vehículo real — eso requiere el Modo
Sombra descrito en `infra/README.md`, que solo puede completarse cuando el usuario tenga el coche.

## 2. Clasificación de campos por nivel de automatización

| Dato | Nivel | Cómo |
|---|---|---|
| Odómetro | A | Telemetría (`Odometer`), UPSERT en `vehicle_snapshots` + historial en `odometer_snapshots` |
| SoC / autonomía | A | Telemetría (`Soc`, `EstBatteryRange`) |
| Inicio/fin de viaje | A | Detección por `Gear` con debounce (bridge) + cierre automático (Worker) |
| Distancia del viaje | A | Delta de odómetro entre inicio y fin |
| Inicio/fin de carga | A | Detección por `DetailedChargeState` con debounce |
| Energía de carga (kWh) | A | Delta de `ACChargingEnergyIn`/`DCChargingEnergyIn` |
| Ubicación (origen/destino) | B | Geofences configurados por el usuario (`locations`) — sin geofences, queda `null`, nunca inventada |
| Nombre de la calle/ciudad | A (una vez hay lat/lng) | Enriquecimiento en background (Nominatim) |
| Clima del viaje | A (una vez hay lat/lng+fecha) | Enriquecimiento en background (Open-Meteo) |
| Clasificación del viaje (trabajo/personal) | B/C | Regla del usuario si es inequívoca (B); pendiente si no hay regla o hay varias contradictorias (C) |
| Precio de la carga | B/C | Regla de precio del usuario si es inequívoca; `FREE=0€` real si la regla lo dice; pendiente si no hay regla |
| SoH de batería | D (no implementado en Fase 4) | Requeriría capacidad de batería configurada — no se inventa sin ese dato |
| Ruta simplificada (traza GPS) | D (no implementado en Fase 4) | El pipeline actual no persiste la traza continua, solo eventos discretos + inicio/fin |
| Mantenimiento por km/tiempo, TPMS | D (no implementado en Fase 4) | El calendario de mantenimiento sigue viviendo en el modelo de datos de la Fase 1-3 (local/GitHub), no en D1 — no se ha unificado en esta fase |

## 3. Estado de Fleet Telemetry

- Arquitectura: Tesla → `fleet-telemetry` (oficial, TLS) → Mosquitto (MQTT local) → `mitesla-telemetry-bridge`
  (Node) → Worker (`/internal/telemetry`, HMAC+antirreplay) → D1.
- Señales configuradas (12): `Soc`, `Odometer`, `Gear`, `DetailedChargeState`, `Latitude`, `Longitude`,
  `EstBatteryRange`, `OutsideTemp`, `ACChargingEnergyIn`, `DCChargingEnergyIn`, `ACChargingPower`,
  `DCChargingPower`. Nombres de campo verificados contra la documentación oficial vigente
  (`developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data`, 2026-09-20).
- Frecuencia: la mayoría "solo cuando cambia" (`minimum_delta`) o cada 60-300s — nunca polling agresivo.
- Estado real: **DISEÑADO Y CODIFICADO, NO DESPLEGADO** — falta que el usuario provisione la VM, el
  dominio, el certificado TLS y empareje la Virtual Key con el coche (pasos exactos en `infra/README.md`).

## 4. Cómo se detectan/cierran/reconstruyen viajes y cargas

- El bridge mantiene el último valor conocido de cada campo por VIN y, cada 30s, compara con el estado
  del envío anterior: un cambio de `Gear`/`DetailedChargeState` con al menos 60s de estabilidad genera un
  evento discreto (`trip_started`/`trip_finished`/`charge_started`/`charge_stopped`), con id determinista
  (hash de vin+tipo+instante) para que un reintento de red nunca duplique nada.
- El Worker empareja esos eventos cronológicamente (`emparejarEventosEnViajes`/`...EnCargas`), es
  defensivo ante datos imperfectos (doble apertura sin cierre, cierre sin apertura) y cierra el viaje/carga
  **en la misma petición HTTP** que trae el evento de fin — funciona con la PWA cerrada.
- La distancia/energía salen de la diferencia real entre las lecturas de inicio y fin (nunca inventadas).
  Sin datos suficientes, el campo queda `null` y `data_quality` baja a `partial`.
- La ubicación se resuelve por geofence (`locations`); la clasificación/el precio por `automation_rules`,
  con corrección manual del usuario siempre ganadora sobre una reclasificación automática posterior.
- Lo que no se puede decidir solo (sin regla aplicable, o reglas contradictorias) genera un `pending_action`
  — nunca se impone una respuesta al azar. El usuario lo resuelve desde el nuevo panel "Automatización" en
  Ajustes (viaje: Trabajo/Personal/Otro; carga: gratis o € exacto).
- Enriquecimiento (nombre de calle, clima) ocurre después, por Cron Trigger, sin bloquear el cierre.
- Motor de alertas: hueco de odómetro (kilometraje real no explicado por los viajes registrados) y
  silencio de telemetría (>6h sin datos), ambos con dedupe/cooldown para no repetir la misma alerta.

## 5. Modelo de datos, fuentes y overrides

Esquema D1 completo en `d1/schema.sql`: `vehicles`, `vehicle_snapshots` (estado vivo), `telemetry_events_
short_retention` (eventos discretos), `trips`/`charging_sessions` (consolidados, permanentes),
`locations`, `automation_rules`, `pending_actions`, `alerts`, `battery_snapshots`, `odometer_snapshots`,
`sync_state`. Cada fila de `trips`/`charging_sessions` lleva `source`, `data_quality`, y campos de
clasificación/coste con su `_source` — la prioridad `TESLA_TELEMETRY > REGLA_USUARIO > MANUAL` se aplica
tal cual: una corrección manual (`classification_source='manual'`) nunca la pisa un reprocesamiento
posterior de los mismos eventos.

**Nota importante**: esta base D1 (Fase 4) es un almacén NUEVO y SEPARADO del modelo de datos histórico de
la app (Fase 1-3, sincronizado vía GitHub/localStorage, incluida la tabla simple `mitesla_datos` de la
Fase 3 punto 32). **La Fase 4 no migra ni unifica automáticamente los datos históricos** — eso queda
pendiente como trabajo futuro si se decide hacer de D1 el almacén único. Hoy conviven: lo que el usuario ve
en Viajes/Cargas/Economía sigue viniendo del modelo de siempre; lo que detecta la Fase 4 vive en D1 y se
consulta aparte, en el nuevo panel "Automatización" de Ajustes.

## 6. Resultados reales de pruebas

`bash tests/run-all.sh` → 47/47 en verde (más los 2 fallos conocidos y documentados de
`test_import_sync.js`, un artefacto del mock de ese test concreto, no del código). Desglose de la Fase 4:

- `test_fase4a_telemetria_bridge.js` (17 aserciones) — ingesta HMAC, antirreplay, idempotencia, health check.
- `test_fase4b_viajes.js` (36 aserciones) — motor de viajes de extremo a extremo vía `/internal/telemetry`.
- `test_fase4c_cargas.js` (21 aserciones) — motor de cargas, energía real, precio por reglas.
- `test_fase4d_enriquecimiento.js` (17 aserciones) — geocodificación/clima, reintentable, no bloqueante.
- `test_fase4e_alertas.js` (12 aserciones) — motor de alertas, huecos, silencio.
- `test_fase4e_ui_automatizacion.js` (9 aserciones) — el panel real en la PWA, con Playwright.
- `telemetry-bridge/test.js` (24 aserciones) — lógica pura del bridge, sin red real.

Todo probado con datos simulados (mocks de D1, `fetch` y MQTT) — **no** contra Tesla, Nominatim, Open-Meteo
ni Cloudflare reales. Es el máximo nivel de confianza alcanzable sin el vehículo y sin desplegar la
infraestructura de pago-cero descrita en `infra/README.md`.

## 7. Lo que falta para poder decir "funciona de extremo a extremo"

1. El usuario provisiona la VM, el dominio, el TLS y despliega el Worker con el esquema D1 (`infra/README.md`).
2. Empareja la Virtual Key con el coche (requiere el coche delante).
3. Modo Sombra: varios días comparando lo que D1 registra contra lo que el usuario sabe que hizo el coche.
4. Solo entonces tiene sentido activar el panel "Automatización" como fuente de verdad — hasta ese momento,
   la app sigue funcionando exactamente igual que hoy si nada de esto se activa (el flag `fleet_telemetry`
   está desactivado por defecto).

Ver también el informe económico (`INFORME_FASE4_ECONOMICO.md`) para el coste real estimado del pipeline.
