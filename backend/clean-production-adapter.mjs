import worker,{readAuthority,adminAuthentication} from './worker.js';
export const EMPTY_TABLES=["vehicles", "telemetry_nonces", "vehicle_vin_allowlist", "vehicle_settings", "bridge_heartbeats", "usage_counters", "quarantined_events", "oauth_start_tokens", "oauth_refresh_lock", "vehicle_snapshots", "telemetry_events_short_retention", "trips", "charging_sessions", "locations", "automation_rules", "pending_actions", "alerts", "battery_snapshots", "odometer_snapshots", "sync_state", "power_snapshots", "push_subscriptions", "push_config"];
export async function verifyEmpty(env){
 const fk=await env.DB.prepare('PRAGMA foreign_key_check').all();if(fk.results.length)throw Error('foreign_keys');
 const ledger=await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY name').all();
 if(JSON.stringify(ledger.results.map(x=>x.name))!==JSON.stringify(['0001_initial.sql','0002_capacidad_nominal_vehiculo.sql','0003_power_snapshots.sql','0004_tpms.sql','0005_push_real.sql','0006_data_canonical_lifecycle.sql','0007_c1_authority.sql','0008_session_auth.sql']))throw Error('migration_ledger');
 for(const table of EMPTY_TABLES)if((await env.DB.prepare('SELECT COUNT(*) AS n FROM '+table).first()).n!==0)throw Error('target_not_empty:'+table);
 return {empty:true,foreignKeys:0};
}
export async function cleanTransition(env,from,to){
 if(![['LEGACY','VERIFYING'],['VERIFYING','CANONICAL']].some(x=>x[0]===from&&x[1]===to))throw Error('clean_transition');
 await verifyEmpty(env);
 const empty=EMPTY_TABLES.map(t=>'(SELECT COUNT(*) FROM '+t+')=0').join(' AND ');
 const result=await env.DB.prepare("UPDATE system_state SET value=?,updated_at=? WHERE key='data_authority' AND value=? AND "+empty).bind(to,new Date().toISOString(),from).run();
 if(result.meta?.changes!==1)throw Error('authority_or_empty_conflict');return readAuthority(env);
}
export default {scheduled:worker.scheduled,async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname.startsWith('/internal/cutover/'))return Response.json({error:'legacy_import_disabled'},{status:403});
 if(!url.pathname.startsWith('/internal/clean-cutover/'))return worker.fetch(request,env,ctx);
 try{
  if(env.CUTOVER_ENABLE!=='AUTHORIZED_AT_CUTOVER')throw Error('disabled');
  const auth=adminAuthentication(request,env);if(!auth.ok)return Response.json({error:auth.error},{status:auth.status});
  if(request.method!=='POST')throw Error('method');const b=await request.json(),a=b.approval;
  if(b.plan||b.snapshot||b.rows)throw Error('legacy_payload_forbidden');
  if(!a?.approved||a.decision!=='NO_REAL_LEGACY_DATA_CONFIRMED'||a.databaseName!=='mitesla-canonical-production'||a.databaseName!==env.CUTOVER_DB_NAME||a.databaseId!==env.CUTOVER_DB_ID||! /^[a-f0-9-]{36}$/i.test(a.databaseId)||!Number.isFinite(Date.parse(a.bindingVerifiedAt))||Date.now()-Date.parse(a.bindingVerifiedAt)>900000||Date.parse(a.bindingVerifiedAt)>Date.now())throw Error('approved_target');
  const action=url.pathname.split('/').pop();
  if(action==='verify')return Response.json(await verifyEmpty(env));
  if(!a.schemaAndIndexesVerified||!a.smokePassed||!a.backendAndFrontendCertified||!a.browserPendingZero||request.headers.get('X-Cutover-Authorization')!==`Carlos:clean:${action}:${a.databaseId}`)throw Error('explicit_authorization_and_gates');
  if(action==='freeze')return Response.json(await cleanTransition(env,'LEGACY','VERIFYING'));
  if(action==='canonical')return Response.json(await cleanTransition(env,'VERIFYING','CANONICAL'));
  throw Error('action');
 }catch(e){return Response.json({error:e.message},{status:409})}
}};
