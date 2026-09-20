# Fase 4A — puesta en marcha exacta (infraestructura de telemetría)

Esto es lo único que tienes que hacer tú a mano (no puedo crear cuentas ni provisionar VMs ni
dominios por ti — sección 80 de la Fase 4). Sigue el orden: cada paso depende del anterior.

## 0. Requisito previo

Nada de esto puede probarse de verdad hasta que: (a) tengas el vehículo físico y (b) hayas
completado el emparejamiento de la Virtual Key. Hasta entonces, todo lo de aquí queda en estado
**DISEÑADO/PENDIENTE DE VALIDAR**, nunca "ya funciona" — así se reflejará en el informe final.

## 1. VM Always Free

**Recomendado: Oracle Cloud "Always Free"** (1-4 OCPU ARM Ampere A1 + 24 GB RAM, gratis para
siempre, sin caducidad — a diferencia de Google Cloud Free Tier, que sí tiene límites de horas/mes
en algunos recursos). Alternativa si Oracle no admite tu cuenta: Google Cloud Free Tier
(e2-micro, siempre que te mantengas en su región/límite gratuitos).

1. Crea la cuenta y solicita una instancia "Always Free" (Ampere A1, Ubuntu 22.04 o 24.04).
2. Anota su IP pública fija.
3. Instala Docker y Docker Compose (`curl -fsSL https://get.docker.com | sh`).
4. Abre en el firewall de la VM (y en el "Security List"/"Network Security Group" del proveedor)
   únicamente el puerto **443/tcp** hacia el mundo. El 1883 (MQTT) nunca debe salir a Internet.

## 2. DNS

Necesitas un dominio o subdominio que apunte a la IP de la VM, p.ej. `telemetry.tudominio.com`.
Crea un registro `A` (o `AAAA` si IPv6) en tu proveedor de DNS apuntando a esa IP. Este dominio
es DISTINTO del que ya usas para el Worker (`api.tudominio.com`) y del de GitHub Pages.

## 3. Certificado TLS

```
sudo apt install certbot
sudo certbot certonly --standalone -d telemetry.tudominio.com
```

Copia `fullchain.pem` y `privkey.pem` de `/etc/letsencrypt/live/telemetry.tudominio.com/` a
`infra/tls/` en la VM. Certbot los renueva solo cada ~60 días (`certbot renew` vía cron/systemd
timer, ya viene instalado por el paquete).

**A23 (FASE A, auditoría externa 2026-09-20)**: "recuerda reiniciar el contenedor a mano" no es
una garantía — si se te olvida, fleet-telemetry sigue sirviendo el certificado caducado hasta que
Tesla deja de fiarse de él. Instala el hook automático (`infra/certbot-deploy-hook.sh`), que
certbot ejecuta él solo cada vez que renueva de verdad:
```
sudo cp infra/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/mitesla-fleet-telemetry.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/mitesla-fleet-telemetry.sh
# Opcional, para que el hook compruebe /internal/health tras reiniciar:
export MITESLA_HEALTH_URL="https://api.tudominio.com/internal/health?vin=<TU_VIN>"
export MITESLA_ADMIN_TOKEN="<tu ADMIN_TOKEN>"
```
El hook copia los certificados renovados de forma atómica, reinicia `fleet-telemetry` y comprueba
la salud del pipeline. Pruébalo sin esperar 60 días con `sudo certbot renew --dry-run` (certbot
ejecuta los hooks de "deploy" también en el dry-run si el certificado fuera a renovarse).

## 4. Tesla Developer — Virtual Key y registro de telemetría

1. En [developer.tesla.com](https://developer.tesla.com), en tu app ya existente (la que usa el
   Worker para el Fleet API), añade el campo de configuración de telemetría apuntando a
   `https://telemetry.tudominio.com` (el dominio del paso 2, con el puerto 443 servido por
   fleet-telemetry, TLS del paso 3).
2. Sirve la clave pública ya existente en
   `https://tudominio.com/.well-known/appspecific/com.tesla.3p.public-key.pem` (esto ya lo hace
   el Worker desde fases anteriores — no toques `public-key.pem`/`private-key.pem`).
3. Empareja la Virtual Key con el vehículo: abre en el navegador del teléfono con la app Tesla
   instalada `https://tesla.com/_ak/tudominio.com` y confirma el emparejamiento desde el propio
   coche (pantalla central → llave nueva). **Esto solo puede hacerse con el coche delante.**
4. Configura el Vehicle Command Proxy si tu app Fleet API todavía no lo tiene (necesario para
   comandos firmados; la lectura de telemetría en sí no lo requiere, pero secciones futuras de la
   Fase 4 sí lo usarán). Instrucciones oficiales: `developer.tesla.com/docs/fleet-api/virtual-keys`.
5. Registra la configuración de streaming para tu VIN llamando al endpoint
   `POST /api/1/vehicles/fleet_telemetry_config` de la Fleet API con un cuerpo como:
   ```json
   {
     "vins": ["<TU_VIN>"],
     "config": {
       "hostname": "telemetry.tudominio.com",
       "port": 443,
       "ca": "<contenido de fullchain.pem>",
       "fields": {
         "Soc": { "interval_seconds": 60 },
         "EnergyRemaining": { "interval_seconds": 60 },
         "Odometer": { "interval_seconds": 60 },
         "Gear": { "interval_seconds": 0 },
         "DetailedChargeState": { "interval_seconds": 0 },
         "Location": { "interval_seconds": 30, "minimum_delta": 15 },
         "EstBatteryRange": { "interval_seconds": 300 },
         "OutsideTemp": { "interval_seconds": 300 },
         "ACChargingEnergyIn": { "interval_seconds": 60 },
         "DCChargingEnergyIn": { "interval_seconds": 60 },
         "ACChargingPower": { "interval_seconds": 60 },
         "DCChargingPower": { "interval_seconds": 60 }
       }
     }
   }
   ```
   **A5 (FASE A, auditoría externa 2026-09-20) — corrección importante**: la versión anterior de
   este ejemplo ponía `minimum_delta` en `Gear`/`DetailedChargeState`. Son campos de tipo
   enum/string (no numéricos) — `minimum_delta` es un umbral NUMÉRICO ("solo avisa si el valor
   cambia al menos esto") y no tiene sentido para un enum; la documentación oficial de Tesla lo
   documenta solo para campos numéricos. Para un campo de estado, `interval_seconds: 0` por sí
   solo ya significa "avísame en cada cambio de valor" — es lo correcto para `Gear`/
   `DetailedChargeState`. Revisa siempre la versión de fleet-telemetry realmente instalada
   (`docker compose exec fleet-telemetry ./fleet-telemetry -version` o el tag de la imagen, ver
   punto A22 más abajo) contra `developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data`
   antes de registrar la configuración — los campos soportados cambian entre versiones.
   **A4 — Location**: las versiones actuales de Fleet Telemetry documentan un único campo
   `Location` (con latitud/longitud juntas) en vez de `Latitude`/`Longitude` sueltos —
   `telemetry-bridge/lib/normalizador.js` ya sabe descomponerlo. Si tu versión instalada todavía
   solo soporta `Latitude`/`Longitude` por separado, sustitúyelos aquí (el bridge también los
   soporta, ver el mismo fichero) y compruébalo contra la documentación de tu versión exacta.
   Verifica el `synced: true` de la respuesta antes de dar esto por hecho — nunca asumas que se
   aplicó. Las 4 señales de energía solo son relevantes mientras el coche está cargando — su coste
   real depende de cuántos eventos emitan durante la carga, detallado en el informe económico.
   **A3 — unidades**: `Odometer` viene en MILLAS y una futura señal `VehicleSpeed` vendría en mph
   — el bridge las convierte a km/km-h en la frontera (`normalizarUnidad()`), nunca más abajo.
6. **Antes de activar nada de esto de verdad**: entra en developer.tesla.com → Billing y configura
   un límite de gasto explícito (nunca lo dejes en "sin límite") y activa las alertas al 80%/100%.
   Con la config de arriba (8 señales, la mayoría "solo cuando cambia" o cada 60-300s) el consumo
   estimado se detalla en el informe económico final de la Fase 4 — no actives hasta haberlo visto.

## 5. Cloudflare — D1 y secretos del Worker

```
wrangler d1 create mitesla-datos          # si no lo hiciste ya en la Fase 3
wrangler d1 migrations apply mitesla-datos --remote   # B18 (FASE B): migraciones versionadas en d1/migrations/, no d1/schema.sql
wrangler secret put TELEMETRY_BRIDGE_SECRET   # genera uno con: openssl rand -hex 32
wrangler deploy
```

**B18 (FASE B):** el esquema ya no se despliega ejecutando `d1/schema.sql` a mano — se aplica con
`wrangler d1 migrations apply`, que lee los ficheros numerados de `d1/migrations/` (hoy solo
`0001_initial.sql`) y lleva la cuenta de cuáles ya se aplicaron en una tabla `d1_migrations` que
gestiona el propio wrangler. Cualquier cambio de esquema futuro (incluido el resto de la propia
FASE B) se añade como un fichero nuevo `0002_*.sql`, nunca editando `0001_initial.sql` ni
`d1/schema.sql` directamente — este último se mantiene solo como referencia legible de "todo el
esquema en un único fichero".

El binding `[[d1_databases]]` con `binding = "DB"` ya debe existir en `wrangler.toml` desde la
Fase 3. `TELEMETRY_BRIDGE_SECRET` debe ser EXACTAMENTE el mismo valor que pongas en el `.env` del
bridge (paso 6) — es el secreto compartido de la firma HMAC, nunca viaja por la URL ni por logs.

## 6. Arrancar el pipeline en la VM

```
cd infra/
cp .env.example .env                                  # rellenar TESLA_VIN, WORKER_TELEMETRY_URL, TELEMETRY_BRIDGE_SECRET
cp fleet-telemetry.config.json.template fleet-telemetry.config.json   # rellenar y revisar
mkdir -p tls && cp /etc/letsencrypt/live/telemetry.tudominio.com/*.pem tls/
docker compose up -d
docker compose logs -f telemetry-bridge   # deberías ver "conectado a Mosquitto, suscribiendo a..."
```

## 7. Comprobar que de verdad llega algo

```
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  "https://api.tudominio.com/internal/health?vin=<TU_VIN>"
```

Con el coche encendido/moviéndose, `sync_state.eventos_recibidos_mes` debe subir y
`minutos_desde_ultimo_evento` debe ser bajo. Si `posible_problema: true` (más de 6h sin nada),
revisa en este orden: logs del bridge → logs de fleet-telemetry → estado del emparejamiento de la
Virtual Key → certificado TLS no caducado.

## 8. Cron Trigger — enriquecimiento en background (Fase 4D)

El Worker tiene un handler `scheduled()` que geocodifica origen/destino y añade el clima histórico
de los viajes ya cerrados (Nominatim + Open-Meteo, ambos gratuitos, sin clave de API). Para que se
ejecute solo, añade esto a tu `wrangler.toml` (si no lo tienes, créalo en la raíz del Worker):

```toml
[triggers]
crons = ["*/15 * * * *"]   # cada 15 minutos — de sobra para un único vehículo, respeta el límite
                            # de 1 petición/segundo de la política de uso de Nominatim (lotes de 8)
```

```
wrangler deploy
```

Sin esto configurado, el Worker sigue funcionando exactamente igual para todo lo demás — el
enriquecimiento simplemente no se dispara nunca (nunca bloquea el cierre real de un viaje/carga,
que ya ocurre de forma síncrona en `/internal/telemetry`, sin depender de esto).

## 9. Modo Sombra (obligatorio antes de fiarte de esto)

**A10 (FASE A, auditoría externa 2026-09-20)**: Shadow Mode ya no es solo un flag de frontend —
es un modo real (`off` / `shadow` / `active`) que vive en el backend (`vehicle_settings` en D1) y
que decide si el motor de viajes/cargas procesa algo. Un vehículo recién dado de alta empieza
SIEMPRE en `off` (ningún viaje/carga se crea, ni siquiera de prueba) hasta que tú lo cambies.

1. Con el pipeline ya arrancado (§6) y el VIN autorizado (se hace solo al elegir el vehículo en
   Ajustes → Conexión Tesla — ver A14), abre Ajustes → Automatización en la PWA y pulsa **Shadow**.
2. Deja el pipeline corriendo varios días en Shadow. En este modo SÍ se crean viajes/cargas en D1,
   pero marcados `is_shadow=1`: nunca generan pendientes que tengas que resolver, nunca deberían
   (en una futura unificación de datos, Fase B) tocar Economía/Estadísticas.
3. Compara a mano: lo que `trips`/`charging_sessions` (con `is_shadow=1`) registran vs. lo que
   sabes que hizo el coche de verdad. También puedes consultar `/internal/health?vin=...` para ver
   `heartbeat` (última señal de bridge/MQTT/Tesla por separado, ver A9) y `usage_counters`.
4. Solo cuando coincidan de forma consistente, pulsa **Active** en el mismo panel — a partir de
   ahí los viajes/cargas detectados se guardan como reales (`is_shadow=0`).
