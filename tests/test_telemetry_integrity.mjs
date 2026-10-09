import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac,randomUUID} from 'node:crypto';
import worker,{enriquecerViajesPendientes,construirViajeDesdeEventos,construirCargaDesdeEventos} from '../worker.js';
import {crearMockD1} from './helpers/sqlite_d1.js';
import {reconcileCanonical,fingerprint} from '../backend/telemetry-integrity.mjs';
let checks=0;
function check(actual,expected,label){assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(expected)),label);console.log('PASS '+label);checks++}
const vin='5YJYGDEE1MF000001', secret='synthetic-test-only';
const DB=crearMockD1(); DB._autorizarYActivar(vin);
const env={DB,TELEMETRY_BRIDGE_SECRET:secret};
function request(body,{key=secret,nonce=randomUUID(),signed=true}={}){
 const text=typeof body==='string'?body:JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000));
 return new Request('https://synthetic.invalid/internal/telemetry',{method:'POST',headers:signed?{'X-Timestamp':timestamp,'X-Nonce':nonce,'X-Signature':createHmac('sha256',key).update(timestamp+'.'+nonce+'.'+text).digest('hex')}:{},body:text});
}
const call=(body,opts)=>worker.fetch(request(body,opts),env);
const empty={vin,events:[]};
for(const val of [undefined,'','   ']){env.TELEMETRY_BRIDGE_SECRET=val;check((await call(empty,{signed:false})).status,503,'empty secret bypass closed '+JSON.stringify(val))}
env.TELEMETRY_BRIDGE_SECRET=secret;
check((await call(empty,{signed:false})).status,401,'missing headers');
check((await call(empty,{key:'wrong'})).status,401,'wrong secret');
check((await call(empty)).status,200,'correct secret');
check((await call('{')).status,400,'malformed JSON');
check((await call({vin,events:[{id:'bad',tipo:'trip_started',observado_en:'invalid',payload:{}}]})).status,400,'malformed observation');
check((await call({vin:'5YJYGDEE1MF000002',events:[]})).status,403,'non allowlisted vehicle');
let replay=request(empty);check((await worker.fetch(replay.clone(),env)).status,200,'fresh nonce');check((await worker.fetch(replay,env)).status,401,'nonce replay');
const ev=(id,tipo,time,payload={})=>({id,tipo,observado_en:'2026-10-08T'+time+':00.000Z',payload});
check((await call({vin,events:[ev('secret-field','test','09:00',{secret:'synthetic-sensitive'})]})).status,400,'secret field rejected');
check(DB._sql.prepare("SELECT COUNT(*) n FROM quarantined_events WHERE payload_recortado LIKE '%synthetic-sensitive%'").get().n,0,'secret payload never quarantined');
const event=ev('event-1','test','10:00',{nil:null,zero:0,flag:false});
check((await call({vin,events:[event]})).status,200,'new event');
for(let i=0;i<3;i++)check((await call({vin,events:[event]})).status,200,'exact duplicate retry '+i);
check(DB._sql.prepare("SELECT COUNT(*) n FROM telemetry_events_short_retention WHERE id='event-1'").get().n,1,'zero duplicate events');
check(JSON.parse(DB._sql.prepare("SELECT payload FROM telemetry_events_short_retention WHERE id='event-1'").get().payload),{nil:null,zero:0,flag:false},'null zero false preserved');
check((await call({vin,events:[{...event,payload:{zero:1}}]})).status,409,'dedupe conflict');
const snap=time=>({vin,snapshot:{observado_en:'2026-10-08T'+time+':00Z',soc_pct:0,odometro_km:0}});
check((await call(snap('12:00'))).status,200,'new snapshot');check((await call(snap('11:00'))).status,200,'older observation accepted without regression');
check(DB._sql.prepare('SELECT observado_en FROM vehicle_snapshots').get().observado_en,'2026-10-08T12:00:00.000Z','out of order live state protected');
check((await call({...snap('12:00'),snapshot:{...snap('12:00').snapshot,soc_pct:1}})).status,409,'equal timestamp conflicting content');
check((await call(snap('13:00'))).status,200,'newer observation');
check(await fingerprint({a:0,b:false,c:null}),await fingerprint({c:null,b:false,a:0}),'deterministic fingerprint');
const canonical={id:'x',revision:8,deleted_at:null,manual_override:{distance_km:0,flag:false},distance_km:0,note:null};
check(reconcileCanonical(canonical,{revision:7,distance_km:100}).entity,canonical,'revision cannot decrease and manual correction preserved');
check(reconcileCanonical(canonical,canonical).status,'confirmed','same revision same content');
check(reconcileCanonical(canonical,{...canonical,distance_km:1}).status,'conflict','same revision different content');
check(reconcileCanonical({...canonical,deleted_at:'t'},{}).status,'tombstone','tombstone blocks resurrection');
for(const [kind,table,startType,endType] of [['trip','trips','trip_started','trip_finished'],['charge','charging_sessions','charge_started','charge_stopped']]){
 const start=ev(kind+'-s',startType,'14:00',{odometro_km:100,soc_pct:50}),end=ev(kind+'-e',endType,'14:30',{odometro_km:110,soc_pct:60,ac_energy_kwh:5});
 check((await call({vin,events:[start]})).status,200,kind+' start persisted');
 check(DB._sql.prepare('SELECT COUNT(*) n FROM '+table).get().n,0,kind+' active creates no history');
 // Simulated isolate restart: a new Worker request uses only persistent SQLite events.
 const original=DB.prepare;let crash=true;
 DB.prepare=function(query){const statement=original(query);if(query.startsWith('UPDATE telemetry_events_short_retention') && crash){return {bind(){return {async run(){crash=false;throw Error('synthetic crash after canonical insert')}}}}}return statement};
 check((await call({vin,events:[end]})).status,502,kind+' interrupted closure is explicit retry');DB.prepare=original;
 check((await call({vin,events:[end]})).status,200,kind+' recovery');
 check((await call({vin,events:[start,end]})).status,200,kind+' double retry');
 const row=DB._sql.prepare('SELECT * FROM '+table).get();
 check([row.started_at,row.ended_at,row.duration_min,row.revision],['2026-10-08T14:00:00.000Z','2026-10-08T14:30:00.000Z',30,1],kind+' golden closure');
 check(DB._sql.prepare('SELECT COUNT(*) n FROM '+table).get().n,1,kind+' no duplicate consolidated session');
 DB._sql.prepare('UPDATE '+table+' SET manual_override=?,revision=9').run('{"zero":0,"flag":false,"nil":null}');
 DB._sql.prepare('UPDATE telemetry_events_short_retention SET procesado_en=NULL WHERE id IN (?,?)').run(start.id,end.id);
 await call({vin,events:[start,end]});
 check(DB._sql.prepare('SELECT revision,manual_override FROM '+table).get(),{revision:9,manual_override:'{"zero":0,"flag":false,"nil":null}'},kind+' reprocessing protects manual correction');
 DB._sql.prepare('UPDATE '+table+' SET deleted_at=?,revision=10').run('2026-10-08T15:00:00Z');
 DB._sql.prepare('DELETE FROM telemetry_events_short_retention WHERE id IN (?,?)').run(start.id,end.id);
 check((await call({vin,events:[start,end]})).status,200,kind+' replay after RAW purge');
 check(DB._sql.prepare('SELECT revision,deleted_at FROM '+table).get(),{revision:10,deleted_at:'2026-10-08T15:00:00Z'},kind+' cannot resurrect tombstone');
 check((await call({vin,events:[{...end,payload:{soc_pct:1}}]})).status,409,kind+' retained fingerprint detects conflict after purge');
 check((await call({vin,events:[{...start,id:start.id+'-resurrection'},{...end,id:end.id+'-resurrection'}]})).status,409,kind+' alternate identity cannot resurrect deleted history');
 // Resolve only this deliberately poisoned synthetic fixture before the next independent case.
 DB._sql.prepare('DELETE FROM telemetry_events_short_retention WHERE id IN (?,?)').run(start.id+'-resurrection',end.id+'-resurrection');
}
// New isolate and fault injection at admission/start boundaries, using real SQLite.
for (const [kind,table,startType,endType] of [['trip','trips','trip_started','trip_finished'],['charge','charging_sessions','charge_started','charge_stopped']]) {
 const local=crearMockD1();local._autorizarYActivar(vin);const context={DB:local,TELEMETRY_BRIDGE_SECRET:secret};
 const start=ev(kind+'-late-s',startType,'16:00',{odometro_km:0,soc_pct:0}),end=ev(kind+'-late-e',endType,'16:30',{odometro_km:10,soc_pct:10,ac_energy_kwh:0});
 const send=body=>worker.fetch(request({vin,events:body}),context);
 const original=local.prepare;let fault=true;
 local.prepare=function(query){const st=original(query);if(query.startsWith('INSERT OR IGNORE INTO telemetry_events_short_retention') && fault)return {bind(){return {async run(){fault=false;throw Error('synthetic crash before RAW start')}}}};return st};
 check((await send([start])).status,502,kind+' crash before start RAW persistence');local.prepare=original;
 check(local._sql.prepare('SELECT COUNT(*) n FROM '+table).get().n,0,kind+' crash creates no premature history');
 check((await send([end])).status,200,kind+' end arrives before start retry');
 check((await send([start])).status,200,kind+' recovered start closes out of order');
 check(local._sql.prepare('SELECT COUNT(*) n FROM '+table).get().n,1,kind+' recovered exactly one history');
 check((await send([{...start,id:start.id+'-different'},{...end,id:end.id+'-different'}])).status,409,kind+' alternate IDs same opening explicit conflict');
 check(local._sql.prepare('SELECT COUNT(*) n FROM '+table).get().n,1,kind+' alternate IDs cannot duplicate history');
}
const concurrent=ev('concurrent','test','18:00',{value:0});
const statuses=await Promise.all([call({vin,events:[concurrent]}),call({vin,events:[{...concurrent,payload:{value:1}}]})]);
check(statuses.map(r=>r.status).sort(),[200,409],'concurrent conflicting ID arbitrated atomically');
check(DB._sql.prepare("SELECT COUNT(*) n FROM telemetry_events_short_retention WHERE id='concurrent'").get().n,1,'concurrent conflict leaves one RAW row');
for (const [kind,startType] of [['trip','trip_started'],['charge','charge_started']]) {
 const db=crearMockD1();db._autorizarYActivar(vin);const context={DB:db,TELEMETRY_BRIDGE_SECRET:secret};
 check((await worker.fetch(request({vin,events:[ev(kind+'-a',startType,'20:00'),ev(kind+'-b',startType,'20:10')]}),context)).status,409,kind+' ambiguous double opening fails explicitly');
}
const enrichDB=crearMockD1();enrichDB._autorizarYActivar(vin);
enrichDB._sql.prepare('INSERT INTO trips(id,vin,started_at,source,start_lat,start_lng,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('enrich-race',vin,'2026-10-08T10:00:00Z','TESLA_TELEMETRY',0,0,'t','t');
await enriquecerViajesPendientes({DB:enrichDB},{esperaMs:0,fetchImpl:async()=>{
 enrichDB._sql.prepare("UPDATE trips SET start_location_raw='manual',revision=revision+1 WHERE id='enrich-race' AND revision=1").run();
 return {ok:true,json:async()=>({address:{road:'automated',city:'synthetic'}})};
}});
check(enrichDB._sql.prepare("SELECT start_location_raw,revision FROM trips WHERE id='enrich-race'").get(),{start_location_raw:'manual',revision:2},'enrichment cannot overwrite concurrent manual revision');
enrichDB._sql.prepare("UPDATE trips SET deleted_at='t',start_location_raw=NULL WHERE id='enrich-race'").run();
let fetches=0;await enriquecerViajesPendientes({DB:enrichDB},{fetchImpl:async()=>{fetches++;return {ok:false}}});
check(fetches,0,'enrichment excludes tombstones');
for (const [kind,builder] of [['trip',construirViajeDesdeEventos],['charge',construirCargaDesdeEventos]]) {
 const start=ev('gold-'+kind+'-s',kind==='trip'?'trip_started':'charge_started','08:00',{odometro_km:0,soc_pct:0,ac_energy_kwh:0});
 const end=ev('gold-'+kind+'-e',kind==='trip'?'trip_finished':'charge_stopped','08:30',{odometro_km:10,soc_pct:0,ac_energy_kwh:0});
 const context={odometroSnapshots:[],bateriaSnapshots:[],potenciaSnapshots:[],ubicaciones:[],reglas:[],ahoraIso:'2026-10-08T08:31:00.000Z'};
 const a=builder(vin,start,end,context),b=builder(vin,start,end,context);
 check(a,b,kind+' full deterministic golden repeat');
 if(kind==='trip')check([a.trip.distance_km,a.trip.duration_min,a.trip.energy_used_kwh],[10,30,null],'trip golden measured distance and absent energy');
 else check([a.carga.energy_kwh,a.carga.start_soc_pct,a.carga.end_soc_pct,a.carga.max_power_kw],[0,0,0,null],'charge golden measured zero energy distinct from absent power');
}
check(DB._sql.prepare('PRAGMA foreign_key_check').all(),[],'foreign keys');
check(DB._sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='telemetry_observations_vehicle_time'").get().n,1,'observation ordering index');
const reference=new DatabaseSync(':memory:');reference.exec(readFileSync(new URL('../d1/schema.sql',import.meta.url),'utf8'));
const schema=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(r=>({...r,sql:r.sql.replace(/IF NOT EXISTS /gi,'').replace(/\s+/g,' ')}));
check(schema(DB._sql),schema(reference),'0001–0009 schema SQL and indexes exactly match standalone schema');
reference.close();
console.log(`${checks}/${checks} telemetry integrity assertions PASS`);
