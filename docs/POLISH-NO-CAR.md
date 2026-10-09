# Pulido sin vehículo — 9 de octubre de 2026

La presentación automática conserva navegación inferior en móvil y barra lateral desde 900 px. Ajustes → Tu pantalla → Navegador Tesla selecciona explícitamente la presentación horizontal, con Inicio / Ruta / Carga / Historial / Ajustes. La elección se guarda localmente; no depende del user-agent. Comparte vistas, repositorios y sesión. No duplica datos ni inicia OAuth.

La sesión Mi Tesla mantiene bootstrap autorizado, credencial opaca en sessionStorage y cierre con revocación. Configuración técnica y entrada manual compatible están en Avanzado y diagnóstico. Conectar Tesla permanece deshabilitado hasta una futura entrega que habilite la validación con el vehículo. No se han modificado backend, migraciones, scopes, authority ni datos de negocio.

El inicio y las vistas de viajes/cargas/ruta explican el estado sin vehículo. No se muestran batería/autonomía inventadas; odómetro/coste se muestran desconocidos cuando no existe vehículo ni registros. Los registros manuales existentes se preservan. La falta de internet se anuncia con role=status; operaciones de conexión tienen límite de espera de 15 segundos y mensajes para 401/403/409/429/5xx. No se añaden reintentos de escritura.

Se conservan temas claro/oscuro/automático, foco visible, modal con gestión de foco y reduced motion. Se amplían controles, se limitan formularios en escritorio y se mantiene scroll vertical y safe areas. Sin nuevas dependencias, servicios o recursos de pago.

Verificación: run-all.sh incluye smoke de las tres presentaciones y errores simulados; tests existentes cubren sesión/seguridad, telemetry, schema 0001–0009, Worker y fases 4b/4c. Backup y bridge se ejecutan por separado. Los tests usan datos sintéticos aislados, nunca endpoints Tesla reales.

Límites: Chromium emula tamaños de pantalla; Safari iOS y navegador físico Tesla quedan por validar. El modo coche simplifica el inicio y la navegación, y reutiliza las pantallas funcionales de ruta/carga/historial con controles ampliados. No equivale a una implementación nativa Tesla.

Cuando llegue el vehículo: habilitar la conexión en una entrega revisada → OAuth → vehículo visible → selección → lectura → contraste de datos → observación real. Inicialmente cero comandos.
