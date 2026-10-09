const assert=require('node:assert/strict');
const {lanzarChromium,urlIndexHtml}=require('./helpers/browser');
(async()=>{const browser=await lanzarChromium();try{
 for(const [name,viewport] of [['iphone',{width:390,height:844}],['desktop',{width:1440,height:900}],['tesla',{width:1920,height:1080}]]){
 const page=await browser.newPage({viewport});const errors=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route(/^https?:/,route=>{calls.push(route.request().url());return route.abort()});
 await page.goto(urlIndexHtml());
 if(name==='tesla'){await page.evaluate(()=>mostrar('ajustes'));await page.selectOption('#presentation-mode','coche');await page.reload();}
 const nav=name==='tesla'?'.nav-coche':name==='desktop'?'.nav-escritorio':'.nav';
 await page.locator(nav+' button[data-vista="dashboard"]').click();
 assert(await page.locator('#no-car-welcome').isVisible());
 assert(await page.locator('#tesla-conectar').isDisabled());
 assert.match(await page.textContent('#dash-bateria-num'),/^—/);
 for(const view of ['viajes','cargas','ajustes','dashboard']){
   if(name==='iphone' && view==='ajustes'){await page.locator(nav+' button[data-vista="mas"]').click();await page.locator('#lista-mas [data-vista="ajustes"]').click();}
   else await page.locator(nav+' button[data-vista="'+view+'"]').click();
   assert(await page.locator('#vista-'+view).isVisible());
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' '+view+' overflow');
 }
 const sizes=await page.locator(nav+' button').evaluateAll(bs=>bs.map(b=>b.getBoundingClientRect().height));
 assert(sizes.every(h=>h>=(name==='tesla'?64:44)));
 await page.evaluate(()=>mostrar('ajustes'));
 assert(!(await page.locator('#tesla-session-token').isVisible()));
 assert(await page.locator('#mitesla-session-create').isVisible());
 await page.context().setOffline(true);await page.waitForFunction(()=>!document.getElementById('network-status').hidden);
 await page.context().setOffline(false);await page.waitForFunction(()=>document.getElementById('network-status').hidden);
 await page.evaluate(()=>mostrar('dashboard'));
 await page.waitForTimeout(400);
 await page.screenshot({path:require('path').resolve(__dirname,'../../../outputs/polish-'+name+'.png'),fullPage:true});
 assert(!calls.some(u=>/vehicles|vehiculo|oauth|vehicle_data|command/.test(u)),JSON.stringify(calls));assert.deepEqual(errors,[]);
 console.log('PASS '+name+': navigation, persistent mode, empty state, targets, overflow, diagnostics, offline, zero Tesla requests');await page.close();
 }
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
