# BACKUP_BACKEND fase 2 — STOP de reconciliación

Estado: STOPPED_FOR_RECONCILIATION_RISK.

## Entrega requerida

1. Inicio: chollomaton/mitesla, rama backup-backend, HEAD b98912a73618c859ba3847ea79f19472118912ad, árbol limpio. Base frontend fd145309c6745e626ae1d2bac950cfe72e7d1871. Final: misma rama; commit documental posterior identificado en PHASE2-FINAL-GIT.json. No se ha modificado código ni esquema.
2. Fuente canónica localizada: paquete MI-TESLA-AI/source, en referenced-chatgpt-conversation-this-is-an-2/outputs. Los 16 archivos backend/esquema coinciden con kit/SOURCE-PINS.json. Migraciones 0001–0008 coinciden byte a byte con tools/backup/migrations y sus pins. El registro local de cutover de referenced-chatgpt-conversation-this-is-an-19/outputs/PRODUCTION-CUTOVER-REPORT.json identifica la versión final deacebbc-b883-4da1-8c19-ca45130e8bb2 al 100%; su configuración runtime conservada apunta a backend/clean-production-adapter.mjs del mismo paquete. Precisión: deacebbc es version_id; el deployment id que la contiene es 7ceae60d-0481-48ed-b076-7de12bb2c966. No se ha consultado el despliegue actual remoto.

Divergencias: Worker raíz anterior frente al certificado (1222 inserciones, 53 eliminaciones); faltan seis módulos backend en el repo; migraciones de despliegue solo 0001–0002 frente a 0001–0008; faltan autenticación de sesión, autoridad y guardas de escritura certificadas en la implementación del repo. La entrada certificada es el adaptador clean-production, no simplemente worker.js. El adaptador legacy production-adapter importa baseline-g1.json, ausente de source y de ese inventario de pins: no debe incorporarse como entrada activa ni inventarse esa dependencia.

No se mezcló ninguna fuente. Un ensayo desechable usa los siete módulos certificados exactos, las ocho migraciones y un reexport para ejecutar los tests existentes contra ese Worker. Fallan test_worker.mjs (supuestos anteriores de autenticación/OAuth), test_fase4b_viajes.mjs y test_fase4c_cargas.mjs (mock D1 carece de first() sin bind para consultas nuevas de autoridad; no se generan registros). test_d1_migraciones.js pasa contra las ocho migraciones. Estos fallos revelan incompatibilidad del arnés; no demuestran un defecto del backend certificado. El PASS original no certifica ese backend. Según fase A, STOP antes de mezclar ante divergencias no triviales con riesgo.
3. Snapshot D1 remoto: no implementado ni certificado. El snapshot existente usa una transacción SQLite local de lectura. Las lecturas remotas sucesivas no deben presentarse como snapshot; se requiere diseñar y comprobar una captura coherente que respete la allowlist, sin adquirir sesiones sensibles. No se introdujo una garantía remota sin pruebas.
4. Source test D1: no creada; nombre y UUID no aplican.
5. Target test D1: no creada; nombre y UUID no aplican.
6. Migraciones: fixtures locales 8/8 verificados; ensayo local 8/8 PASS; source/target remotos no ejecutados.
7. Export remoto: NO EJECUTADO.
8. Restore remoto: NO EJECUTADO.
9. Equivalencia remota registro a registro: NO EJECUTADA. Equivalencia SQLite local cubierta por suite backup.
10. Tombstone/revision/null/0/false/FK/authority: PASS local; NO EJECUTADO remoto.
11. Exclusión de secretos: PASS local; NO EJECUTADO remoto.
12. Corrupto/incompatible/destino existente: PASS local. Rechazo remoto non-fresh/prod UUID: NO IMPLEMENTADO/NO EJECUTADO. Restore local rechaza rutas remotas, pero eso no equivale a un hard deny remoto por UUID.
13. Tests: suite backup 19/19 PASS; bridge PASS; sintaxis de siete módulos canónicos 7/7 PASS; ensayo de reconciliación 1/4 scripts PASS y 3/4 FAIL, con logs separados. Regresión rama intacta: 46/46 scripts PASS, exit 0, 0 omitidos; resultado en PHASE2-REGRESSION-TESTS.log. Primera ejecución falló en 37 scripts por dependencia Playwright ausente; se instaló la dependencia fijada mediante npm ci --ignore-scripts (0 vulnerabilidades) y se repitió usando Google Chrome local y PLAYWRIGHT_CHROMIUM_PATH, sin cambiar tests ni helper. No hay script lint/build declarado en package.json.
14. Recursos remotos creados/eliminados: 0/0. No se comprobó auth Cloudflare porque el gate A exige detenerse antes de la fase remota. No se solicitó acción manual ni se cambiaron servicios/planes.
15. Producción untouched: cero llamadas a Worker/D1 de producción, cero lecturas remotas y cero mutaciones, authority sin tocar. Solo inspección de fuentes y evidencias locales históricas. No se usaron datos reales en pruebas.
16. Commit documental en backup-backend. Push: NO, condición local+remota PASS no satisfecha. Main sin tocar.
17. Estado final: STOPPED_FOR_RECONCILIATION_RISK.
18. Siguiente paso recomendado: tratar la reconciliación como cambio explícito de backend y arnés. Incorporar la entrada clean-production y sus dependencias exactas; actualizar el arnés con autenticación de sesión, autoridad CANONICAL sintética y consultas/guardas D1 reales; validar esos cambios frente al paquete certificado antes de retomar export/restore remotos. Mantener los ocho pins. No reemplazar simplemente el Worker raíz ni rebajar assertions para obtener PASS.

## Evidencias

PHASE2-SOURCE-PINS.json; PHASE2-PROBE.json; PROBE-test_worker.mjs.log; PROBE-test_fase4b_viajes.mjs.log; PROBE-test_fase4c_cargas.mjs.log; PROBE-test_d1_migraciones.js.log; PHASE2-SYNTAX.json; PHASE2-BACKUP-TESTS.log; PHASE2-BRIDGE-TESTS.log; PHASE2-REGRESSION-TESTS.log; PHASE2-FINAL-GIT.json.
