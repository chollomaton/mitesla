#!/usr/bin/env bash
# Ejecuta toda la suite de regresión de Mi Tesla y resume el resultado.
#
# A18 (FASE A, auditoría externa 2026-09-20): reproducible desde un checkout limpio —
#   npm ci
#   npx playwright install --with-deps chromium   # una vez, si no está ya instalado
#   npm test
# Ya no hace falta ejecutarse desde ningún directorio concreto del contenedor original: todas las
# rutas absolutas (/home/claude/mitesla, /opt/pw-browsers/chromium) se han eliminado de los tests
# (ver tests/helpers/browser.js). PLAYWRIGHT_CHROMIUM_PATH sigue siendo opcional, solo para
# entornos con un Chromium preinstalado en una ruta fija (como el contenedor donde se escribió
# esto) — si no se define, Playwright usa el navegador que él mismo instaló.
#
# A18: ya NO existe ningún test con fallos "conocidos y aceptados". Si algo falla, la suite falla
# (exit 1) — no hay excepciones silenciosas. Si algún test debe omitirse deliberadamente, se marca
# con SKIP_DOCUMENTADO más abajo, con el motivo explícito en el propio array (nunca en silencio).
set -u
cd "$(dirname "$0")"

TESTS="test_worker.mjs test_merge.js test_stats_null.js test_carga_null.js test_casa.js \
test_tracking.js test_globales_versionados.js test_reset_ui.js test_mapa_ui.js \
test_smoke_load.js test_nav_mas.js test_a11y_modal.js test_crud_botones.js \
test_forms_semantic.js test_forms_click.js test_ver_buttons.js test_pwa.js test_sw_404.js \
test_csp.js test_llego.js test_clima_error.js test_desktop_nav.js test_contraste.js \
test_auditoria_final.js test_primer_arranque.js test_import_sync.js test_tesla_snapshot.js \
test_sw_actualizacion.js test_assets_estaticos.js test_fase_b_datos_inventados.js \
test_d1_migraciones.js test_papelera_restaurar_multidispositivo.js test_b17_retencion_telemetria.mjs \
test_odometro_carga_fase3.js test_bloque3_tarifa_plantillas.js \
test_bloque4_routing_privacidad.js test_bloque5_telemetria_push.js \
test_bloque6_calidad_analitica.js test_bloque7_historico_informes.js \
test_bloque8_busqueda_papelera_d1.js test_fase4a_telemetria_bridge.mjs \
test_fase4b_viajes.mjs test_fase4c_cargas.mjs test_fase4d_enriquecimiento.mjs test_fase4e_alertas.mjs test_fase4e_ui_automatizacion.js"

# Ningún test está en esta lista a día de hoy (A18) — se deja el mecanismo preparado para que,
# si algún día hiciera falta, la razón quede escrita aquí mismo y no en un comentario aparte.
# Formato: "nombre_del_test.js:motivo explícito y verificable"
SKIP_DOCUMENTADO=()

fallos_totales=0
omitidos=0
for f in $TESTS; do
  motivo_skip=""
  for entrada in "${SKIP_DOCUMENTADO[@]:-}"; do
    [ -z "$entrada" ] && continue
    nombre="${entrada%%:*}"
    if [ "$nombre" = "$f" ]; then motivo_skip="${entrada#*:}"; fi
  done
  if [ -n "$motivo_skip" ]; then
    echo "⏭️  $f -> OMITIDO explícitamente: $motivo_skip"
    omitidos=$((omitidos+1))
    continue
  fi
  out=$(node "$f" 2>&1)
  code=$?
  fallos=$(echo "$out" | grep -c "❌")
  if [ "$code" != "0" ] || [ "$fallos" != "0" ]; then
    echo "❌ $f -> exit=$code fallos=$fallos"
    echo "$out" | tail -30
    fallos_totales=$((fallos_totales+1))
  else
    echo "✅ $f"
  fi
done

echo ""
if [ "$omitidos" != "0" ]; then
  echo "$omitidos test(s) omitido(s) explícitamente (ver SKIP_DOCUMENTADO arriba)."
fi
if [ "$fallos_totales" = "0" ]; then
  echo "TODO OK — 0 fallos, 0 fallos ocultos, 0 excepciones silenciosas."
  exit 0
else
  echo "$fallos_totales script(s) con fallos reales."
  exit 1
fi
