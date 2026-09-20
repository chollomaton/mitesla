#!/usr/bin/env bash
# Mi Tesla — Fase 4A / A23 (FASE A, auditoría externa 2026-09-20)
# --------------------------------------------------------------
# Deploy hook de certbot: se ejecuta AUTOMÁTICAMENTE cada vez que `certbot renew` renueva de
# verdad el certificado (certbot solo llama a los hooks en RENEW_LOCK, no en cada intento). Antes
# de esta Fase A, el README solo decía "recuerda reiniciar el contenedor a mano tras cada
# renovación" — un recordatorio manual no es una garantía: si se te olvida, fleet-telemetry sigue
# sirviendo el certificado VIEJO hasta que expira, y Tesla dejará de fiarse de él.
#
# Instalación (una vez, en la VM):
#   sudo cp infra/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/mitesla-fleet-telemetry.sh
#   sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/mitesla-fleet-telemetry.sh
#
# certbot invoca este script con la variable de entorno RENEWED_LINEAGE apuntando al directorio
# con los certificados recién renovados — nunca hace falta adivinar la ruta.
#
# Prueba en seco (no renueva nada de verdad, pero SÍ ejecuta este hook si el certificado fuera a
# renovarse): `sudo certbot renew --dry-run`

set -euo pipefail

# Ruta del proyecto en la VM — ajusta si tu checkout vive en otro sitio.
PROYECTO_DIR="${MITESLA_INFRA_DIR:-/opt/mitesla/infra}"
TLS_DIR="$PROYECTO_DIR/tls"
LOG_PREFIX="[certbot-deploy-hook mitesla]"

if [ -z "${RENEWED_LINEAGE:-}" ]; then
  echo "$LOG_PREFIX ERROR: RENEWED_LINEAGE no está definida — este script debe ejecutarlo certbot, no a mano." >&2
  exit 1
fi

echo "$LOG_PREFIX certificado renovado en $RENEWED_LINEAGE — actualizando $TLS_DIR"

mkdir -p "$TLS_DIR"
cp "$RENEWED_LINEAGE/fullchain.pem" "$TLS_DIR/fullchain.pem.new"
cp "$RENEWED_LINEAGE/privkey.pem" "$TLS_DIR/privkey.pem.new"
chmod 644 "$TLS_DIR/fullchain.pem.new"
chmod 600 "$TLS_DIR/privkey.pem.new"
# Renombrado atómico: fleet-telemetry nunca ve un fichero a medio copiar.
mv "$TLS_DIR/fullchain.pem.new" "$TLS_DIR/fullchain.pem"
mv "$TLS_DIR/privkey.pem.new" "$TLS_DIR/privkey.pem"

echo "$LOG_PREFIX certificados actualizados, reiniciando el contenedor fleet-telemetry"
( cd "$PROYECTO_DIR" && docker compose restart fleet-telemetry )

echo "$LOG_PREFIX esperando 5s y comprobando salud del pipeline..."
sleep 5
if command -v curl >/dev/null 2>&1 && [ -n "${MITESLA_HEALTH_URL:-}" ] && [ -n "${MITESLA_ADMIN_TOKEN:-}" ]; then
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $MITESLA_ADMIN_TOKEN" "$MITESLA_HEALTH_URL" || echo "000")
  if [ "$HTTP_CODE" != "200" ]; then
    echo "$LOG_PREFIX AVISO: /internal/health respondió $HTTP_CODE tras el reinicio — revisa los logs de fleet-telemetry a mano (docker compose logs fleet-telemetry)." >&2
  else
    echo "$LOG_PREFIX health check OK ($HTTP_CODE)."
  fi
else
  echo "$LOG_PREFIX (MITESLA_HEALTH_URL/MITESLA_ADMIN_TOKEN no configuradas — se omite el health check automático; verifícalo a mano: docker compose logs -f fleet-telemetry)"
fi

echo "$LOG_PREFIX hecho."
