'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ColaPersistente}=require('./lib/cola');
const {crearSeguimientoTransiciones,actualizarEstado,actualizarSeguimientoTransiciones,confirmarTransiciones}=require('./lib/normalizador');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mitesla-synthetic-'));
let checks=0;const check=(a,b,label)=>{assert.deepEqual(a,b,label);console.log('PASS '+label);checks++};
try {
 for(const [kind,field,active,closed,start,end]of [['trip','Gear','D','P','trip_started','trip_finished'],['charge','ChargeState','Charging','Complete','charge_started','charge_stopped']]) {
  const file=path.join(dir,kind+'.jsonl'),vin='5YJYGDEE1MF000001';let queue=new ColaPersistente(file),state={},tracking=crearSeguimientoTransiciones();
  const at=Date.parse('2026-10-08T10:00:00Z');
  state=actualizarEstado(state,field,{valor:active,invalido:false},new Date(at).toISOString());tracking=actualizarSeguimientoTransiciones(tracking,state,at);
  queue.confirmarEstado({vin,estadoActual:state,seguimiento:tracking});
  queue=new ColaPersistente(file);let restored=queue.checkpoint;
  check(restored.seguimiento[ kind==='trip'?'conduccion':'carga'].candidato,active,kind+' candidate recovers');
  const opened=confirmarTransiciones(vin,restored.seguimiento,restored.estadoActual,at+1000,{debounceMs:1});
  check(opened.eventos.map(e=>e.tipo),[start],kind+' recovered candidate opens once');
  const rename=fs.renameSync;fs.renameSync=()=>{throw Error('synthetic disk failure before atomic rename')};
  assert.throws(()=>queue.confirmarEstado({vin,estadoActual:state,seguimiento:opened.seguimiento},opened.eventos));checks++;
  fs.renameSync=rename;queue=new ColaPersistente(file);restored=queue.checkpoint;
  check(queue.tamano,0,kind+' failed disk commit adds no events');
  check(restored.seguimiento[ kind==='trip'?'conduccion':'carga'].confirmado,undefined,kind+' failed commit does not confirm opening');
  queue.confirmarEstado({vin,estadoActual:state,seguimiento:opened.seguimiento},opened.eventos);
  queue=new ColaPersistente(file);restored=queue.checkpoint;
  check(queue.peekBatch().map(e=>e.tipo),[start],kind+' state and opening recovered together');
  check(confirmarTransiciones(vin,restored.seguimiento,restored.estadoActual,at+2000,{debounceMs:1}).eventos,[],kind+' restart does not emit duplicate start');
  fs.renameSync=()=>{throw Error('synthetic disk failure before ACK rename')};
  assert.throws(()=>queue.ack(opened.eventos.map(e=>e.id)));checks++;fs.renameSync=rename;
  check(queue.tamano,1,kind+' failed ACK retains pending opening in memory');
  check(new ColaPersistente(file).tamano,1,kind+' failed ACK retains pending opening on disk');
  queue.ack(opened.eventos.map(e=>e.id));queue=new ColaPersistente(file);restored=queue.checkpoint;
  check(queue.tamano,0,kind+' ack recovers without pending events');
  check(confirmarTransiciones(vin,restored.seguimiento,restored.estadoActual,at+2000,{debounceMs:1}).eventos,[],kind+' confirmed active state survives ack');
  state=actualizarEstado(state,field,{valor:closed,invalido:false},new Date(at+3000).toISOString());tracking=actualizarSeguimientoTransiciones(restored.seguimiento,state,at+3000);
  queue.confirmarEstado({vin,estadoActual:state,seguimiento:tracking});queue=new ColaPersistente(file);restored=queue.checkpoint;
  const ended=confirmarTransiciones(vin,restored.seguimiento,restored.estadoActual,at+4000,{debounceMs:1});
  check(ended.eventos.map(e=>e.tipo),[end],kind+' closing candidate recovers');
  queue.confirmarEstado({vin,estadoActual:state,seguimiento:ended.seguimiento},ended.eventos);queue=new ColaPersistente(file);
  check(queue.peekBatch().map(e=>e.tipo),[end],kind+' durable closure recovers');
  queue.ack(ended.eventos.map(e=>e.id));queue=new ColaPersistente(file);restored=queue.checkpoint;
  check(confirmarTransiciones(vin,restored.seguimiento,restored.estadoActual,at+5000,{debounceMs:1}).eventos,[],kind+' closed state never emits duplicate end');
  check(fs.statSync(file).mode&0o777,0o600,kind+' state file permissions');
 }
 console.log(`${checks}/${checks} bridge recovery assertions PASS`);
}finally{fs.rmSync(dir,{recursive:true,force:true})}
