// D1 contract backed by real SQLite and the exact deployment migrations.
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),path=require('node:path');
function crearMockD1({authority='CANONICAL'}={}) {
 const sql=new DatabaseSync(':memory:');
 for(const name of fs.readdirSync(path.join(__dirname,'../../d1/migrations')).filter(x=>x.endsWith('.sql')).sort())sql.exec(fs.readFileSync(path.join(__dirname,'../../d1/migrations',name),'utf8'));
 sql.exec('PRAGMA foreign_keys=ON');
 sql.prepare("UPDATE system_state SET value=? WHERE key='data_authority'").run(authority);
 const statement=(query,args=[])=>({bind(...values){return statement(query,values)},async first(column){const row=sql.prepare(query).get(...args);return column?row?.[column]??null:row??null},async all(){return {results:sql.prepare(query).all(...args),success:true}},async run(){const r=sql.prepare(query).run(...args);return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}});
 const now=()=>new Date().toISOString();
 const seed=(table,row)=>{const keys=Object.keys(row);sql.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row))};
 const vehicle=vin=>sql.prepare('INSERT OR IGNORE INTO vehicles(vin,creado_en,actualizado_en) VALUES(?,?,?)').run(vin,now(),now());
 const maps={vehicles:'vehicles',events:'telemetry_events_short_retention',snapshots:'vehicle_snapshots',syncState:'sync_state',locations:'locations',automationRules:'automation_rules',trips:'trips',chargingSessions:'charging_sessions',pendingActions:'pending_actions',alerts:'alerts',telemetryNonces:'telemetry_nonces',vinAllowlist:'vehicle_vin_allowlist',vehicleSettings:'vehicle_settings',bridgeHeartbeats:'bridge_heartbeats',usageCounters:'usage_counters',oauthStartTokens:'oauth_start_tokens',oauthRefreshLock:'oauth_refresh_lock'};
 return {prepare:statement,async exec(query){sql.exec(query)},_sql:sql,
 _sembrarLocation(row){vehicle(row.vin);seed('locations',{name:row.id,created_at:now(),updated_at:now(),...row})},
 _sembrarRegla(row){vehicle(row.vin);seed('automation_rules',{activa:1,veces_usada:0,created_at:now(),updated_at:now(),...row})},
 _sembrarEvento(row){vehicle(row.vin);seed('telemetry_events_short_retention',{recibido_en:now(),...row})},
 _fijarCapacidadVehiculo(vin,kwh){vehicle(vin);sql.prepare('UPDATE vehicles SET capacidad_nominal_kwh=? WHERE vin=?').run(kwh,vin)},
 _autorizarYActivar(vin,modo='active'){vehicle(vin);seed('vehicle_vin_allowlist',{vin,activo:1,creado_en:now()});seed('vehicle_settings',{vin,automation_mode:modo,updated_at:now()})},
 _dump(){const out={};for(const [key,table]of Object.entries(maps)){const rows=sql.prepare('SELECT * FROM '+table).all();out[key]=new Map(rows.map(r=>[r.id??r.vin??r.nonce??r.token,r]))}for(const [key,table]of Object.entries({odometroSnapshots:'odometer_snapshots',bateriaSnapshots:'battery_snapshots',quarantinedEvents:'quarantined_events'}))out[key]=sql.prepare('SELECT * FROM '+table).all();return out}
 };
}
module.exports={crearMockD1};
