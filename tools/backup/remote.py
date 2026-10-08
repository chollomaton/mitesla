"""Synthetic D1 certification only. Production and all pre-existing DBs denied.

Two complete deterministic captures must match, including schema and FK checks.
This detects observable drift; it is not a global transaction or protection against
ABA changes. Fresh isolated synthetic DBs must have no other writers.
"""
import datetime,json,re,sqlite3,urllib.request,urllib.error,uuid
import backup
ACCOUNT='ea209ceb5a4f8f659cc546593aa74b22'
PRODUCTION='98d74aae-e2f2-40d0-8c20-3349f08ada1f'
SCHEMA_SQL="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_KV') AND tbl_name NOT IN ('d1_migrations','_cf_KV') ORDER BY type,name"
class API:
    def __init__(self,token): self._token=token
    def request(self,method,path,body=None):
        # Defense in depth: deny even if caller bypasses the run registry.
        backup.require(PRODUCTION not in path.lower(),'production hard deny')
        req=urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database'+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+self._token,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=30) as response: data=json.load(response)
        except urllib.error.HTTPError as e: raise backup.Invalid('Cloudflare HTTP '+str(e.code)) from None
        backup.require(data.get('success') is True,'Cloudflare API failure')
        return data['result']
    def create(self,name): return self.request('POST','',{'name':name})['uuid']
    def query(self,db,sql,params=()):
        result=self.request('POST','/'+db+'/query',{'sql':sql,'params':list(params)})
        backup.require(isinstance(result,list) and len(result)==1 and result[0].get('success') is True,'query response invalid')
        backup.require(isinstance(result[0].get('results'),list),'query results absent')
        return result[0]['results']
    def delete(self,db): self.request('DELETE','/'+db)
def statements(text):
    statement=''
    for line in text.splitlines(True):
        statement+=line
        if sqlite3.complete_statement(statement):
            yield statement;statement=''
    backup.require(not statement.strip(),'incomplete migration SQL')
class Run:
    def __init__(self,api): self.api=api;self.created={};self.restored=set()
    def guard(self,db):
        backup.require(isinstance(db,str) and db.lower()!=PRODUCTION,'production hard deny')
        backup.require(db in self.created,'database not created by this run')
    def create(self,role):
        backup.require(role in ('source','target'),'invalid certification role')
        name='mitesla-backup-cert-'+role+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')+'-'+uuid.uuid4().hex[:8]
        db=self.api.create(name)
        backup.require(isinstance(db,str) and re.fullmatch(r'[a-f0-9-]{36}',db) and db.lower()!=PRODUCTION,'invalid created database')
        self.created[db]=name;return db
    def query(self,db,sql,params=()): self.guard(db);return self.api.query(db,sql,params)
    def initialize(self,db):
        self.guard(db);backup.pins()
        # New DB must contain no application tables before any migration writes.
        tables=self.query(db,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_cf_KV'")
        backup.require(not tables,'target not fresh')
        self.query(db,'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
        for migration in backup.migrations():
            for sql in statements(migration.read_text()): self.query(db,sql)
            self.query(db,'INSERT INTO d1_migrations(name) VALUES(?)',(migration.name,))
    def capture(self,db):
        self.guard(db)
        actual=self.query(db,SCHEMA_SQL)
        ref=backup.reference()
        try: backup.require([[r[k] for k in ('type','name','tbl_name','sql')] for r in actual]==backup.schema(ref),'source schema incompatible')
        finally: ref.close()
        backup.require(not self.query(db,'PRAGMA foreign_key_check'),'source FK invalid')
        data={}
        for table in backup.TABLES:
            count=self.query(db,'SELECT COUNT(*) AS n FROM "'+table+'"')[0]['n']
            records=sorted(self.query(db,'SELECT * FROM "'+table+'"'),key=backup.canonical)
            backup.require(count==len(records),'capture count mismatch or truncated results')
            data[table]=records
        backup.scan(data)
        return {'schema':actual,'collections':data}
    def export(self,db,version):
        first=self.capture(db);second=self.capture(db)
        backup.require(backup.canonical(first)==backup.canonical(second),'source changed between captures')
        data=first['collections']
        manifest={'schema_version':backup.VERSION,'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_db_id':db,'app_backend_version':version,'migration_sha256':backup.pins(),'record_counts':{t:len(data[t]) for t in backup.TABLES},'collection_sha256':{t:backup.digest(data[t]) for t in backup.TABLES}}
        body={'manifest':manifest,'collections':data};body['sha256']=backup.digest(body);backup.verify(body);return body
    def restore(self,body,db):
        self.guard(db);backup.require(db not in self.restored,'target already consumed')
        backup.verify(body) # all integrity/schema/FK validation before remote calls
        self.initialize(db)
        # Target becomes consumed before any data write; failed restore cannot resume in place.
        self.restored.add(db)
        empty=backup.reference();all_tables=[r[0] for r in empty.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")];empty.close()
        for table in all_tables:
            if table=='system_state':continue
            backup.require(self.query(db,'SELECT COUNT(*) AS n FROM "'+table+'"')[0]['n']==0,'target not empty')
        for table in backup.TABLES:
            if table=='system_state':
                row=body['collections'][table][0]
                self.query(db,'UPDATE system_state SET value=?,updated_at=? WHERE key=?',(row['value'],row['updated_at'],row['key']));continue
            for original in body['collections'][table]:
                row=dict(original)
                cols=list(row)
                self.query(db,'INSERT INTO "'+table+'" ('+','.join('"'+c+'"' for c in cols)+') VALUES ('+','.join('?' for c in cols)+')',tuple(row.values()))
        backup.require(not self.query(db,'PRAGMA foreign_key_check'),'restored FK invalid')
        backup.require(self.capture(db)['collections']==body['collections'],'restore equivalence failed')
        return {'status':'PASS','target':db,'authority':'CANONICAL','cutover_authorized':False}
    def cleanup(self):
        results={}
        for db in list(self.created):
            self.guard(db)
            try:self.api.delete(db);results[db]='DELETED';del self.created[db]
            except Exception:results[db]='CLEANUP_FAILED'
        return results
