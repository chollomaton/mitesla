import copy, json, pathlib, sqlite3, tempfile, unittest
import backup as b
class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = pathlib.Path(self.tmp.name)
        self.source = self.root/'source.sqlite'; self.db = sqlite3.connect(self.source); b.initialize(self.db)
        self.db.execute("UPDATE system_state SET value='CANONICAL'"); self.db.commit()
    def tearDown(self): self.db.close(); self.tmp.cleanup()
    def export(self): return b.export(self.source,'synthetic-local','fd145309/backend-deacebbc')
    def sign(self, body):
        m = body['manifest']
        m['record_counts'] = {t:len(body['collections'][t]) for t in b.TABLES}
        m['collection_sha256'] = {t:b.digest(body['collections'][t]) for t in b.TABLES}
        body['sha256'] = b.digest({k:v for k,v in body.items() if k != 'sha256'})
    def fixture(self):
        self.db.execute("INSERT INTO vehicles(vin,creado_en,actualizado_en) VALUES ('SYNTHETIC','t','t')")
        for table in b.TABLES:
            if table in ('vehicles','system_state'): continue
            fields = self.db.execute(f'PRAGMA table_info({table})').fetchall(); record = {}
            for _,name,kind,notnull,default,pk in fields:
                if name == 'vin': record[name] = 'SYNTHETIC'
                elif pk: record[name] = table+'-id'
                elif notnull and default is None: record[name] = 0 if kind in ('REAL','INTEGER') else 'synthetic'
            if table == 'telemetry_observations': record.update(source='TESLA_TELEMETRY',fingerprint='b'*64)
            if table == 'trips': record.update(revision=7,deleted_at='2026-10-08T00:00:00Z',distance_km=0,manual_override='{"enabled":false,"value":null,"zero":0}')
            if table == 'charging_sessions': record.update(revision=9,deleted_at='2026-10-08T00:00:00Z',total_cost=0,fast_charger_present=0)
            cols=list(record); self.db.execute(f'INSERT INTO {table} ('+','.join(cols)+') VALUES ('+','.join('?' for _ in cols)+')',list(record.values()))
        # A circular place/rule reference must survive deferred restore constraints.
        self.db.execute("UPDATE locations SET default_charging_price_rule_id='automation_rules-id'")
        self.db.execute("UPDATE trips SET start_location_id='locations-id',classification_rule_id='automation_rules-id'")
        self.db.execute("INSERT INTO sessions(id,token_hash,created_at,expires_at,device_label) VALUES ('secret-session',?,1,2,'secret-label')",('a'*64,))
        self.db.execute("INSERT INTO oauth_start_tokens VALUES ('secret-oauth','t',NULL)")
        self.db.commit()
    def test_empty_backup_restore(self):
        body=self.export(); self.assertTrue(b.verify(body)); b.restore(body,self.root/'empty.sqlite')
    def test_synthetic_equivalence_tombstones_revision_null_zero_false(self):
        self.fixture(); body=self.export(); target=self.root/'restored.sqlite'; b.restore(body,target)
        with sqlite3.connect(target) as restored:
            for table in b.TABLES: self.assertEqual(b.rows(self.db,table),b.rows(restored,table))
            self.assertEqual(restored.execute('SELECT count(*) FROM sessions').fetchone()[0],0)
            self.assertEqual(restored.execute('SELECT count(*) FROM oauth_start_tokens').fetchone()[0],0)
        trip=body['collections']['trips'][0]; self.assertEqual(trip['revision'],7); self.assertIsNotNone(trip['deleted_at']); self.assertIsNone(trip['ended_at']); self.assertEqual(trip['distance_km'],0)
        self.assertIs(json.loads(trip['manual_override'])['enabled'],False)
    def test_secrets_excluded(self):
        self.fixture(); raw=b.canonical(self.export()); self.assertNotIn(b'secret-session',raw); self.assertNotIn(b'secret-oauth',raw); self.assertNotIn(b'a'*64,raw)
    def test_global_corruption(self):
        body=self.export(); body['manifest']['source_db_id']='tampered'
        with self.assertRaises(b.Invalid): b.verify(body)
    def test_collection_corruption(self):
        body=self.export(); body['manifest']['collection_sha256']['trips']='0'*64
        body['sha256']=b.digest({k:v for k,v in body.items() if k!='sha256'})
        with self.assertRaises(b.Invalid): b.verify(body)
    def test_incompatible_version_and_migrations(self):
        for key,value in [('schema_version',2),('migration_sha256',{})]:
            body=self.export(); body['manifest'][key]=value; self.sign(body)
            with self.assertRaises(b.Invalid): b.verify(body)
    def test_existing_target_never_overwritten(self):
        body=self.export(); before=self.source.read_bytes()
        with self.assertRaises(FileExistsError): b.restore(body,self.source)
        self.assertEqual(before,self.source.read_bytes())
    def test_invalid_backup_creates_no_target(self):
        body=self.export(); body['sha256']='bad'; target=self.root/'absent.sqlite'
        with self.assertRaises(b.Invalid): b.restore(body,target)
        self.assertFalse(target.exists())
    def test_foreign_keys_invalid_even_with_valid_hash(self):
        self.fixture(); body=self.export(); body['collections']['trips'][0]['vin']='orphan'; self.sign(body)
        with self.assertRaises(b.Invalid): b.verify(body)
    def test_secret_in_nested_json_rejected(self):
        self.fixture(); self.db.execute("UPDATE trips SET manual_override=?",('{"access_token":"secret"}',)); self.db.commit()
        with self.assertRaises(b.Invalid): self.export()
    def test_schema_drift(self):
        self.db.execute('ALTER TABLE trips ADD COLUMN unreviewed TEXT'); self.db.commit()
        with self.assertRaises(b.Invalid): self.export()
    def test_unstable_authority(self):
        self.db.execute("UPDATE system_state SET value='IMPORTING'"); self.db.commit()
        with self.assertRaises(b.Invalid): self.export()
    def test_append_only(self):
        path=self.root/'backup.json'; b.write_new(path,b'first')
        with self.assertRaises(FileExistsError): b.write_new(path,b'second')
        self.assertEqual(path.read_bytes(),b'first')
    def test_duplicate_keys(self):
        path=self.root/'bad.json'; path.write_text('{"a":1,"a":2}')
        with self.assertRaises(b.Invalid): b.load(path)
    def test_export_readonly_and_deterministic_collections(self):
        self.fixture(); before=self.source.read_bytes(); first=self.export(); second=self.export()
        self.assertEqual(before,self.source.read_bytes())
        self.assertEqual(first['collections'],second['collections'])
        self.assertEqual(first['manifest']['collection_sha256'],second['manifest']['collection_sha256'])
    def test_signed_duplicate_record_rejected(self):
        self.fixture(); body=self.export(); body['collections']['vehicles'] *= 2; self.sign(body)
        with self.assertRaises(b.Invalid): b.verify(body)
    def test_signed_invalid_revision_rejected(self):
        self.fixture(); body=self.export(); body['collections']['trips'][0]['revision']=0; self.sign(body)
        with self.assertRaises(b.Invalid): b.verify(body)
    def test_signed_unknown_column_rejected(self):
        self.fixture(); body=self.export(); body['collections']['trips'][0]['extra']='unexpected'; self.sign(body)
        with self.assertRaises(b.Invalid): b.verify(body)
    def test_remote_target_rejected(self):
        with self.assertRaises(b.Invalid): b.restore(self.export(),'https://production')
if __name__=='__main__': unittest.main(verbosity=2)
