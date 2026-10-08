"""Offline canonical backup. No network, credentials, SQL input or remote restore."""
import argparse, datetime, hashlib, json, math, os, pathlib, re, sqlite3
ROOT = pathlib.Path(__file__).resolve().parent
TABLES = ('vehicles', 'vehicle_vin_allowlist', 'vehicle_settings', 'automation_rules',
          'locations', 'trips', 'charging_sessions', 'pending_actions', 'alerts',
          'battery_snapshots', 'odometer_snapshots', 'power_snapshots', 'telemetry_observations', 'system_state')
VERSION = 1
SECRET = re.compile(r'^(admin|admin_token|sessions?|github_pat|pat|token|token_hash|access_token|refresh_token|tesla_tokens|oauth|password|secret|private_key|bearer)$', re.I)
class Invalid(ValueError): pass
def require(condition, message):
    if not condition: raise Invalid(message)
def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
def digest(value): return hashlib.sha256(canonical(value)).hexdigest()
def migrations():
    files = sorted((ROOT / 'migrations').glob('*.sql'))
    require(len(files) == 9, 'migration inventory invalid')
    return files
def pins():
    actual = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in migrations()}
    expected = json.loads((ROOT / 'migration-pins.json').read_text())
    require(actual == expected, 'local migration pin mismatch')
    return expected
def initialize(db):
    for p in migrations(): db.executescript(p.read_text())
    db.commit()
def reference():
    db = sqlite3.connect(':memory:'); initialize(db); return db
def schema(db):
    # Includes constraints, indexes and excluded tables: fail closed on any schema drift.
    return [list(r) for r in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_KV') AND tbl_name NOT IN ('d1_migrations','_cf_KV') ORDER BY type,name")]
def columns(db, table): return [r[1] for r in db.execute(f'PRAGMA table_info("{table}")')]
def rows(db, table):
    cols = columns(db, table)
    result = [dict(zip(cols, row)) for row in db.execute(f'SELECT * FROM "{table}"')]
    return sorted(result, key=canonical)
def scan(value):
    if isinstance(value, dict):
        for key, item in value.items():
            require(not SECRET.fullmatch(key), 'secret field rejected')
            scan(item)
    elif isinstance(value, list):
        for item in value: scan(item)
    elif isinstance(value, str):
        require(not re.search(r'Bearer\s+\S+|-----BEGIN .*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}', value, re.I), 'credential pattern rejected')
        try: nested = json.loads(value)
        except (ValueError, RecursionError): return
        if isinstance(nested, (dict, list)): scan(nested)
def connect_readonly(path):
    return sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True)
def export(path, source_id, app_version):
    require(bool(source_id) and bool(app_version), 'source and version required')
    ref = reference()
    with connect_readonly(path) as db:
        db.execute('BEGIN') # one consistent SQLite read snapshot
        require(schema(db) == schema(ref), 'source schema incompatible')
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'source foreign keys invalid')
        data = {t: rows(db, t) for t in TABLES}
        scan(data)
        manifest = {'schema_version': VERSION, 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'source_db_id': source_id, 'app_backend_version': app_version,
                    'migration_sha256': pins(), 'record_counts': {t: len(data[t]) for t in TABLES},
                    'collection_sha256': {t: digest(data[t]) for t in TABLES}}
        body = {'manifest': manifest, 'collections': data}
        body['sha256'] = digest(body)
    ref.close()
    verify(body)
    return body

def verify(body):
    require(isinstance(body, dict) and set(body) == {'manifest','collections','sha256'}, 'backup envelope invalid')
    m, data = body['manifest'], body['collections']
    require(isinstance(m,dict) and set(m) == {'schema_version','created_at','source_db_id','app_backend_version','migration_sha256','record_counts','collection_sha256'}, 'manifest invalid')
    require(type(m['schema_version']) is int and m['schema_version'] == VERSION, 'schema version incompatible')
    require(m['migration_sha256'] == pins(), 'migration compatibility failed')
    require(all(isinstance(m[k], str) and m[k] for k in ('source_db_id','app_backend_version','created_at')), 'metadata invalid')
    try: require(datetime.datetime.fromisoformat(m['created_at']).tzinfo is not None, 'timestamp timezone missing')
    except ValueError: raise Invalid('timestamp invalid')
    require(isinstance(data, dict) and set(data) == set(TABLES), 'collection inventory invalid')
    require(isinstance(m['record_counts'],dict) and set(m['record_counts']) == set(TABLES), 'counts invalid')
    require(isinstance(m['collection_sha256'],dict) and set(m['collection_sha256']) == set(TABLES), 'hash inventory invalid')
    require(body['sha256'] == digest({'manifest':m,'collections':data}), 'global checksum failed')
    scan(data); scan(m)
    db = reference()
    try:
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('BEGIN'); db.execute('PRAGMA defer_foreign_keys=ON')
        db.execute('DELETE FROM system_state')
        for t in TABLES:
            records = data[t]; cols = columns(db,t)
            require(isinstance(records,list), 'collection not array')
            require(type(m['record_counts'][t]) is int and m['record_counts'][t] == len(records), 'record count failed')
            require(m['collection_sha256'][t] == digest(records), 'collection checksum failed')
            require(records == sorted(records,key=canonical), 'unstable row ordering')
            for r in records:
                require(isinstance(r,dict) and set(r) == set(cols), 'columns incompatible')
                primary = [field[1] for field in db.execute(f'PRAGMA table_info("{t}")') if field[5]]
                require(all(r[c] is not None for c in primary), 'null primary key rejected')
                require(all(v is None or type(v) in (str,int,float) for v in r.values()), 'SQLite scalar type invalid')
                require(all(not isinstance(v,float) or math.isfinite(v) for v in r.values()), 'nonfinite number')
                if t in ('trips','charging_sessions'): require(type(r['revision']) is int and r['revision'] >= 1, 'revision invalid')
                db.execute(f'INSERT INTO "{t}" (' + ','.join('"'+c+'"' for c in cols) + ') VALUES (' + ','.join('?' for c in cols) + ')', [r[c] for c in cols])
        require(len(data['system_state']) == 1 and data['system_state'][0]['key'] == 'data_authority' and data['system_state'][0]['value'] == 'CANONICAL', 'only stable canonical authority accepted')
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'backup foreign keys invalid')
        db.commit()
        require(all(rows(db,t) == data[t] for t in TABLES), 'roundtrip scalar equivalence failed')
    except sqlite3.Error as e: raise Invalid('backup relational constraints failed') from e
    finally: db.close()
    return True

def load(path):
    def unique(pairs):
        result = {}
        for k,v in pairs:
            require(k not in result, 'duplicate JSON key'); result[k] = v
        return result
    return json.loads(pathlib.Path(path).read_text(), object_pairs_hook=unique)
def write_new(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd,'wb') as f:
        f.write(content); f.flush(); os.fsync(f.fileno())
def restore(body, target):
    verify(body) # no file created until fully validated
    target = pathlib.Path(target)
    require(target.suffix == '.sqlite' and not str(target).startswith(('http:','https:','file:')), 'only fresh local .sqlite target accepted')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.close(fd)
    try:
        db = sqlite3.connect(target)
        initialize(db)
        db.execute('PRAGMA foreign_keys=ON'); db.execute('BEGIN'); db.execute('PRAGMA defer_foreign_keys=ON')
        db.execute('DELETE FROM system_state')
        for t in TABLES:
            cols = columns(db,t)
            for r in body['collections'][t]:
                db.execute(f'INSERT INTO "{t}" ('+','.join('"'+c+'"' for c in cols)+') VALUES ('+','.join('?' for c in cols)+')',[r[c] for c in cols])
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'restore foreign keys invalid')
        require(all(rows(db,t) == body['collections'][t] for t in TABLES), 'restore equivalence failed')
        db.commit(); db.close()
    except BaseException:
        if 'db' in locals(): db.close()
        target.unlink(missing_ok=True)
        raise
    return {'status':'PASS','target':str(target.resolve()),'authority':'CANONICAL','network_operations':0}
def main():
    parser = argparse.ArgumentParser(description=__doc__); commands = parser.add_subparsers(dest='command',required=True)
    p = commands.add_parser('export'); p.add_argument('source'); p.add_argument('output'); p.add_argument('--source-id',required=True); p.add_argument('--app-version',required=True)
    p = commands.add_parser('verify'); p.add_argument('backup')
    p = commands.add_parser('restore'); p.add_argument('backup'); p.add_argument('fresh_target')
    args = parser.parse_args()
    if args.command == 'export':
        body = export(args.source,args.source_id,args.app_version); write_new(args.output,canonical(body)+b'\n'); print('PASS: backup created')
    elif args.command == 'verify': verify(load(args.backup)); print('PASS: checksums, schema, constraints and equivalence')
    else: print(json.dumps(restore(load(args.backup),args.fresh_target)))
if __name__ == '__main__': main()
