const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());

  const out = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }

    // 1) id malicioso se sanea
    {
      var bruto = { viajes:[{ id:'x"><img src=x onerror=alert(1)>', fecha:'2026-01-01T10:00', origen:'A', destino:'B', km:5 }], cargas:[], gastos:[] };
      var r = sanearImportacion(bruto);
      var id = r.datos.viajes[0].id;
      assert(ID_SEGURO.test(id), 'id malicioso se sustituye por uno seguro: '+id);
    }

    // 2) objeto donde se espera texto -> no explota, se convierte a string vacío
    {
      var bruto = { viajes:[{ id:'v1', fecha:'2026-01-01T10:00', origen:{malicioso:true}, destino:'B', km:5 }], cargas:[], gastos:[] };
      var r = sanearImportacion(bruto);
      assert(typeof r.datos.viajes[0].origen === 'string', 'un objeto donde se esperaba texto se convierte a string seguro');
    }

    // 3) porcentaje fuera de rango (120) se descarta el campo -> null en vez de valor inválido
    {
      var bruto = { viajes:[{ id:'v1', fecha:'2026-01-01T10:00', origen:'A', destino:'B', km:5, bateria_inicial:120 }], cargas:[], gastos:[] };
      var r = sanearImportacion(bruto);
      assert(r.datos.viajes[0].bateria_inicial === null, 'un porcentaje de batería de 120 se descarta (no se deja un valor imposible)');
    }

    // 4) tipo de carga no válido -> se normaliza a "otros"
    {
      var bruto = { viajes:[], cargas:[{ id:'c1', fecha:'2026-01-01T10:00', lugar:'X', tipo:'<script>', kwh:10 }], gastos:[] };
      var r = sanearImportacion(bruto);
      assert(r.datos.cargas[0].tipo === 'otros', 'un tipo de carga no reconocido se normaliza a "otros"');
    }

    // 5) elemento sin campos obligatorios se descarta y se cuenta
    {
      var bruto = { viajes:[{ id:'v1' /* sin km */ }], cargas:[], gastos:[] };
      var r = sanearImportacion(bruto);
      assert(r.datos.viajes.length === 0 && r.rechazados === 1, 'un viaje sin km se descarta y se cuenta como rechazado');
    }

    // 6) tope de elementos por colección
    {
      var muchos = []; for(var i=0;i<20005;i++) muchos.push({id:'v'+i, fecha:'2026-01-01T10:00', origen:'A', destino:'B', km:1});
      var bruto = { viajes:muchos, cargas:[], gastos:[] };
      var r = sanearImportacion(bruto);
      assert(r.datos.viajes.length === 20000, 'se respeta el tope máximo de elementos por colección (20000)');
    }

    // 7) validarFormaDatos rechaza algo que no es un objeto de Mi Tesla
    {
      var problemas = validarFormaDatos({ viajes: 'no soy una lista' });
      assert(problemas.length > 0, 'validarFormaDatos detecta un campo con el tipo equivocado');
    }

    return res;
  });
  out.forEach(l => console.log(l));
  const fallos = out.filter(l => l.indexOf('FALLO')!==-1).length;

  // 409 retry test: mock fetch para simular un 409 seguido de éxito
  const out2 = await page.evaluate(async () => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    guardarConfigGithub({ repo:'user/repo', path:'datos.json', token:'tok123' });
    document.getElementById('gh-repo').value='user/repo';
    document.getElementById('gh-path').value='datos.json';
    document.getElementById('gh-token').value='tok123';

    var llamadasPut = 0;
    var origFetch = window.fetch;
    window.fetch = async function(url, opts){
      var u = String(url);
      if(u.indexOf('api.github.com/repos/user/repo/contents')!==-1 && (!opts || opts.method!=='PUT')){
        var contenido = btoa(JSON.stringify(DATOS));
        return new Response(JSON.stringify({ sha:'sha-actual', encoding:'base64', content: btoa(unescape(encodeURIComponent(JSON.stringify(DATOS)))) }), { status:200 });
      }
      if(u.indexOf('api.github.com/repos/user/repo/contents')!==-1 && opts.method==='PUT'){
        llamadasPut++;
        if(llamadasPut === 1) return new Response('conflict', { status:409 });
        return new Response(JSON.stringify({ content:{ sha:'sha-nuevo' } }), { status:200 });
      }
      if(u.indexOf('api.github.com/repos/user/repo')!==-1){
        return new Response(JSON.stringify({ private:false }), { status:200 });
      }
      return origFetch(url, opts);
    };
    await sincronizarGithub({ silencioso:false });
    assert(llamadasPut === 2, 'un 409 en el PUT provoca un reintento automático (llamadas PUT: '+llamadasPut+')');
    assert(localStorage.getItem('mitesla-sync-pending') !== '1', 'tras el reintento con éxito no queda sync_pending activo');
    assert(localStorage.getItem('mitesla-repo-publico') === '1', 'se detecta que el repositorio es público');

    window.fetch = origFetch;
    return res;
  });
  out2.forEach(l => console.log(l));
  const fallos2 = out2.filter(l => l.indexOf('FALLO')!==-1).length;

  console.log('\nTotal fallos:', fallos+fallos2);
  console.log('PAGE ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit((fallos+fallos2)===0 ? 0 : 1);
})();
