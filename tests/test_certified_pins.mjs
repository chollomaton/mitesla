import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
const pins=JSON.parse(readFileSync(new URL('backend/SOURCE-PINS.json',root)));
for(const [file,hash] of Object.entries(pins))assert.equal(createHash('sha256').update(readFileSync(new URL(file,root))).digest('hex'),hash,file);
for(const file of Object.keys(pins).filter(x=>x.startsWith('d1/migrations/')))assert.deepEqual(readFileSync(new URL(file,root)),readFileSync(new URL(file.replace('d1/','tools/backup/'),root)),file);
console.log(`PASS ${Object.keys(pins).length} runtime/schema pins, 9 deployment/backup migration byte comparisons`);
