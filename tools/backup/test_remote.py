"""Offline transport contract tests. These never certify live Cloudflare D1."""
import copy,sqlite3,unittest,uuid,io,json
from unittest.mock import patch
import backup,remote,certify_remote
import test_backup
class SQLiteAPI:
    def __init__(self): self.dbs={};self.calls=[]
    def create(self,name):
        key=str(uuid.uuid4());self.dbs[key]=sqlite3.connect(':memory:');self.dbs[key].row_factory=sqlite3.Row;self.dbs[key].execute('PRAGMA foreign_keys=ON');return key
    def query(self,db,sql,params=()):
        self.calls.append((db,sql));cursor=self.dbs[db].execute(sql,params);self.dbs[db].commit();return [dict(r) for r in cursor.fetchall()]
    def delete(self,db): self.dbs.pop(db).close()
class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_backup.BackupTests();self.fixture.setUp();self.fixture.fixture();self.body=self.fixture.export();self.api=SQLiteAPI();self.run=remote.Run(self.api)
    def tearDown(self):self.run.cleanup();self.fixture.tearDown()
    def test_end_to_end_all_collections(self):
        source=self.run.create('source');self.run.restore(self.body,source)
        exported=self.run.export(source,'synthetic-contract');target=self.run.create('target');self.run.restore(exported,target)
        self.assertEqual(self.run.capture(source),self.run.capture(target));self.assertEqual(exported['collections'],self.body['collections'])
        self.assertEqual(len(self.run.query(target,'SELECT * FROM d1_migrations')),9)
        self.assertEqual(self.run.query(target,'SELECT COUNT(*) AS n FROM sessions')[0]['n'],0)
        self.assertEqual(self.run.query(target,'SELECT COUNT(*) AS n FROM oauth_start_tokens')[0]['n'],0)
    def test_production_and_existing_rejected_before_transport(self):
        for db in (remote.PRODUCTION,remote.PRODUCTION.upper(),str(uuid.uuid4())):
            before=len(self.api.calls)
            for op in (lambda:self.run.export(db,'test'),lambda:self.run.restore(self.body,db),lambda:self.run.initialize(db)):
                with self.assertRaises(backup.Invalid):op()
            self.assertEqual(len(self.api.calls),before)
    def test_corrupt_and_incompatible_before_remote_queries(self):
        target=self.run.create('target')
        for change in ('checksum','version'):
            body=copy.deepcopy(self.body)
            if change=='checksum':body['sha256']='broken'
            else:body['manifest']['schema_version']=999;self.fixture.sign(body)
            with self.assertRaises(backup.Invalid):self.run.restore(body,target)
        self.assertEqual(self.api.calls,[])
    def test_nonfresh_target_rejected(self):
        target=self.run.create('target');self.api.query(target,'CREATE TABLE unexpected(id TEXT)');before=len(self.api.calls)
        with self.assertRaises(backup.Invalid):self.run.restore(self.body,target)
        self.assertEqual(len(self.api.calls),before+1)
    def test_no_restore_in_place(self):
        target=self.run.create('target');self.run.restore(self.body,target);before=len(self.api.calls)
        with self.assertRaises(backup.Invalid):self.run.restore(self.body,target)
        self.assertEqual(len(self.api.calls),before)
    def test_changed_second_capture_aborts(self):
        source=self.run.create('source');self.run.restore(self.body,source);original=self.run.capture;count=0
        def capture(db):
            nonlocal count
            result=original(db);count+=1
            if count==1:self.api.query(db,'UPDATE trips SET distance_km=5,revision=revision+1')
            return result
        self.run.capture=capture
        with self.assertRaisesRegex(backup.Invalid,'changed'):self.run.export(source,'test')
    def test_cleanup_only_owned_databases(self):
        source=self.run.create('source');target=self.run.create('target');self.assertEqual(self.run.cleanup(),{source:'DELETED',target:'DELETED'});self.assertEqual(self.api.dbs,{})
    def test_full_certification_runner(self):
        report=certify_remote.certify(self.api)
        self.assertEqual(report['status'],'REMOTE_PASS',report)
        self.assertEqual(len(report['databases']),2)
        self.assertTrue(all(v=='DELETED' for v in report['cleanup'].values()))
        self.assertEqual(report['production_reads'],0)
        self.assertEqual(report['tests']['secrets_excluded'],'PASS')
    def test_http_contract_and_scalar_bindings(self):
        response={'success':True,'result':[{'success':True,'results':[{'n':0}]}]}
        with patch('urllib.request.urlopen',return_value=io.BytesIO(json.dumps(response).encode())) as opened:
            self.assertEqual(remote.API('synthetic-token').query(str(uuid.uuid4()),'SELECT ?', [None,0,False]),[{'n':0}])
            request=opened.call_args[0][0]
            self.assertEqual(json.loads(request.data)['params'],[None,0,False])
            self.assertIn('/accounts/'+remote.ACCOUNT+'/d1/database/',request.full_url)
            self.assertEqual(request.get_method(),'POST')
    def test_api_query_failure_closed(self):
        response={'success':True,'result':[{'success':False,'results':[]}]}
        with patch('urllib.request.urlopen',return_value=io.BytesIO(json.dumps(response).encode())):
            with self.assertRaises(backup.Invalid):remote.API('synthetic-token').query(str(uuid.uuid4()),'SELECT 1')
    def test_capture_truncation_rejected(self):
        source=self.run.create('source');self.run.restore(self.body,source);original=self.api.query
        def query(db,sql,params=()):
            result=original(db,sql,params)
            return [] if sql=='SELECT * FROM "trips"' else result
        self.api.query=query
        with self.assertRaisesRegex(backup.Invalid,'count mismatch'):self.run.export(source,'test')
    def test_raw_api_production_denied_before_http(self):
        api=remote.API('synthetic-never-sent')
        with self.assertRaises(backup.Invalid):api.query(remote.PRODUCTION,'SELECT 1')
if __name__=='__main__':unittest.main(verbosity=2)
