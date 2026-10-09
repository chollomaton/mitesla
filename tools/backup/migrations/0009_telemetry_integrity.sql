-- Permanent, secret-free dedupe evidence survives short-retention RAW purges.
CREATE TABLE telemetry_observations (
 dedupe_key TEXT PRIMARY KEY,
 vin TEXT NOT NULL REFERENCES vehicles(vin),
 observed_at TEXT NOT NULL,
 ingested_at TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source='TESLA_TELEMETRY'),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64)
);
CREATE INDEX telemetry_observations_vehicle_time ON telemetry_observations(vin, observed_at);

-- Different event IDs cannot consolidate the same physical opening twice.
-- Existing ambiguous data makes migration fail rather than being silently deleted.
CREATE UNIQUE INDEX trips_telemetry_opening ON trips(vin, started_at) WHERE source='TESLA_TELEMETRY';
CREATE UNIQUE INDEX charges_telemetry_opening ON charging_sessions(vin, started_at) WHERE source='TESLA_TELEMETRY';
