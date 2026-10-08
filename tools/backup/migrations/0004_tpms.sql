-- B15 (FASE B): presión real de los 4 neumáticos (TPMS, vía Fleet Telemetry: TpmsPressureFl/Fr/Rl/Rr)
-- y el umbral de aviso que el usuario fije para su vehículo. tpms_umbral_bar es NULLABLE a propósito:
-- sin que el usuario lo configure explícitamente, comprobarPresionNeumaticos() nunca avisa — la
-- presión "segura" (placard) depende de la versión/neumático del coche, no hay un valor genérico
-- correcto para todo el mundo (norma de datos inventados).
ALTER TABLE vehicle_snapshots ADD COLUMN tpms_fl_bar REAL;
ALTER TABLE vehicle_snapshots ADD COLUMN tpms_fr_bar REAL;
ALTER TABLE vehicle_snapshots ADD COLUMN tpms_rl_bar REAL;
ALTER TABLE vehicle_snapshots ADD COLUMN tpms_rr_bar REAL;

ALTER TABLE vehicle_settings ADD COLUMN tpms_umbral_bar REAL;
