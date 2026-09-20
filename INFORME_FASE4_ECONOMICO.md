# Mi Tesla — Fase 4: Informe económico

**Conclusión short: el objetivo de 0 €/mes se cumple en la infraestructura propia (VM, Worker, D1,
Nominatim, Open-Meteo — todo dentro de capas gratuitas). El único coste que puede aparecer es el de la
Fleet API de Tesla por el propio streaming de telemetría, y la estimación (no medición real — ver
limitación en el punto 3) queda por debajo del crédito mensual de 10 $ para desarrolladores individuales,
por lo que el coste NETO esperado también es 0 €/mes — con margen de seguridad configurado, nunca sin límite.**

## 1. Coste de infraestructura propia

| Componente | Proveedor/Producto | Plan | Límite gratuito | Uso estimado | Margen | Coste previsto |
|---|---|---|---|---|---|---|
| VM (Mosquitto + fleet-telemetry + bridge) | Oracle Cloud Always Free | Ampere A1 (1-4 OCPU/24GB) | Gratis indefinido | 1 VM pequeña, 3 procesos ligeros | Amplio | 0 € |
| Broker MQTT | Mosquitto (self-hosted, OSS) | — | — | Solo tráfico local (loopback) | — | 0 € |
| Servidor de telemetría | `teslamotors/fleet-telemetry` (oficial, OSS) | — | — | 1 vehículo | — | 0 € |
| Backend/API | Cloudflare Workers | Free | 100.000 peticiones/día | Muy por debajo (ingesta+PWA de 1 coche) | Amplio | 0 € |
| Base de datos | Cloudflare D1 | Free | 5 GB, 5M filas leídas/día | Muy por debajo | Amplio | 0 € |
| Cron Trigger (enriquecimiento/alertas) | Cloudflare Workers Cron | Free | Incluido en el plan Free | 1 ejecución/15 min | Amplio | 0 € |
| Geocodificación inversa | Nominatim (OpenStreetMap) | Uso público gratuito | 1 req/s, uso razonable | 8 viajes/pasada, con espera de 1,1 s entre peticiones | Se respeta la política de uso | 0 € |
| Clima histórico | Open-Meteo Archive | Gratuito, sin clave | Uso no comercial razonable | 1 petición por viaje sin clima aún | Amplio | 0 € |
| TLS | Let's Encrypt (certbot) | Gratuito | — | 1 certificado, renovación automática | — | 0 € |
| Frontend | GitHub Pages (ya en uso) | Free | — | Sin cambios | — | 0 € |

**Total infraestructura propia: 0 €/mes**, sin ningún servicio de la lista de bloqueados (sin Kubernetes
gestionado, sin Kafka/Kinesis gestionados, sin Redis gestionado, sin VPS de pago, sin SaaS de pago).

## 2. Coste de la Tesla Fleet API

**A24 (FASE A, re-verificación obligatoria de precios — 2026-09-20):** la tabla de precios de la
versión anterior de este informe (0,0001 $ por señal de streaming) estaba **desactualizada/incorrecta**.
Se ha vuelto a consultar la documentación oficial vigente hoy y el precio real de streaming es **~15
veces más barato** de lo que se venía usando. Se documenta explícitamente la fuente, la fecha de
consulta y la moneda para que esta cifra nunca se vuelva a dar por sentada sin comprobar:

| Campo | Valor |
|---|---|
| Fecha de consulta | 2026-09-20 |
| Fuente primaria | `developer.tesla.com/docs/fleet-api/billing-and-limits` (crédito mensual y límite de gasto por defecto) + `developer.tesla.com/#usage-based-pricing` (tabla de precios por unidad) |
| Fuentes secundarias de contraste (misma cifra, mismo día) | notateslaapp.com "Tesla Announces API Pricing" · teslemetry.com/blog/tesla-fleet-api-pay-per-use |
| Moneda | USD ($) — Tesla Fleet API no factura en EUR; la conversión a €/mes de la sección 5 es orientativa |

| Concepto | Precio unitario vigente (verificado 2026-09-20) | Precio usado en la versión anterior (INCORRECTO) |
|---|---|---|
| Señal de streaming (Fleet Telemetry) | 1 $ por cada 150.000 señales = **0,0000067 $/señal** | ~~0,0001 $~~ (15x más caro que el precio real) |
| Comando de vehículo | 1 $ por cada 1.000 = 0,001 $ | 0,001 $ (correcto, sin cambios) |
| Llamada `vehicle_data` (polling) | 1 $ por cada 500 = 0,002 $ | 0,002 $ (correcto, sin cambios) |
| Despertar el vehículo (`wake_up`) | 1 $ por cada 50 = 0,02 $ | 0,02 $ (correcto, sin cambios) |
| Crédito mensual para desarrolladores individuales/apps pequeñas | 10 $/mes (confirmado textualmente: "A monthly discount of $10 is provided to support individual developers/small applications") | 10 $/mes (correcto, sin cambios) |
| Límite de gasto por defecto (sin método de pago añadido) | 0 $ (confirmado textualmente: "By default, each account has a billing limit of 0") | 0 $ (correcto, sin cambios) |

Solo el precio de streaming estaba mal; los demás ya eran correctos. Como el streaming es, con
diferencia, la partida de mayor volumen de este proyecto (ver tabla de señales abajo), esta corrección
cambia sustancialmente la estimación de coste mensual (sección siguiente) — para mejor: el margen real
hasta el crédito gratuito es mucho más amplio de lo que se había calculado.

### Señales configuradas y frecuencia (ver `infra/README.md`, paso 4)

12 señales: `Soc`, `Odometer` (60s), `Gear`, `DetailedChargeState` (solo al cambiar), `Latitude`,
`Longitude` (30s), `EstBatteryRange`, `OutsideTemp` (300s), `ACChargingEnergyIn`, `DCChargingEnergyIn`,
`ACChargingPower`, `DCChargingPower` (60s, solo relevantes mientras carga).

### Estimación de coste mensual (ver limitación abajo)

Supuesto de uso: coche personal con ~40 min/día conduciendo y ~4 h/día en carga doméstica (streaming
activo solo mientras el vehículo está despierto/conectado — dormido no emite).

| Señal | Eventos/día (estimado) |
|---|---|
| Soc, Odometer (60s x ~280 min activos) | ~280 c/u |
| Latitude, Longitude (30s) | ~560 c/u |
| EstBatteryRange, OutsideTemp (300s) | ~56 c/u |
| Gear, DetailedChargeState (por cambio) | ~14 en total |
| Energía/potencia de carga (60s x ~240 min de carga) | ~240 c/u (4 señales) |
| **Total estimado** | **~2.290 eventos/día ≈ 68.700/mes** |

Coste streaming (precio corregido, ver A24 arriba): 68.700 × 0,0000067 $ ≈ **0,46 $/mes**.
`vehicle_data`/`wake_up`: minimizados a propósito (sección 62 — Fleet Telemetry cubre la mayoría de
necesidades, no se hace polling salvo fallback puntual) — estimado ≤ 0,20 $/mes.
**Total estimado: ≈ 0,66 $/mes**, muy por debajo del crédito de 10 $/mes → **coste neto esperado: 0 €**.
Margen restante hasta el crédito: ≈ 9,34 $/mes (con el precio de streaming corregido, el margen de
seguridad real es mucho mayor de lo que indicaba la versión anterior de este informe).

### 3. Limitación explícita de esta estimación

**Esto es una estimación basada en la documentación oficial y un patrón de uso típico — NO una medición
real.** No hay "eventos recibidos en prueba" que reportar porque el bridge nunca se ha conectado a un
vehículo real (no está desplegado, no hay vehículo físico todavía). El coste real depende de: cuánto
tiempo pasa el coche despierto sin estar ni conduciendo ni cargando (p. ej. si Sentry Mode o el
preacondicionamiento lo mantienen despierto más de lo estimado, el coste sube), y de la frecuencia real de
`vehicle_data`/`wake_up` que acabe haciendo el resto de la app. **Este informe no se puede dar por cerrado
en el sentido estricto de la sección 83 hasta que, tras desplegar el pipeline, se repita esta tabla con
cifras reales de `/internal/health` y del panel de facturación de developer.tesla.com.**

## 4. Salvaguardas obligatorias antes de activar (sección 80-81)

1. En developer.tesla.com → Billing, configurar un límite de gasto explícito (recomendado: 10-15 $/mes,
   nunca "sin límite").
2. Activar las alertas de consumo al 80 % y al 100 % (email; al 100 % Tesla suspende y retira la config
   de telemetría automáticamente — es una red de seguridad real, no solo un aviso).
3. Revisar `/internal/health` semanalmente durante el Modo Sombra para confirmar que el volumen de eventos
   coincide con lo estimado aquí; si es mucho mayor, reducir la frecuencia de las señales menos críticas
   (`Latitude`/`Longitude` a 60s en vez de 30s, por ejemplo) antes de seguir.

## 5. Conclusión

El objetivo de 0 €/mes se cumple en la infraestructura propia con certeza (todo en capas Always
Free/OSS). El coste de Tesla se estima muy por debajo del crédito gratuito mensual (con el precio de
streaming corregido en la revisión A24, el margen es de ≈9,34 $/mes, no ≈2,90 $/mes como decía la
versión anterior de este informe), pero esa cifra sigue siendo una proyección, no una medición — el
informe se completará con datos reales en cuanto el pipeline esté desplegado y funcionando con el
vehículo, tal y como exige la propia especificación de la Fase 4.
