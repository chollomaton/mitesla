import os
import sys,os,pathlib,subprocess,json,urllib.request,urllib.error,time,datetime,secrets,hmac,hashlib,uuid
ROOT=pathlib.Path(os.environ['MITESLA_REPO']).resolve()
sys.path.insert(0,str(ROOT/'tools/backup'))
import backup,remote,certify_remote
HERE=pathlib.Path.cwd(); OUT=HERE/'outputs'; WORK=HERE/'work'; OUT.mkdir(exist_ok=True); WORK.mkdir(exist_ok=True)
W=os.environ['WRANGLER_JS']
token=json.loads(subprocess.run(['node',W,'auth','token','--json'],capture_output=True,text=True,check=True,env={**os.environ,'WRANGLER_WRITE_LOGS':'false'}).stdout)['token']
secret=secrets.token_hex(32); admin=secrets.token_hex(32); stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')
name='mi-tesla-telemetry-canary-'+stamp; dbname='mitesla-telemetry-cert-'+stamp
report={'checkpoint':{'head':'e93d2d5ab85951009321b221072de464bbc04f39','main':'e11fa8377203e2bf6cd03e63fe9abd7265aa13f6','clean':True},'auth':'OAuth Keychain d1:write','tests':{},'cleanup':{},'production_d1_requests':0,'production_authority_requests':0}
run=remote.Run(remote.API(token)); worker_created=False

def save(): (OUT/'TELEMETRY-REMOTE-REPORT.json').write_text(json.dumps(report,indent=2)+'\n')
def api(method,path,body=None):
 assert remote.PRODUCTION not in path
 if method!='GET':assert '/scripts/mitesla-backend' not in path
 req=urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/'+remote.ACCOUNT+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=40) as r:d=json.load(r)
 except urllib.error.HTTPError as e:raise RuntimeError('API HTTP '+str(e.code)) from None
 assert d.get('success'),str(d.get('errors'));return d['result']
def check(label,actual,expected=True):
 ok=actual==expected;report['tests'][label]={'status':'PASS' if ok else 'FAIL','actual':actual,'expected':expected};save();print(('PASS ' if ok else 'FAIL ')+label,flush=True)
 if not ok:raise AssertionError(label)
def q(sql,params=()):return run.query(db,sql,params)
def http(path,body=None,headers=None,method=None):
 raw=None if body is None else (body.encode() if isinstance(body,str) else json.dumps(body,separators=(',',':')).encode())
 req=urllib.request.Request(url+path,data=raw,headers={'User-Agent':'MiTesla-Synthetic-Certification/1.0',**(headers or {})},method=method or ('POST' if body is not None else 'GET'))
 try:
  with urllib.request.urlopen(req,timeout=45) as r:code=r.status;data=r.read().decode()
 except urllib.error.HTTPError as e:code=e.code;data=e.read().decode()
 assert secret not in data and admin not in data,'secret response leakage'
 try:return code,json.loads(data)
 except:return code,data
vin='5YJYGDEE1MF000001'
def signed(body,key=None,nonce=None,extra=None):
 text=body if isinstance(body,str) else json.dumps(body,separators=(',',':'));ts=str(int(time.time()));nonce=nonce or str(uuid.uuid4());headers={'X-Timestamp':ts,'X-Nonce':nonce,'X-Signature':hmac.new((key or secret).encode(),(ts+'.'+nonce+'.'+text).encode(),hashlib.sha256).hexdigest()};headers.update(extra or {});return text,headers
def send(body,**opts):
 text,headers=signed(body,**opts);return http('/internal/telemetry',text,headers)
def ev(id,kind,t,payload=None):return {'id':id,'tipo':kind,'observado_en':'2026-10-08T'+t+':00.000Z','payload':payload or {}}
def deploy():
 p=subprocess.run(['node',W,'deploy','--config',str(WORK/'wrangler.json')],capture_output=True,text=True)
 (OUT/'canary-deploy.log').write_text(p.stdout+p.stderr)
 assert p.returncode==0,'canary deploy failed; see log'
 print('Canary deployed',flush=True)
try:
 report['production_before']=api('GET','/workers/scripts/mitesla-backend/deployments');save()
 sub=api('GET','/workers/subdomain');url='https://'+name+'.'+sub['subdomain']+'.workers.dev'
 db=run.api.create(dbname);assert db!=remote.PRODUCTION;run.created[db]=dbname;report['staging']={'name':dbname,'uuid':db};save()
 run.initialize(db);check('migration_ledger',[r['name'] for r in q('SELECT name FROM d1_migrations ORDER BY name')],[p.name for p in backup.migrations()]);run.capture(db);check('schema_indexes_fk',True)
 q("UPDATE system_state SET value='CANONICAL' WHERE key='data_authority'")
 q('INSERT INTO vehicles(vin,creado_en,actualizado_en) VALUES(?,?,?)',(vin,'synthetic','synthetic'))
 q('INSERT INTO vehicle_vin_allowlist(vin,activo,creado_en) VALUES(?,1,?)',(vin,'synthetic'))
 q('INSERT INTO vehicle_settings(vin,automation_mode,updated_at) VALUES(?,?,?)',(vin,'active','synthetic'))
 # Canary-only wrapper injects one deterministic D1 failure after authenticated admission.
 (WORK/'canary.mjs').write_text('import worker from '+json.dumps(str(ROOT/'worker.js'))+';import {reconcileCanonical} from '+json.dumps(str(ROOT/'backend/telemetry-integrity.mjs'))+';\nexport default {async fetch(request,env,ctx){if(new URL(request.url).pathname==="/__cert/reconcile"){if(request.headers.get("Authorization")!=="Bearer "+env.ADMIN_TOKEN)return new Response(null,{status:401});const b=await request.json();return Response.json(reconcileCanonical(b.current,b.observation))}const mode=request.headers.get("X-Cert-Fault");if(mode){const db=env.DB;let fired=false;env={...env,DB:{prepare(sql){const st=db.prepare(sql);const match=mode==="closure"?sql.startsWith("UPDATE telemetry_events_short_retention"):sql.startsWith("INSERT OR IGNORE INTO telemetry_events_short_retention");if(match&&!fired){return {bind(...args){const bound=st.bind(...args);return {async run(){fired=true;throw Error("synthetic canary write interruption")}}}}}return st}}};}return worker.fetch(request,env,ctx)}};\n')
 cfg={'name':name,'main':str(WORK/'canary.mjs'),'account_id':remote.ACCOUNT,'compatibility_date':'2026-10-08','workers_dev':True,'routes':[],'observability':{'enabled':False},'d1_databases':[{'binding':'DB','database_name':dbname,'database_id':db}]}
 (WORK/'wrangler.json').write_text(json.dumps(cfg,indent=2));report['canary']={'name':name,'url':url,'entry':'branch worker.js with canary-only write-failure wrapper','logging':'disabled','routes':[]};save()
 deploy();worker_created=True
 # Retry propagation without submitting any production request.
 for i in range(15):
  try:
   code,response= http('/internal/telemetry',{'vin':vin,'events':[]})
   if code==503:break
   report['initial_http_response']={'code':code,'body':response};save();time.sleep(2)
  except urllib.error.URLError:time.sleep(2)
 check('missing_env_secret_503',code,503)
 for key,value in [('TELEMETRY_BRIDGE_SECRET',secret),('ADMIN_TOKEN',admin)]:
  p=subprocess.run(['node',W,'secret','put',key,'--config',str(WORK/'wrangler.json')],input=value+'\n',capture_output=True,text=True);assert p.returncode==0,'secret installation failed'
 time.sleep(30) # Allow all secret versions to propagate before assertions.
 report['canary']['deployments']=api('GET','/workers/scripts/'+name+'/deployments');save()
 empty={'vin':vin,'events':[]}
 for i in range(20):
  code,_=http('/internal/telemetry',empty)
  if code==401:break
  time.sleep(2)
 check('hmac_missing',code,401)
 check('hmac_wrong',send(empty,key='wrong')[0],401)
 check('hmac_correct',send(empty)[0],200)
 check('malformed_json',send('{')[0],400)
 check('admin_no_telemetry_fallback',http('/internal/telemetry',empty,{'Authorization':'Bearer '+admin})[0],401)
 check('wrong_vehicle',send({'vin':'5YJYGDEE1MF000002','events':[]})[0],403)
 text,headers=signed(empty);check('fresh_nonce',http('/internal/telemetry',text,headers)[0],200);check('replay_nonce',http('/internal/telemetry',text,headers)[0],401)
 event=ev('event-1','test','10:00',{'nil':None,'zero':0,'flag':False});report['event_counts_before']=q('SELECT COUNT(*) n FROM telemetry_events_short_retention')
 for i in range(4):check('event_new_or_retry_'+str(i),send({'vin':vin,'events':[event]})[0],200)
 check('event_dedupe_count',q("SELECT COUNT(*) n FROM telemetry_events_short_retention WHERE id='event-1'")[0]['n'],1)
 check('null_zero_false',json.loads(q("SELECT payload FROM telemetry_events_short_retention WHERE id='event-1'")[0]['payload']),event['payload'])
 from concurrent.futures import ThreadPoolExecutor
 concurrent_event=ev('concurrent','test','18:00',{'value':0})
 with ThreadPoolExecutor(max_workers=2) as pool:
  futures=[pool.submit(send,{'vin':vin,'events':[dict(concurrent_event,payload={'value':i})]}) for i in range(2)]
  check('concurrent_conflict',sorted(f.result()[0] for f in futures),[200,409])
 check('concurrent_one_row',q("SELECT COUNT(*) n FROM telemetry_events_short_retention WHERE id='concurrent'")[0]['n'],1)
 check('event_conflict',send({'vin':vin,'events':[dict(event,payload={'zero':1})]})[0],409)
 def snap(t,soc=0):return {'vin':vin,'snapshot':{'observado_en':'2026-10-08T'+t+':00Z','soc_pct':soc,'odometro_km':0}}
 for t in ['12:00','11:00']:check('snapshot_'+t,send(snap(t))[0],200)
 check('snapshot_no_regression',q('SELECT observado_en FROM vehicle_snapshots')[0]['observado_en'],'2026-10-08T12:00:00.000Z')
 check('snapshot_same_content',send(snap('12:00'))[0],200);check('snapshot_conflict',send(snap('12:00',1))[0],409);check('snapshot_newer',send(snap('13:00'))[0],200)
 for kind,table,st,et in [('trip','trips','trip_started','trip_finished'),('charge','charging_sessions','charge_started','charge_stopped')]:
  start=ev(kind+'-s',st,'14:00',{'odometro_km':100,'soc_pct':50,'ac_energy_kwh':0});end=ev(kind+'-e',et,'14:30',{'odometro_km':110,'soc_pct':60,'ac_energy_kwh':5})
  check(kind+'_start',send({'vin':vin,'events':[start]})[0],200);check(kind+'_active_retry',send({'vin':vin,'events':[start]})[0],200)
  check(kind+'_active_one_raw',q('SELECT COUNT(*) n FROM telemetry_events_short_retention WHERE id=?',(start['id'],))[0]['n'],1)
  check(kind+'_no_premature_history',q('SELECT COUNT(*) n FROM '+table)[0]['n'],0)
  check(kind+'_interrupted_close',send({'vin':vin,'events':[end]},extra={'X-Cert-Fault':'closure'})[0],502)
  for i in range(2):check(kind+'_recovery_retry_'+str(i),send({'vin':vin,'events':[start,end]})[0],200)
  row=q('SELECT * FROM '+table)[0];check(kind+'_golden',[row['started_at'],row['ended_at'],row['duration_min'],row['revision']],['2026-10-08T14:00:00.000Z','2026-10-08T14:30:00.000Z',30,1]);check(kind+'_one_history',q('SELECT COUNT(*) n FROM '+table)[0]['n'],1)
  q('UPDATE '+table+' SET manual_override=?,revision=9',('{"zero":0,"flag":false,"nil":null}',));q('UPDATE telemetry_events_short_retention SET procesado_en=NULL WHERE id IN (?,?)',(start['id'],end['id']))
  check(kind+'_manual_reprocess',send({'vin':vin,'events':[start,end]})[0],200);check(kind+'_manual_revision_protected',q('SELECT revision,manual_override FROM '+table)[0],{'revision':9,'manual_override':'{"zero":0,"flag":false,"nil":null}'})
  q('UPDATE '+table+' SET deleted_at=?,revision=10',('2026-10-08T15:00:00Z',));q('DELETE FROM telemetry_events_short_retention WHERE id IN (?,?)',(start['id'],end['id']))
  check(kind+'_tombstone_replay',send({'vin':vin,'events':[start,end]})[0],200);check(kind+'_tombstone_protected',q('SELECT revision,deleted_at FROM '+table)[0],{'revision':10,'deleted_at':'2026-10-08T15:00:00Z'})
  check(kind+'_post_purge_conflict',send({'vin':vin,'events':[dict(end,payload={'soc_pct':1})]})[0],409)
  alt=[dict(start,id=start['id']+'-alt'),dict(end,id=end['id']+'-alt')];check(kind+'_alternate_ids_conflict',send({'vin':vin,'events':alt})[0],409);q('DELETE FROM telemetry_events_short_retention WHERE id IN (?,?)',tuple(x['id'] for x in alt))
  # Independent late start scenario using fresh later timestamps.
  s=ev(kind+'-late-s',st,'16:00',{'odometro_km':0,'soc_pct':0,'ac_energy_kwh':0});e=ev(kind+'-late-e',et,'16:30',{'odometro_km':10,'soc_pct':0,'ac_energy_kwh':0})
  check(kind+'_admission_crash',send({'vin':vin,'events':[s]},extra={'X-Cert-Fault':'start'})[0],502)
  check(kind+'_end_before_start_retry',send({'vin':vin,'events':[e]})[0],200);check(kind+'_late_start_recovery',send({'vin':vin,'events':[s]})[0],200);check(kind+'_recovered_count',q('SELECT COUNT(*) n FROM '+table)[0]['n'],2)
  r=q('SELECT * FROM '+table+' WHERE started_at=?',('2026-10-08T16:00:00.000Z',))[0]
  if kind=='trip':check('golden_trip_measured',[r['distance_km'],r['energy_used_kwh']],[10,None])
  else:check('golden_charge_measured',[r['energy_kwh'],r['start_soc_pct'],r['end_soc_pct'],r['max_power_kw']],[0,0,0,None])
 # Remote execution of pure canonical reconciliation: upstream revisions are absent from the wire contract.
 canonical={'id':'x','revision':8,'deleted_at':None,'manual_override':{'distance_km':0,'flag':False},'distance_km':0,'note':None}
 rh={'Authorization':'Bearer '+admin}
 check('same_revision_same_content',http('/__cert/reconcile',{'current':canonical,'observation':canonical},rh)[1]['status'],'confirmed')
 check('same_revision_different_content',http('/__cert/reconcile',{'current':canonical,'observation':dict(canonical,distance_km=1)},rh)[1]['status'],'conflict')
 check('revision_monotonic',http('/__cert/reconcile',{'current':canonical,'observation':{'revision':7,'distance_km':100}},rh)[1]['entity'],canonical)
 report['revision_test_scope']='Pure production reconciliation function executed on remote canary; telemetry envelope has no upstream canonical revision.'
 # Synthetic browser session, stored hash only; never bootstrap production.
 session=secrets.token_urlsafe(32);now=int(time.time()*1000);q('INSERT INTO sessions(id,token_hash,created_at,expires_at) VALUES(?,?,?,?)',('synthetic-session',hashlib.sha256(session.encode()).hexdigest(),now,now+600000));sh={'Authorization':'Bearer '+session}
 check('session_health',http('/internal/health?vin='+vin,headers=sh)[0],200);check('browser_authority',http('/canonical/system/authority',headers=sh)[0],200)
 check('session_no_telemetry_fallback',http('/internal/telemetry',empty,sh)[0],401)
 check('session_revoke',http('/auth/session/revoke',{},sh)[0],200);check('session_revoked_denied',http('/canonical/system/authority',headers=sh)[0],401)
 check('secret_field_rejected',send({'vin':vin,'events':[ev('sensitive','test','18:00',{'secret':'synthetic-sensitive'})]})[0],400)
 check('secret_not_quarantined',q("SELECT COUNT(*) n FROM quarantined_events WHERE payload_recortado LIKE '%synthetic-sensitive%'")[0]['n'],0)
 check('foreign_key_check',q('PRAGMA foreign_key_check'),[]);check('authority_staging',q("SELECT value FROM system_state WHERE key='data_authority'")[0]['value'],'CANONICAL')
 report['final_counts']={t:q('SELECT COUNT(*) n FROM '+t)[0]['n'] for t in ['trips','charging_sessions','telemetry_observations','telemetry_events_short_retention','d1_migrations']};save()
 print('Starting remote backup 0009 certification',flush=True)
 report['backup']=certify_remote.certify(remote.API(token));save();check('backup_remote_0009',report['backup']['status'],'REMOTE_PASS')
 # Explicit old eight-migration backup rejects before issuing any remote request.
 old=certify_remote.synthetic_backup();old['manifest']['migration_sha256'].pop('0009_telemetry_integrity.sql');old['collections'].pop('telemetry_observations');old['manifest']['record_counts'].pop('telemetry_observations');old['manifest']['collection_sha256'].pop('telemetry_observations');old['sha256']=backup.digest({k:v for k,v in old.items() if k!='sha256'})
 try:backup.verify(old)
 except backup.Invalid:check('old_eight_migration_backup_rejected',True)
 else:check('old_eight_migration_backup_rejected',False)
 report['logs_scope']='Canary observability disabled, no tail session; response bodies checked against in-memory secrets; application console paths inspected; stored logs not retrieved.'
 report['recovery_scope']='Separate HTTP requests use persistent remote D1; authenticated canary wrapper injects failures before RAW and after canonical insert. No forced isolate eviction.'
 report['status']='TELEMETRY_INTEGRITY_REMOTE_CERTIFIED'
except Exception as e:
 report['status']='TELEMETRY_REMOTE_PARTIAL' if report.get('staging') else 'TELEMETRY_INTEGRITY_BLOCKED';report['error']={'type':type(e).__name__,'message':str(e)[:300]};print('STOP',type(e).__name__,str(e)[:200],flush=True)
finally:
 if worker_created:
  try:api('DELETE','/workers/scripts/'+name);report['cleanup'][name]='DELETED'
  except Exception as e:report['cleanup'][name]='FAILED '+type(e).__name__
 report['cleanup'].update(run.cleanup())
 try:report['production_after']=api('GET','/workers/scripts/mitesla-backend/deployments');report['production_deployments_unchanged']=report['production_before']==report['production_after']
 except Exception as e:report['production_verify_error']=type(e).__name__
 if any(v!='DELETED' for v in report['cleanup'].values()) or not report.get('production_deployments_unchanged'):report['status']='TELEMETRY_REMOTE_PARTIAL'
 save();print('Report saved; cleanup:',json.dumps(report['cleanup']),flush=True)
