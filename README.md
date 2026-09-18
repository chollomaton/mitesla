# Mi Tesla

App web personal para gestionar y analizar un Tesla Model Y Premium Dual Motor Long Range (2026): dashboard, cargas, viajes, batería, economía, comparativa frente a gasolina, estadísticas, mapa y más.

Publicada en: **https://chollomaton.github.io/mitesla/**

## Arquitectura

- **Frontend**: un único `index.html` autocontenido (HTML + CSS + JS, sin frameworks), alojado gratis en GitHub Pages. Es una PWA instalable en el iPhone ("Añadir a pantalla de inicio").
- **Datos**: viven en `localStorage` del dispositivo y se sincronizan automáticamente (unos segundos después de cualquier cambio) con `datos.json` en este mismo repositorio, vía la API de GitHub y un token personal (PAT) que el usuario guarda solo en su dispositivo.
- **Backend**: un Cloudflare Worker (`mitesla-backend`, código en `worker.js` — no vive en este repo por seguridad, solo en Cloudflare) que gestiona el OAuth con la Fleet API de Tesla. Es la única pieza que maneja secretos (`client_secret`, `private_key`), para que nunca queden expuestos en el frontend público.
- **Dominio propio**: `laperestronika.com`, gestionado por Cloudflare DNS. El Worker cuelga de `api.laperestronika.com` (uso normal) y también del dominio raíz `laperestronika.com` (necesario porque Tesla exige verificar la clave pública en la raíz del dominio, no en un subdominio).

## Archivos de este repositorio

| Archivo | Para qué |
|---|---|
| `index.html` | La aplicación entera |
| `manifest.webmanifest` | Configuración de la PWA (icono, nombre, colores) |
| `sw.js` | Service worker — cachea la app para carga rápida y uso offline |
| `datos.json` | Copia de seguridad de los datos, sincronizada automáticamente |
| `icon-*.png`, `apple-touch-icon.png` | Iconos de la app |
| `.nojekyll` | Necesario para que GitHub Pages no ignore carpetas que empiezan por punto (como `.well-known`) |

## Conexión con Tesla — piezas externas

No viven en este repo, hay que tenerlas anotadas aparte:

- **developer.tesla.com**: app registrada con el nombre "MiEV" (el nombre no puede contener la palabra "Tesla", lo rechaza). Client ID y Client Secret generados ahí.
- **Cloudflare Worker** `mitesla-backend`: variables de entorno `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_REDIRECT_URI`, `TESLA_DOMAIN`, `TESLA_PUBLIC_KEY_PEM`, `ALLOWED_ORIGIN`. KV namespace `TESLA_TOKENS` para guardar la sesión.
- **Par de claves** (`public-key.pem` / `private-key.pem`): la privada nunca debe subirse a ningún repositorio, solo vive en Cloudflare y en el ordenador del usuario.

## Funcionalidades

Dashboard con estado en vivo (manual, hasta conectar el coche real) · Cargas con filtros por tipo · Viajes con etiquetas (personal/trabajo) y conductor · Batería con comparativa frente a la curva típica de degradación · Economía (Tesla vs. gasolina, tarifa eléctrica por horas, recordatorios de mantenimiento por km, neumáticos por eje, accesorios, seguro) · Estadísticas con récords personales, logros y resumen anual · Mapa con rutas por periodo, cargadores públicos reales (Open Charge Map), círculo de alcance, calculadora "¿Llego?", clima real (Open-Meteo) y favoritos · Comparador de precios de carga (Chargeprice, pendiente de clave de API) · Exportación CSV/JSON · Notificaciones del sistema · Tema claro/oscuro/automático.

## Cómo seguir desarrollando

Este proyecto se ha construido conversando con Claude (Anthropic). Para retomarlo en una sesión nueva, basta con explicar dónde está el repo y pedir que continúe — no hace falta repetir todo este contexto si Claude tiene memoria de conversaciones anteriores con este usuario.
