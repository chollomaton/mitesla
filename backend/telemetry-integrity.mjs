// Immutable observations, separate from canonical revisions and browser sessions.
export function stableJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJSON(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function fingerprint(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJSON(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function admitObservations(DB, body) {
  const observations = (body.events || []).map(e => ({key:'event:'+e.id, value:{vin:body.vin,tipo:e.tipo,observado_en:e.observado_en,payload:e.payload}}));
  if (body.snapshot) {
    const previous = await DB.prepare('SELECT * FROM vehicle_snapshots WHERE vin=?').bind(body.vin).first();
    if (previous && Date.parse(previous.observado_en) === Date.parse(body.snapshot.observado_en)) {
      for (const [key,value] of Object.entries(body.snapshot)) {
        if (key !== 'observado_en' && key in previous && stableJSON(previous[key]) !== stableJSON(value)) throw Error('observation_conflict');
      }
    }
  }
  if (body.snapshot) observations.push({key:'snapshot:'+body.vin+':'+body.snapshot.observado_en,value:{vin:body.vin,snapshot:body.snapshot}});
  // Preflight complete batches, including conflicting repeated keys within one request.
  const hashes = new Map();
  for (const o of observations) {
    o.hash = await fingerprint(o.value);
    if (o.key.startsWith('event:')) {
      const legacy = await DB.prepare('SELECT vin,tipo,payload,observado_en FROM telemetry_events_short_retention WHERE id=?').bind(o.key.slice(6)).first();
      if (legacy && await fingerprint({vin:legacy.vin,tipo:legacy.tipo,observado_en:new Date(legacy.observado_en).toISOString(),payload:JSON.parse(legacy.payload)}) !== o.hash) throw Error('observation_conflict');
    }
    if (hashes.has(o.key) && hashes.get(o.key) !== o.hash) throw Error('observation_conflict');
    hashes.set(o.key,o.hash);
    const row = await DB.prepare('SELECT fingerprint FROM telemetry_observations WHERE dedupe_key=?').bind(o.key).first();
    if (row && row.fingerprint !== o.hash) throw Error('observation_conflict');
  }
  // PK arbitration plus re-read prevents silent last-write-wins across concurrent isolates.
  for (const o of observations) {
    await DB.prepare('INSERT OR IGNORE INTO telemetry_observations(dedupe_key,vin,observed_at,ingested_at,source,fingerprint) VALUES(?,?,?,?,?,?)')
      .bind(o.key,body.vin,o.value.observado_en ?? body.snapshot.observado_en,new Date().toISOString(),'TESLA_TELEMETRY',o.hash).run();
    const row = await DB.prepare('SELECT fingerprint FROM telemetry_observations WHERE dedupe_key=?').bind(o.key).first();
    if (!row || row.fingerprint !== o.hash) throw Error('observation_conflict');
  }
  // Keep exact retries available to repair a crash after admission but before derived writes.
  return {events:body.events || [],snapshot:body.snapshot};
}
// Canonical confirmed values win. Reprocessing never edits a confirmed historical row.
// manual_override is opaque JSON in this schema: protect the complete row conservatively.
export function reconcileCanonical(current, observation) {
  if (!current) return {status:'create',entity:{...observation,revision:1,deleted_at:null}};
  if (current.deleted_at !== null && current.deleted_at !== undefined) return {status:'tombstone',entity:{...current}};
  if (observation.revision !== undefined && observation.revision === current.revision && stableJSON(observation) !== stableJSON(current)) return {status:'conflict',entity:{...current}};
  return {status:'confirmed',entity:{...current}};
}

export function containsSecretFields(value) {
  const stack=[value];
  while (stack.length) {
    const current=stack.pop();
    if (current === null || typeof current !== 'object') continue;
    for (const [key,item] of Object.entries(current)) {
      if (/^(telemetry_bridge_secret|admin_token|session_token|access_token|refresh_token|token|token_hash|secret|password|private_key|authorization)$/i.test(key)) return true;
      if (item !== null && typeof item === 'object') stack.push(item);
    }
  }
  return false;
}

export function assertUnambiguousLifecycle(events, startType, endType) {
  let opening=null;
  for (const event of events) {
    if (event.tipo === startType) {
      if (opening) throw Error('lifecycle_conflict');
      opening=event;
    } else if (event.tipo === endType && opening) {
      if (Date.parse(event.observado_en) <= Date.parse(opening.observado_en)) throw Error('lifecycle_conflict');
      opening=null;
    }
  }
}
