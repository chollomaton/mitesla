# mitesla-telemetry-bridge

Puente MQTT → Cloudflare Worker para la Fase 4A de Mi Tesla. Ver `../infra/README.md` para la
puesta en marcha completa en la VM (Tesla Developer, DNS, TLS, Docker Compose). Este README es
solo sobre el propio servicio Node.

## Qué hace

1. Se suscribe al broker Mosquitto LOCAL (`mitesla_telemetry/#`) donde el servidor oficial
   `teslamotors/fleet-telemetry` publica un mensaje por cada campo que cambia.
2. Mantiene en memoria el último valor conocido de cada campo del vehículo.
3. Cada `INTERVALO_ENVIO_MS` (30s por defecto): detecta transiciones reales de estado (viaje
   iniciado/terminado, carga iniciada/terminada) con un debounce de `DEBOUNCE_TRANSICION_MS`
   (60s por defecto) para no abrir/cerrar nada por una lectura suelta, construye un snapshot del
   estado actual, y envía todo firmado (HMAC-SHA256) a `WORKER_TELEMETRY_URL`.
4. Si el envío falla, los eventos quedan en una cola persistida en disco
   (`RUTA_COLA_PENDIENTE`) — un reinicio del proceso o de la VM no pierde nada ya recibido.

## Variables de entorno

Ver `.env.example` en `../infra/`. Obligatorias: `TESLA_VIN`, `WORKER_TELEMETRY_URL`,
`TELEMETRY_BRIDGE_SECRET` (debe coincidir exactamente con el secreto configurado en el Worker
vía `wrangler secret put TELEMETRY_BRIDGE_SECRET`).

## Pruebas

```
npm install
node test.js
```

`test.js` prueba toda la lógica pura (parseo de topics, detección de transiciones con debounce,
construcción de snapshot, firma HMAC, reintentos con backoff, persistencia de la cola en disco)
sin abrir ninguna conexión MQTT ni HTTP real. **No hay pruebas end-to-end contra un broker o un
vehículo reales** porque no hay vehículo físico disponible todavía — eso solo puede validarse en
el Modo Sombra descrito en `../infra/README.md`, paso 8.

## Límites conocidos / honestidad (sección 77 de la Fase 4)

- La conexión MQTT/HTTPS real (el propio `index.js`, fuera de las funciones de `lib/`) sigue el
  patrón oficial de la librería `mqtt` y la documentación de `teslamotors/fleet-telemetry`, pero
  no se ha ejecutado nunca contra un broker o un vehículo reales. No se afirma que "ya funcione
  con telemetría real" hasta que el Modo Sombra lo confirme.
- La detección de viaje/carga se basa en `ShiftState`/`DetailedChargeState`. Si Tesla renombra
  estos campos en una versión de firmware futura, el bridge simplemente no detectará nada (nunca
  inventará una transición) — el health-check (`/internal/health`) es la forma de notarlo.
