const assert=require('node:assert/strict');
const {lanzarChromium,urlIndexHtml}=require('./helpers/browser');
(async()=>{const b=await lanzarChromium();try{const p=await b.newPage({viewport:{width:390,height:844}});let status=401;
 await p.route('https://api.laperestronika.com/**',r=>r.request().method()==='OPTIONS'?r.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type'}}):r.fulfill({status,headers:{'Access-Control-Allow-Origin':'*'},json:{error:'synthetic'}}));
 await p.goto(urlIndexHtml());await p.evaluate(()=>{guardarConfigTesla({backendUrl:'https://api.laperestronika.com',sessionToken:'s'.repeat(43)});mostrar('ajustes')});
 for(const [code,copy] of [[401,'caducado'],[403,'permiso'],[409,'cambio pendiente'],[429,'Demasiadas'],[500,'temporalmente'],[503,'temporalmente']]){
 status=code;await p.evaluate(()=>getTeslaConnectionStatus(true));assert((await p.textContent('#tesla-estado')).includes(copy),code+': '+await p.textContent('#tesla-estado')+' / '+await p.textContent('#tesla-estado-sub'));assert.equal(await p.evaluate(()=>cargarConfigTesla().sessionToken),'s'.repeat(43));
 }
 await p.unroute('https://api.laperestronika.com/**');await p.route('https://api.laperestronika.com/**',r=>r.abort());await p.evaluate(()=>getTeslaConnectionStatus(true));assert.match(await p.textContent('#tesla-estado-sub'),/Comprueba tu conexión/);
 const timeout=await p.evaluate(async()=>{const original=window.fetch;window.fetch=()=>Promise.reject(Object.assign(Error(),{name:'AbortError'}));try{await fetchMiTeslaConEspera('https://api.laperestronika.com')}catch(e){return e.message}finally{window.fetch=original}});assert.match(timeout,/tarda demasiado/);
 assert(await p.locator('#mitesla-session-create').isEnabled());
 await p.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await p.evaluate(()=>mostrar('dashboard'));await p.screenshot({path:require('path').resolve(__dirname,'../../../outputs/polish-iphone-dark.png'),fullPage:true});
 await p.evaluate(()=>mostrar('ajustes'));await p.locator('#session-diagnostics summary').focus();await p.keyboard.press('Enter');assert(await p.locator('#tesla-session-token').isVisible());
 console.log('PASS 401/403/409/429/500/503, network failure, timeout copy, data/session preserved, keyboard diagnostics, dark/reduced-motion smoke');
 }finally{await b.close()}})().catch(e=>{console.error(e);process.exit(1)});
