-- B9 (FASE B, 2026-09-20): capacidad nominal de la batería del vehículo, necesaria para poder
-- ESTIMAR (nunca inventar) energy_used_kwh de un viaje a partir de la caída de SoC cuando no hay
-- lecturas de EnergyRemaining fiables al inicio y al final (ver construirViajeDesdeEventos en
-- worker.js). Nullable y sin valor por defecto a propósito: sin este dato, la estimación por SoC
-- simplemente no se calcula (null explícito), nunca se asume una capacidad genérica de "75 kWh".
-- Se rellena desde /vehiculo (ver worker.js) cuando el usuario la confirma, igual que hace hoy
-- localStorage en el frontend con DATOS.vehiculo.capacidad_nominal_kwh — este campo es la futura
-- fuente canónica en D1 cuando B1 unifique el almacenamiento; hasta entonces convive con la copia
-- del frontend sin sustituirla.
ALTER TABLE vehicles ADD COLUMN capacidad_nominal_kwh REAL;
