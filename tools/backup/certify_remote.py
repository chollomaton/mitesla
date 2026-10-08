"""Fresh synthetic D1 end-to-end certification; token from hidden input or environment.
No deployment, no production access, no pre-existing database targets.
"""
import argparse,copy,json,os,pathlib,sqlite3,tempfile
import backup,remote

def synthetic_backup():
    with tempfile.TemporaryDirectory() as directory:
        path=pathlib.Path(directory)/'synthetic.sqlite'
        db=sqlite3.connect(path);backup.initialize(db)
        db.execute("UPDATE system_state SET value='CANONICAL'")
        db.execute("INSERT INTO vehicles(vin,creado_en,actualizado_en) VALUES('SYNTHETIC','synthetic','synthetic')")
        for table in backup.TABLES:
            if table in ('vehicles','system_state'):continue
            row={}
            for _,name,kind,required,default,primary in db.execute('PRAGMA table_info('+table+')'):
                if name=='vin':row[name]='SYNTHETIC'
                elif primary:row[name]=table+'-id'
                elif required and default is None:row[name]=0 if kind in ('REAL','INTEGER') else 'synthetic'
            if table=='trips':row.update(revision=7,deleted_at='2026-10-08T00:00:00Z',distance_km=0,manual_override='{"enabled":false,"value":null,"zero":0}')
            if table=='charging_sessions':row.update(revision=9,deleted_at='2026-10-08T00:00:00Z',total_cost=0,fast_charger_present=0)
            columns=list(row);db.execute('INSERT INTO '+table+' ('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+')',list(row.values()))
        db.execute("UPDATE locations SET default_charging_price_rule_id='automation_rules-id'")
        db.execute("UPDATE trips SET start_location_id='locations-id',classification_rule_id='automation_rules-id'")
        db.commit();db.close()
        return backup.export(path,'synthetic-offline','certified-clean-production')

def certify(api):
    run=remote.Run(api);report={'production_reads':0,'production_mutations':0,'databases':[],'tests':{},'cleanup':{}}
    try:
        body=synthetic_backup()
        source=run.create('source');report['databases'].append({'role':'source','uuid':source,'name':run.created[source]})
        run.restore(body,source)
        # Deliberate credentials exist only in excluded collections.
        run.query(source,"INSERT INTO sessions(id,token_hash,created_at,expires_at) VALUES('synthetic-secret-session',?,1,2)",('a'*64,))
        run.query(source,"INSERT INTO oauth_start_tokens(token,creado_en) VALUES('synthetic-secret-oauth','synthetic')")
        exported=run.export(source,'certified-clean-production')
        backup.verify(exported);report['tests']['export']='PASS'
        target=run.create('target');report['databases'].append({'role':'target','uuid':target,'name':run.created[target]})
        for label in ('corrupt','incompatible'):
            bad=copy.deepcopy(exported)
            if label=='corrupt':bad['sha256']='invalid'
            else:bad['manifest']['schema_version']=999;bad['sha256']=backup.digest({k:v for k,v in bad.items() if k!='sha256'})
            try:run.restore(bad,target)
            except backup.Invalid:report['tests'][label+'_rejected']='PASS'
            else:raise backup.Invalid(label+' accepted')
        run.restore(exported,target);report['tests']['restore']='PASS'
        backup.require(run.capture(source)==run.capture(target),'record equivalence failed');report['tests']['equivalence']='PASS'
        for db in (source,target):
            ledger=run.query(db,'SELECT name FROM d1_migrations ORDER BY name')
            backup.require([r['name'] for r in ledger]==[p.name for p in backup.migrations()],'migration ledger mismatch')
            backup.require(not run.query(db,'PRAGMA foreign_key_check'),'FK invalid')
        report['tests']['migrations']='8/8';report['tests']['foreign_keys']='PASS'
        trip=exported['collections']['trips'][0];charge=exported['collections']['charging_sessions'][0]
        backup.require(trip['revision']==7 and trip['deleted_at'] is not None and trip['distance_km']==0 and trip['ended_at'] is None,'trip invariant failed')
        backup.require(charge['revision']==9 and charge['deleted_at'] is not None and charge['total_cost']==0 and charge['fast_charger_present']==0,'charge invariant failed')
        backup.require(json.loads(trip['manual_override'])=={'enabled':False,'value':None,'zero':0},'false/null/zero failed')
        backup.require(exported['collections']['system_state'][0]['value']=='CANONICAL','authority failed')
        report['tests']['tombstone_revision_null_zero_false_authority']='PASS'
        raw=backup.canonical(exported)
        backup.require(b'synthetic-secret-session' not in raw and b'synthetic-secret-oauth' not in raw and b'a'*64 not in raw,'secret leaked')
        for table in ('sessions','oauth_start_tokens','push_config','push_subscriptions'):
            backup.require(run.query(target,'SELECT COUNT(*) AS n FROM '+table)[0]['n']==0,'excluded collection restored')
        report['tests']['secrets_excluded']='PASS'
        # Target consumed by this run; no further remote writes are possible.
        try:run.restore(exported,target)
        except backup.Invalid:report['tests']['nonfresh_rejected']='PASS'
        else:raise backup.Invalid('restore in place accepted')
        for operation in (lambda:run.restore(exported,remote.PRODUCTION),lambda:run.export(remote.PRODUCTION,'test')):
            try:operation()
            except backup.Invalid:pass
            else:raise backup.Invalid('production accepted')
        report['tests']['production_hard_deny']='PASS';report['status']='REMOTE_PASS'
    except Exception as error:
        report['status']='REMOTE_FAIL';report['error_type']=type(error).__name__
        report['error']=str(error) if isinstance(error,backup.Invalid) else 'redacted runtime failure'
    finally:
        report['cleanup']=run.cleanup()
        if any(v!='DELETED' for v in report['cleanup'].values()):report['status']='REMOTE_FAIL'
    return report

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--report',required=True);args=parser.parse_args()
    token=os.environ.get('CLOUDFLARE_API_TOKEN')
    if not token:
        import getpass
        token=getpass.getpass('Temporary Cloudflare D1 token (hidden): ')
    backup.require(bool(token),'authentication required')
    report=certify(remote.API(token));token=None
    backup.write_new(args.report,(json.dumps(report,indent=2)+'\n').encode())
    print(json.dumps(report,indent=2));return 0 if report['status']=='REMOTE_PASS' else 1
if __name__=='__main__':raise SystemExit(main())
