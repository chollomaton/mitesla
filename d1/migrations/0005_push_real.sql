-- B16 (FASE B): Web Push real — claves VAPID propias, envío real y preferencias de categoría por
-- dispositivo. push_subscriptions ya existía (creada ad-hoc por el propio Worker en /push/suscribir,
-- sesión anterior, "capa base sin envío real"); esta migración la incorpora al esquema versionado
-- y le añade `categorias` (qué categorías de push quiere ESE dispositivo — mismo catálogo que
-- PUSH_CATEGORIAS en app.js — JSON, NULL = todas activas, igual que el valor por defecto del
-- cliente en cargarCategoriasPush()). push_config guarda el ÚNICO par de claves VAPID de esta
-- instalación: no hay claves por vehículo, es una app personal con un solo "servidor de aplicación"
-- ante los servicios de push del navegador (RFC 8292).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  device_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  categorias TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_config (
  id TEXT PRIMARY KEY,
  public_key_b64 TEXT NOT NULL,
  private_key_jwk TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Dedupe de ENVÍO (distinto y complementario al dedupe de CREACIÓN de la alerta que ya hacía
-- generarAlertaSiProcede() desde la Fase 4E): deja constancia de que ya se ha intentado mandar un
-- push por esta alerta, para que un job de envío que se ejecute dos veces sobre la misma fila
-- (p.ej. un Cron Trigger solapado) nunca la mande dos veces.
ALTER TABLE alerts ADD COLUMN push_sent_at TEXT;
-- Categoría normalizada de la alerta (mismo catálogo que PUSH_CATEGORIAS en app.js), para que el
-- envío pueda filtrar por las preferencias de categoría de cada dispositivo suscrito.
ALTER TABLE alerts ADD COLUMN categoria TEXT;
