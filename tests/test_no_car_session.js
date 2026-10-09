const assert=require('node:assert/strict');
const {lanzarChromium,urlIndexHtml}=require('./helpers/browser');
(async()=>{
 const browser=await lanzarChromium();
 try{for(const viewport of [{width:390,height:844},{width:1440,height:900},{width:1200,height:800}]){
 const page=await browser.newPage({viewport});const calls=[];const token='s'.repeat(43);
 await page.route('https://api.laperestronika.com/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;calls.push(path);
 if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'POST,GET'}});return;}
 if(path==='/auth/bootstrap'){assert.equal(req.headers().authorization,'Bearer synthetic-bootstrap');await route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:{session_token:token,expires_at:Date.now()+100000}});}
 else if(path==='/auth/session/revoke')await route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:{ok:true}});
 else if(path==='/estado')await route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:{conectado:false}});
 else await route.fulfill({status:401,json:{error:'unauthorized'}});
 });
 await page.goto(urlIndexHtml());assert.match(await page.textContent('#pill-texto'),/Sin vehículo/);await page.evaluate(()=>mostrar('ajustes'));
 await page.fill('#tesla-backend-url','https://api.laperestronika.com');await page.fill('#mitesla-bootstrap-key','synthetic-bootstrap');
 await page.click('#mitesla-session-create');await page.waitForFunction(()=>document.getElementById('mitesla-session-status').textContent.includes('activa'));
 assert.equal(await page.inputValue('#mitesla-bootstrap-key'),'');
 const stored=await page.evaluate(()=>({local:JSON.stringify(localStorage),session:JSON.stringify(sessionStorage)}));
 assert(!stored.local.includes(token));assert(!stored.local.includes('synthetic-bootstrap'));assert(!stored.session.includes('synthetic-bootstrap'));assert(stored.session.includes(token));
 await page.evaluate(()=>getTeslaConnectionStatus(true));assert.match(await page.textContent('#tesla-estado'),/Sin Tesla conectado/);
 for(const tab of ['dashboard','viajes','cargas','ajustes'])await page.evaluate(t=>mostrar(t),tab);
 assert(!calls.some(p=>/oauth|vehiculos|vehicles|vehicle_data|comando/.test(p)));
 await page.evaluate(()=>cerrarSesionMiTesla());assert.equal(await page.evaluate(()=>cargarConfigTesla().sessionToken),'');
 await page.close();
 }console.log('PASS bootstrap, ephemeral admin, sessionStorage, no-car navigation, logout: 3 viewports');}
 finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
