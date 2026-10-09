# Mi Tesla sin coche

La sesión de Mi Tesla es independiente de OAuth Tesla. Ajustes permite crearla mediante el endpoint existente `POST /auth/bootstrap`, con ADMIN_TOKEN usado exclusivamente para el alta. Nunca se guarda ADMIN_TOKEN. El backend genera 32 bytes aleatorios, guarda SHA256 y aplica caducidad de 90 días y revocación. El navegador conserva la sesión exclusivamente en sessionStorage; cerrar sesión llama a `POST /auth/session/revoke`.

Para un alta operativa cuando la clave anterior no se conservó, el operador autenticado en Cloudflare puede rotar ADMIN_TOKEN, llamar al bootstrap normal y entregar solo la sesión al navegador. No insertar sesiones mediante SQL. No usar ADMIN_TOKEN como credencial de las rutas protegidas.

## Gate de promoción sin Tesla

Requiere sesión propia, GET /internal/health y GET /canonical/system/authority = CANONICAL; no requiere OAuth ni /vehicles. Exige baseline exacto, ledger, esquema, FK y comparación de todas las filas de negocio. Aplicar solo 0009, provisionar secreto HMAC independiente, desplegar runtime certificado preservando configuración y secretos OAuth. Pruebas de producción de telemetry: sin firma 401, HMAC incorrecto 401, JSON malformado firmado 400. No enviar un evento válido. La prueba firmada consume un nonce de seguridad; no crea filas de negocio.

## REAL_TESLA_VALIDATION — pendiente hasta recibir el coche

1. Iniciar OAuth con el botón explícito Conectar con Tesla; revisar consentimiento de lectura.
2. Verificar user-context sin revelar credenciales.
3. Consultar /vehicles y comprobar que el vehículo aparece.
4. Seleccionar el vehículo correcto.
5. Consultar vehicle_data en modo lectura.
6. Contrastar ubicación, batería, odómetro y carga con el coche.
7. Guardar una observación real de referencia con fecha, procedencia y valores comprobados.
8. Mantener cero comandos; no habilitar comandos con esta validación.
9. Habilitar funciones de datos reales solo después de validar lo anterior.

No mostrar datos demo como reales. Historial vacío y configuración permanecen disponibles sin vehículo. El arranque consulta únicamente estado local del backend y no obtiene vehicle_data directamente.
