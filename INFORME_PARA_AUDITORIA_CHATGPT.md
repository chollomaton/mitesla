# Mi Tesla — Informe de traspaso para auditoría (ChatGPT)

Fecha: 2026-09-20. Este documento resume qué se ha hecho en el proyecto "Mi Tesla" (PWA personal de
Carlos García Conde para gestionar su Tesla Model Y), en qué estado queda, y pide una auditoría completa
del resultado. Quien lo lea no tiene el histórico de la conversación — todo lo relevante está aquí.

## 0. Qué es esto

Una PWA estática (vanilla JS, sin build, `app.js` + `index.html` + `sw.js`, desplegada en GitHub Pages)
más un backend en Cloudflare Workers (`worker.js`) que hace de proxy seguro con la Tesla Fleet API. El
proyecto se ha trabajado en 4 fases sucesivas de auditoría/reescritura con IA. Las fases 1-2 se hicieron en
sesiones anteriores (no documentadas en detalle aquí, ver estado abajo); las fases 3 y 4 sí están
documentadas con detalle porque son las que se acaban de cerrar.

## 1. Estado por fase

### Fase 1-2 — Seguridad, correctitud, accesibilidad, UI (parcialmente cerrada)

**Hecho y verificado:**
- Backend (`worker.js`) reescrito: OAuth seguro con Tesla, `client_secret`/`admin_token` nunca en el
  frontend, endpoints protegidos, CORS restringido a orígenes configurados, manejo de errores sin filtrar
  el cuerpo real de las respuestas de Tesla.
- Versionado del modelo de datos y migraciones entre versiones.
- Separación de datos de demostración vs. datos reales; arreglado el merge entre varios dispositivos
  (last-write-wins con IDs únicos, sin duplicar ni perder registros).
- Importación robusta: reintentos ante conflicto 409 de GitHub, saneado de `localStorage` corrupto,
  privacidad del repositorio de sincronización.
- Accesibilidad: modal con `role=dialog` y foco atrapado, toasts, `focus-visible`, `prefers-reduced-motion`,
  navegación con ARIA.
- Formularios y controles semánticos (7 formularios, validación nativa con `novalidate`, envío por Enter y
  clic).
- Service Worker rehecho (estrategias de caché, banda offline, un asset inexistente da 404 real).

**Pendiente, NO cerrado (importante decírselo a la auditoría):**
- Corregir cálculos/fechas/datos inventados restantes — en curso, no completado.
- Privacidad de las coordenadas de "casa" y validación de formularios — pendiente.
- Batería de pruebas exhaustiva y documentación de resultados de esta fase concreta — pendiente.
- Reducir el uso de `innerHTML` con datos no confiables (riesgo de XSS si algún campo de texto libre no
  pasa por `esc()` en algún punto) — pendiente, no auditado a fondo.
- Manifest y CSP — en curso (hay una CSP estricta ya probada en `test_csp.js`, pero la tarea general de
  "Manifest y CSP" sigue marcada como en progreso, no cerrada del todo).
- Rediseño visual premium — pendiente, no abordado.
- Módulo de supuestos centralizado (`ASSUMPTIONS`) — parcialmente existe (usado por la calculadora
  "¿Llego?", ver Fase 3) pero la tarea general de centralizarlo en todo el código sigue pendiente.
- Modularización en ES modules — pendiente; todo el frontend sigue siendo un único `app.js` de ~5.670
  líneas sin módulos.
- Suite de tests automatizados específica de la Fase 2 y auditoría final de regresiones de esa fase —
  pendiente como tarea propia (aunque hay muchos tests que sí cubren funcionalidad de esa fase de forma
  indirecta, ver sección 4).

### Fase 3 — Integración Tesla (Fleet API), UX avanzada (cerrada)

Todo lo siguiente está implementado y probado (32 tests de Fase 1-3 en verde, salvo 2 fallos conocidos y
documentados de `test_import_sync.js`, achacables al mock de ese test, no al código):

1. Adaptador Tesla (mapeo de `vehicle_data`), Dashboard "Ahora" con SoC/autonomía/estado, caché de
   consultas.
2. Modelo de cargas ampliado (AC/DC, red, potencia, origen del coste, carga gratuita = 0 € real y no
   `null`), sincronización de odómetro desde Tesla (nunca reduce, ignora saltos >500 km), multi-vehículo.
3. Tarifas con precio medio ponderado en sesiones que cruzan de tramo horario, pérdidas de carga,
   plantillas de viajes, regla automática de clasificación de viajes (propone, nunca impone).
4. Routing real (OSRM) y planificación de paradas, primitiva de privacidad de rutas (recorta el radio
   configurado alrededor de "casa"), calculadora "¿Llego?" con rango de probabilidad en vez de un único
   valor falso.
5. **Base algorítmica de Fleet Telemetry** (detección de viaje/carga automáticos a partir de muestras),
   arquitectura de Web Push — en ese momento DISEÑADO/PENDIENTE de infraestructura real (la Fase 4 la ha
   desplegado de verdad, ver más abajo).
6. Centro de calidad de datos, analítica de consumo por periodo, detección de anomalías (solo con
   variación real y sostenida, nunca afirma una causa).
7. Historial de neumáticos (archiva el juego anterior, nunca sobrescribe), mantenimiento, documentos
   (metadatos sin el archivo en Base64), informes (laboral y anual, con metodología explicada), Wrapped
   anual ampliado.
8. Búsqueda global, papelera con deshacer (30 días), historial de cambios local, aviso de backup
   desactualizado, primera versión (simple, un blob por dispositivo) de sincronización con Cloudflare D1.

### Fase 4 — Automatización total, coste cero (cerrada, sin validar con el coche real)

Objetivo: que la app detecte y registre viajes/cargas SOLA, a partir de la telemetría real de Tesla, sin
coste recurrente, pidiendo al usuario solo lo que de verdad no se puede saber solo. Implementado en 5
subfases (4A-4E), documentado con detalle en `INFORME_FASE4_FUNCIONAL.md` e `INFORME_FASE4_ECONOMICO.md`
(incluidos en el paquete de esta entrega). Resumen:

- **4A — Infraestructura**: pipeline Tesla → `fleet-telemetry` (oficial, TLS) → Mosquitto (MQTT local) →
  `mitesla-telemetry-bridge` (Node, nuevo) → Worker (`/internal/telemetry`, HMAC + antirreplay) → Cloudflare
  D1 (esquema nuevo en `d1/schema.sql`). `/internal/health` para diagnóstico real.
- **4B — Viajes automáticos**: motor de estados sobre los eventos de telemetría, cierre de viaje en la
  misma petición HTTP que trae el evento de fin (funciona con la PWA cerrada), distancia por delta de
  odómetro real, ubicación por geofence, clasificación por reglas del usuario (o pendiente si no hay una
  respuesta inequívoca).
- **4C — Cargas automáticas**: mismo patrón para cargas, energía real por delta AC/DC, precio por reglas
  (incluye `FREE=0€` real, distinto de "sin dato"), pendiente si no hay precio configurado.
- **4D — Enriquecimiento en background**: geocodificación inversa (Nominatim) y clima histórico
  (Open-Meteo) de viajes ya cerrados, por Cron Trigger, nunca bloqueando el cierre real.
- **4E — Automatizaciones secundarias**: motor de alertas con dedupe/cooldown, monitorización de hueco de
  odómetro y de silencio de telemetría, endpoints `/pendientes` y `/alertas` (listar + resolver), y un
  panel nuevo "Automatización" en Ajustes de la propia PWA (oculto por defecto tras el flag
  `fleet_telemetry`) donde el usuario ve y resuelve lo que el sistema no pudo decidir solo.

**Limitación honesta y explícita**: nada de la Fase 4 se ha probado contra un vehículo Tesla real ni contra
Nominatim/Open-Meteo/Cloudflare reales — el usuario todavía no tiene el coche y la infraestructura (VM,
dominio, TLS, Virtual Key) no está desplegada. Todo está probado con mocks (D1, `fetch`, MQTT). El coste
mensual de Tesla (~7 $/mes estimado, bajo el crédito gratuito de 10 $/mes) es una PROYECCIÓN, no una
medición. `route_simplified` (traza GPS de la ruta) y el cálculo de SoH de batería quedan explícitamente
fuera de esta fase por falta de datos suficientes para hacerlos sin inventar cifras.

**Nota de arquitectura importante para la auditoría**: la Fase 4 usa una base de datos D1 nueva y separada
del modelo de datos histórico de la app (que sigue viviendo en `localStorage`/GitHub, tal y como se
construyó en las Fases 1-3). Los dos almacenes NO están unificados — conviven. Merece la pena que la
auditoría opine sobre si eso es aceptable a medio plazo o si haría falta un plan de unificación.

## 2. Qué pedimos a la auditoría (ChatGPT)

Por favor, haz una **auditoría completa** del proyecto con los archivos adjuntos, cubriendo al menos:

1. **Seguridad**: revisión de `worker.js` (autenticación, CORS, validación de entrada, HMAC del bridge,
   manejo de secretos) y del frontend (posible XSS vía `innerHTML`, fugas de datos sensibles, CSP).
2. **Correctitud funcional**: ¿la lógica de detección de viajes/cargas (`worker.js`, `telemetry-bridge/`)
   hace lo que dice hacer? ¿Hay casos borde no cubiertos por los tests?
3. **Calidad y cobertura de los tests**: ¿los 45+ tests de Fase 3-4 prueban lo que de verdad importa, o
   hay huecos? ¿Los mocks (D1, fetch, MQTT) esconden algún problema que solo aparecería con red real?
4. **Coherencia del informe económico**: revisa `INFORME_FASE4_ECONOMICO.md` — ¿la estimación de coste de
   Tesla es razonable? ¿Falta algo en la tabla de infraestructura gratuita?
5. **Honestidad de las afirmaciones**: contrasta lo que dicen `INFORME_FASE4_FUNCIONAL.md` y este documento
   contra el código real — señala cualquier afirmación que parezca más optimista de lo que el código
   respalda.
6. **Deuda técnica heredada de la Fase 1-2** (sección 1 de este documento): dado que varias tareas quedaron
   abiertas (innerHTML sin sanear del todo, sin modularización, sin rediseño visual, sin suite de tests
   propia de esa fase), valora el riesgo real de dejarlas así frente a seguir avanzando en la Fase 4.
7. Un **veredicto claro**: ¿qué es seguro desplegar tal cual, qué necesita cambios antes de desplegar, y
   qué es directamente arriesgado?

No hace falta que seas indulgente — el objetivo es encontrar problemas reales antes de desplegar nada con
un vehículo de verdad y una cuenta de Tesla con dinero real de por medio.

## 3. Archivos a adjuntar para la auditoría

**Imprescindibles (código):**
- `app.js` (~5.670 líneas — frontend completo)
- `index.html` (~1.400 líneas — estructura + CSS)
- `worker.js` (~1.470 líneas — backend Cloudflare Worker)
- `sw.js` (Service Worker)
- `manifest.webmanifest`
- `d1/schema.sql` (esquema de la base de datos de la Fase 4)
- Toda la carpeta `telemetry-bridge/` (código del puente MQTT→Worker)
- Toda la carpeta `infra/` (Docker Compose, Mosquitto, plantilla de fleet-telemetry, systemd, README con
  los pasos de despliegue)

**Recomendados (para poder evaluar la cobertura de pruebas):**
- Toda la carpeta `tests/` (incluye `README.md` con qué cubre cada test y `mock_d1.js`, el mock de base de
  datos usado en los tests de la Fase 4)

**Los dos informes de la Fase 4:**
- `INFORME_FASE4_FUNCIONAL.md`
- `INFORME_FASE4_ECONOMICO.md`

**Este mismo documento:**
- `INFORME_PARA_AUDITORIA_CHATGPT.md`

Todo junto está en el zip `mitesla-fase4.zip` ya entregado, más este archivo nuevo — si tu herramienta para
subir a ChatGPT tiene límite de archivos, prioriza `app.js`, `worker.js`, `d1/schema.sql`,
`telemetry-bridge/`, los dos informes de Fase 4 y este documento; `tests/` e `infra/` son secundarios si
hace falta recortar.
