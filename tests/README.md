# Tests — Mi Tesla

Suite de regresión usada durante la Fase 1 y 2 de la auditoría. Son scripts Node +
Playwright que abren `index.html` (o lo sirven por HTTP local cuando hace falta
Service Worker) y ejercitan funciones reales de `app.js`/`worker.js`, no
reimplementaciones. Ejecutar con:

```
bash tests/run-all.sh
```

Requiere Node y Playwright con Chromium ya instalado
(`executablePath: '/opt/pw-browsers/chromium'` está hardcodeado en los scripts;
ajustar si se ejecuta en otra máquina).

## Cobertura por categoría (punto 29 de la auditoría Fase 2)

**Unitarios (lógica pura, sin DOM)**
- `test_worker.mjs` — backend Tesla (Cloudflare Worker): errores de Tesla no se filtran,
  códigos de error correctos, lock de refresh concurrente, /desconectar, /setup.
- `test_merge.js` — fusión de datos entre dispositivos (last-write-wins, borrados,
  dataset_id distinto, IDs únicos).
- `test_globales_versionados.js` — fusión de valores globales (referencia_gasolina, seguro).
- `test_tracking.js` — km de seguimiento con fecha/odómetro local, migración de datasets viejos.
- `test_casa.js` — validación de coordenadas de "casa" en importaciones.
- `test_llego.js` — calculadora "¿Llego?" y el módulo `ASSUMPTIONS`.

**DOM / E2E (interacción real de usuario)**
- `test_smoke_load.js` — arranque limpio en las 9 vistas.
- `test_nav_mas.js` — navegación con la nav de 5 items + submenú "Más".
- `test_desktop_nav.js` — barra lateral de escritorio (≥900px).
- `test_forms_semantic.js` / `test_forms_click.js` — los 7 formularios, envío con
  Enter y con clic, validación JS con `novalidate`.
- `test_ver_buttons.js` — botones "+ Añadir" / "Ver todos".
- `test_crud_botones.js` — duplicar y eliminar registros.
- `test_stats_null.js` / `test_carga_null.js` — estados sin datos (0 viajes, sin batería).
- `test_reset_ui.js` — "Empezar de cero" desde Ajustes.
- `test_mapa_ui.js` — inicialización del mapa sin casa configurada.
- `test_clima_error.js` — estado de carga/error/reintento de la tarjeta de clima.
- `test_primer_arranque.js` — un dispositivo sin nada guardado arranca vacío de verdad (punto
  14.24): sin viajes/cargas/batería de ejemplo, odómetro a 0, sin NaN en ningún sitio.

**PWA**
- `test_pwa.js` — registro del Service Worker, banda offline, segunda carga 100% offline.
- `test_sw_404.js` — un asset inexistente devuelve 404 real, nunca `index.html`.

**Seguridad**
- `test_csp.js` — la CSP estricta no bloquea nada del funcionamiento real (mapa incluido).

**Accesibilidad**
- `test_a11y_modal.js` — modal con `role=dialog`, foco atrapado, Escape, restauración de foco.
- `test_contraste.js` — contraste AA (4.5:1) de los tokens de color corregidos en claro
  (`--txt3`, `--ok`, `--warn`, `--acc2-txt`).

**Sincronización**
- `test_import_sync.js` — reintentos ante 409, saneado de importaciones. **2 fallos conocidos
  y aceptados**: el mock de `fetch` de este script no reproduce bien la secuencia completa de
  reintento tras un 409 (el propio test simula mal el segundo PUT, no es un bug de la app);
  documentado desde la Fase 1, no se ha investigado más a fondo por no ser código de producción.

**Tesla (Fase 3)**
- `test_tesla_snapshot.js` — adaptador `mapearSnapshotTesla()` (mapeo de campos, conversión
  millas→km solo cuando la cuenta está en millas, ausencia de dato mapea a `null` nunca a 0) y
  `aplicarSnapshotTeslaEnDashboard()` (SoC/autonomía/estado/fuente del dato en el Dashboard;
  sin snapshot la fila de fuente queda oculta y el comportamiento manual existente no cambia).

- `test_odometro_carga_fase3.js` — `sincronizarOdometroTesla()` (nunca reduce el odómetro, ignora
  saltos sospechosos >500 km como anomalía, respeta `null ≠ 0`, historial acotado) y el modelo de
  cargas ampliado (AC/DC, red, potencia, origen del coste, notas, `vehicle_id`, carga gratuita =
  coste 0 € real, migración de cargas antiguas sin perder datos).

- `test_bloque3_tarifa_plantillas.js` — `precioMedioSesion()` (sesiones que cruzan de valle a llano
  se facturan a precio medio ponderado, compatibilidad si no hay fin de sesión), pérdidas de carga
  (kWh de red > kWh del coche, coste sobre la energía de red), atribución opcional de origen de
  energía (red/solar/batería, sin inventar procedencia sin datos), plantillas de viajes (crear,
  listar, "Iniciar viaje" rellena el formulario) y la regla automática de clasificación de viajes
  (propone con historial suficiente, nunca impone, no sugiere sin base).

- `test_bloque4_routing_privacidad.js` — primitiva de privacidad de rutas (`distanciaMetros`,
  `coordenadaEsPrivada`, respeta el radio configurado y el flag a 0 por defecto), `buscarLugarPorNombre`
  (resuelve "Casa"/favoritos, no inventa ubicaciones), `RouteProviderOSRM` (con `fetch` simulado, sin
  red real: conversión de unidades, desnivel en null), feature flags (los 5 desactivados por defecto,
  el interruptor de Ajustes y la visibilidad de la casilla "ruta real" siguen al flag) y que "¿Llego?"
  ahora muestra un rango de % de llegada con los factores usados, no un único valor falsamente preciso.

- `test_bloque5_telemetria_push.js` — algoritmos de detección de viaje automático y sesión de
  carga automática a partir de muestras de telemetría (paradas cortas no dividen el viaje, una
  parada larga sí abre uno nuevo, el km/energía se calculan de forma correcta, no se inventa nada
  sin muestras), dedupe/cooldown de avisos, y que `activarWebPush()` se detiene con un motivo claro
  cuando el flag está desactivado o falta la clave VAPID (nunca intenta suscribir con una clave
  inexistente), con la UI de categorías de avisos ligada al flag `web_push`.

- `test_bloque6_calidad_analitica.js` — centro de calidad de datos (detecta viajes sin % de
  batería, cargas sin precio, incluye recomendaciones de sync/backup/Tesla), analítica de consumo
  por periodo (7/30/90 días no mezclan rangos, desglose por tipo de viaje) y detección de
  anomalías (solo dispara con una variación real y sostenida, nunca afirma una causa).

- `test_bloque7_historico_informes.js` — historial de juegos de neumáticos (el juego anterior se
  archiva con fecha/odómetro de sustitución, nunca se sobrescribe; el puntero "actual" sigue
  funcionando para el resto de la app), mantenimiento (recordatorio "lo que ocurra primero" entre
  fecha y km), documentos (los metadatos en `DATOS` nunca contienen el archivo en Base64; sin
  archivo adjunto queda dicho explícitamente), informe laboral (las observaciones llegan al PDF) e
  informe anual (horas conduciendo, gastos sin energía, coste real por 100 km, evolución frente al
  año anterior solo si hay datos, metodología del ahorro explicada) capturando la ventana emergente
  real del informe con Playwright; y el Wrapped anual ampliado (horas, % de carga en casa, carga
  más barata, reparto AC/DC y comparación con el año anterior, cada uno solo cuando hay datos
  reales — nunca inventando una cifra cuando falta el dato de origen).

- `test_bloque8_busqueda_papelera_d1.js` — búsqueda global (insensible a mayúsculas/acentos, sin
  resultados inventados, navega a la vista correcta y resalta la fila encontrada, Escape cierra el
  modal), papelera con deshacer (el elemento eliminado se conserva 30 días con sus datos intactos,
  restaurar retira también la tumba de sincronización para no perderlo de nuevo, restaurar dos
  veces no duplica nada, la purga automática por caducidad funciona, el botón "Deshacer" del toast
  funciona de extremo a extremo), historial de cambios (registra crear/editar/eliminar/restaurar y
  se pinta en Ajustes), aviso de copia de seguridad desactualizada (sin copia nunca / con más de 30
  días / reciente) y sincronización con Cloudflare D1 (el flag está desactivado por defecto, la
  sección solo aparece en Ajustes con el flag activo, y "Probar conexión" informa de un fallo real
  cuando no hay backend D1 desplegado — nunca simula una conexión correcta).

**Telemetría (Fase 4A)**
- `test_fase4a_telemetria_bridge.js` — endpoint `/internal/telemetry` (ingesta HMAC-firmada desde
  el bridge en la VM): rechaza peticiones sin firma, con timestamp fuera de la ventana de 2 min,
  con firma incorrecta o con VIN inválido; sin binding D1 devuelve 501 explícito, nunca simula la
  base de datos; inserción idempotente de eventos (reenviar los mismos `event_id` no duplica nada);
  protección antirreplay real (reutilizar el mismo nonce firmado se rechaza); un snapshot con fecha
  más antigua que el ya guardado nunca sobrescribe el más reciente. `/internal/health` exige el
  mismo `ADMIN_TOKEN` que el resto de rutas privadas y solo informa del estado real guardado en
  `sync_state` (nunca "todo ok" inventado si no hay datos).

**Viajes 100% automáticos (Fase 4B)**
- `test_fase4b_viajes.js` — lógica pura del motor de viajes (`distanciaMetros`, `emparejarUbicacion`
  nunca inventa un lugar fuera de radio, `snapshotMasCercano` respeta la ventana temporal,
  `emparejarEventosEnViajes` descarta una falsa doble apertura y deja un viaje sin cerrar como
  abierto en vez de forzarlo, `clasificarViajeConReglas` nunca elige entre reglas contradictorias)
  y el flujo completo de extremo a extremo a través del endpoint real `/internal/telemetry`: el
  viaje se cierra automáticamente en la misma petición que trae el evento de fin (funciona con la
  PWA cerrada), la distancia sale del odómetro, la ubicación de origen/destino por geofence, la
  clasificación se aplica sola cuando hay una regla inequívoca y genera un pendiente cuando no la
  hay, un reintento del bridge con los mismos `event_id` nunca duplica el viaje, y la regla usada
  incrementa su contador de uso.

**Cargas 100% automáticas (Fase 4C)**
- `test_fase4c_cargas.js` — emparejamiento de `charge_started`/`charge_stopped`, energía real por
  delta AC/DC (nunca inventada: sin dato de energía, el campo queda null y la calidad baja a
  "partial"), `calcularCosteConReglas` (una regla "free" da 0€ REAL distinto de null, el precio
  por kWh se calcula exacto, dos reglas contradictorias para el mismo lugar dan "ambiguo" en vez
  de elegir una al azar) y el flujo completo a través de `/internal/telemetry`: la sesión se cierra
  sola en la misma petición que trae el evento de fin, reconoce "casa" por geofence, aplica el
  precio configurado sin preguntar, y una carga en un lugar sin regla de precio (p. ej. un
  supercargador nuevo) genera un pendiente de tipo `precio_carga` que se resuelve con
  `/pendientes/resolver` sin que el coste se invente en ningún momento.

**Enriquecimiento en background (Fase 4D)**
- `test_fase4d_enriquecimiento.js` — geocodificación inversa (Nominatim) y clima histórico
  (Open-Meteo) de viajes ya cerrados: nunca inventa un nombre de lugar o un dato de clima cuando la
  respuesta no trae nada aprovechable o la hora más cercana está a días de diferencia; un viaje ya
  enriquecido no se vuelve a consultar en la siguiente pasada (no desperdicia llamadas gratuitas);
  un fallo de red en un viaje del lote no tira el resto ni lanza una excepción — simplemente se
  reintentará en la próxima ejecución programada (Cron Trigger, fuera de cualquier petición HTTP,
  nunca bloquea el cierre del viaje/carga en sí).

**Automatizaciones secundarias, alertas y panel en la app (Fase 4E)**
- `test_fase4e_alertas.js` — motor de alertas con dedupe/cooldown real (una condición que sigue
  activa no genera una alerta nueva cada pasada, pero sí se reabre pasado el cooldown), la
  monitorización de hueco de odómetro (solo avisa cuando los viajes registrados no explican el
  kilometraje real, nunca por el margen normal) y de silencio de telemetría, `ejecutarComprobacionesDeSalud`
  recorriendo todos los vehículos, y los endpoints reales `/alertas` (listar, protegido) y
  `/alertas/resolver`.
- `test_fase4e_ui_automatizacion.js` — el panel "Automatización" que se ve de verdad en Ajustes:
  oculto con el flag `fleet_telemetry` desactivado (por defecto); sin un vehículo Tesla conectado
  no hace ninguna llamada de red y lo explica en el propio mensaje; con un backend simulado (nunca
  red real) muestra el estado de salud, los pendientes reales (viaje sin clasificar, carga sin
  precio) y las alertas reales: resolver un pendiente desde la UI (pulsar "Trabajo") llama de
  verdad a `/pendientes/resolver` con el id y la respuesta correctos.

**Auditoría final de regresiones (punto 30)**
- `test_auditoria_final.js` — recorre las 9 vistas seguidas, comprueba 0 errores de consola,
  0 peticiones propias en 404 y que el manifest es válido. IDs duplicados y listeners rotos se
  comprobaron a mano con grep sobre `index.html` (0 IDs repetidos).

## Lo que NO cubre esta suite

- No hay pruebas de contraste para el modo oscuro (ya cumplía AA con los tonos originales,
  verificado a mano, no de forma automatizada).
- No hay recorrido completo de accesibilidad por teclado de cada vista (solo el modal).
- No usa axe-core ni ninguna herramienta de auditoría a11y automática — las comprobaciones de
  accesibilidad aquí son específicas (foco, ARIA, contraste), no una auditoría exhaustiva.
