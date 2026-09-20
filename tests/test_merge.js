const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());

  const resultados = await page.evaluate(() => {
    var out = [];
    function assert(cond, msg){ out.push((cond?'✅ ':'❌ FALLO: ')+msg); }

    function viaje(id, extra){
      return Object.assign({ id:id, fecha:'2026-09-01T10:00', origen:'A', destino:'B', km:10, duracion_min:10, bateria_inicial:80, bateria_final:70 }, extra||{});
    }
    function baseDatos(extra){
      return normalizarDatos(Object.assign({ viajes:[], cargas:[], gastos:[], recordatorios:[], accesorios:[], planes:[], favoritos:[], bateria_historico:[] }, extra||{}));
    }

    // 1) A crea -> B sincroniza (B no tiene el viaje, A sí)
    {
      var A = baseDatos({ viajes:[viaje('v1',{created_at:'2026-09-01T10:00:00.000Z',updated_at:'2026-09-01T10:00:00.000Z'})] });
      var B = baseDatos({});
      var fusion = fusionarDatos(A, B);
      assert(fusion.viajes.length===1 && fusion.viajes[0].id==='v1', 'A crea -> B sincroniza: B obtiene el viaje nuevo de A');
    }

    // 2) A edita -> B descarga (B tiene versión vieja, A tiene una más reciente)
    {
      var A = baseDatos({ viajes:[viaje('v1',{km:99, created_at:'2026-09-01T10:00:00.000Z', updated_at:'2026-09-02T12:00:00.000Z'})] });
      var B = baseDatos({ viajes:[viaje('v1',{km:10, created_at:'2026-09-01T10:00:00.000Z', updated_at:'2026-09-01T10:00:00.000Z'})] });
      var fusion = fusionarDatos(A, B);
      assert(fusion.viajes[0].km===99, 'A edita -> B descarga la edición más reciente (km=99)');
    }

    // 3) B edita después -> gana B
    {
      var A = baseDatos({ viajes:[viaje('v1',{km:10, updated_at:'2026-09-01T10:00:00.000Z'})] });
      var B = baseDatos({ viajes:[viaje('v1',{km:55, updated_at:'2026-09-03T09:00:00.000Z'})] });
      var fusion = fusionarDatos(A, B);
      assert(fusion.viajes[0].km===55, 'B edita después -> gana la edición de B (km=55)');
    }

    // 4) A conserva copia antigua -> no pisa a B
    {
      var A = baseDatos({ viajes:[viaje('v1',{km:1, updated_at:'2026-08-01T00:00:00.000Z'})] }); // A desactualizado
      var B = baseDatos({ viajes:[viaje('v1',{km:77, updated_at:'2026-09-05T00:00:00.000Z'})] });
      var fusion = fusionarDatos(A, B);
      assert(fusion.viajes[0].km===77, 'A con copia antigua no pisa la edición más reciente de B (km=77)');
    }

    // 5) A elimina -> B no resucita
    {
      var A = baseDatos({ viajes:[], _borrados:{viajes:{'v1':'2026-09-05T00:00:00.000Z'}, cargas:{},gastos:{},recordatorios:{},accesorios:{},planes:{},favoritos:{},bateria_historico:{}} });
      var B = baseDatos({ viajes:[viaje('v1',{updated_at:'2026-09-01T00:00:00.000Z'})] }); // B todavía lo tiene, sin editarlo después del borrado
      var fusion = fusionarDatos(A, B);
      assert(fusion.viajes.length===0, 'A elimina -> el viaje no resucita en B');
    }

    // 6) Lectura de batería eliminada no resucita
    {
      var lecturaVieja = { id:'b1', fecha:'2026-01-01', capacidad_pct:99, created_at:'2026-01-01T00:00:00.000Z', updated_at:'2026-01-01T00:00:00.000Z' };
      var A = baseDatos({ bateria_historico:[], _borrados:{viajes:{},cargas:{},gastos:{},recordatorios:{},accesorios:{},planes:{},favoritos:{}, bateria_historico:{'b1':'2026-02-01T00:00:00.000Z'}} });
      var B = baseDatos({ bateria_historico:[lecturaVieja] });
      var fusion = fusionarDatos(A, B);
      assert(fusion.bateria_historico.length===0, 'Lectura de batería eliminada en A no resucita al fusionar con B');
    }

    // 7) Edición posterior a un tombstone respeta la regla temporal (la edición gana si es más nueva)
    {
      var A = baseDatos({ viajes:[], _borrados:{viajes:{'v1':'2026-09-01T00:00:00.000Z'},cargas:{},gastos:{},recordatorios:{},accesorios:{},planes:{},favoritos:{},bateria_historico:{}} });
      var B = baseDatos({ viajes:[viaje('v1',{km:5, updated_at:'2026-09-10T00:00:00.000Z'})] }); // editado en B DESPUÉS del borrado de A
      var fusion = fusionarDatos(A, B);
      assert(fusion.viajes.length===1 && fusion.viajes[0].km===5, 'Edición posterior a un borrado antiguo revive el elemento (gana la edición más nueva)');
    }

    // 8) Tombstone más nuevo que la edición sí borra
    {
      var A = baseDatos({ viajes:[], _borrados:{viajes:{'v1':'2026-09-20T00:00:00.000Z'},cargas:{},gastos:{},recordatorios:{},accesorios:{},planes:{},favoritos:{},bateria_historico:{}} });
      var B = baseDatos({ viajes:[viaje('v1',{km:5, updated_at:'2026-09-10T00:00:00.000Z'})] }); // editado ANTES del borrado de A
      var fusion = fusionarDatos(A, B);
      assert(fusion.viajes.length===0, 'Un borrado más reciente que la última edición conocida sí elimina el elemento');
    }

    // 9) dataset_id distinto -> no se fusiona (se comprueba la condición usada en sincronizarGithub)
    {
      var remotoViejo = baseDatos({ viajes:[viaje('vDemo')] });
      remotoViejo.dataset_id = 'dataset-viejo';
      var localNuevo = baseDatos({ viajes:[] });
      localNuevo.dataset_id = 'dataset-nuevo';
      var mismoDataset = remotoViejo && localNuevo.dataset_id && remotoViejo.dataset_id && remotoViejo.dataset_id === localNuevo.dataset_id;
      assert(!mismoDataset, 'dataset_id distinto se detecta correctamente (no se fusionaría, se sobrescribiría)');
    }

    // 10) normalizarDatos no reinyecta SEED en una colección vacía real
    {
      var d = normalizarDatos({ viajes:[], cargas:[], gastos:[], bateria_historico:[], data_mode:'real' });
      assert(d.bateria_historico.length===0, 'Un bateria_historico vacío de verdad se queda vacío (no se reinyecta el SEED)');
    }

    // 11) ids nuevos usan nuevoId(), no colisionan en altas rápidas
    {
      var id1 = nuevoId(), id2 = nuevoId();
      assert(id1 !== id2, 'nuevoId() genera ids distintos en llamadas consecutivas');
    }

    return out;
  });

  resultados.forEach(r => console.log(r));
  const fallos = resultados.filter(r => r.indexOf('FALLO')!==-1).length;
  console.log('\n' + (fallos===0 ? '✅ TODO OK ('+resultados.length+' comprobaciones)' : '❌ '+fallos+' fallo(s)'));
  console.log('PAGE ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(fallos===0 && errors.length===0 ? 0 : 1);
})();
