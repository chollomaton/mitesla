// A19 (FASE A, auditoría externa 2026-09-20): verificar que los assets estáticos que index.html/
// manifest.webmanifest/sw.js referencian EXISTEN DE VERDAD en el repositorio y se sirven con 200 —
// nunca se da por hecho que "deben estar ahí" sin comprobarlo. Cada ruta de este test se ha
// extraído literalmente de los ficheros que la referencian (ver comentarios), no de memoria.
const { PROJECT_ROOT } = require('./helpers/browser');
const http = require('http');
const fs = require('fs');
const path = require('path');

const dir = PROJECT_ROOT;
const server = http.createServer((req, res) => {
  const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(p);
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// Rutas referenciadas por manifest.webmanifest (icons[].src) y sw.js (APP_SHELL).
const RUTAS = [
  '/index.html',
  '/manifest.webmanifest',
  '/sw.js',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/images/marker-icon.png',
  '/vendor/leaflet/images/marker-icon-2x.png',
  '/vendor/leaflet/images/marker-shadow.png',
  '/vendor/leaflet/images/layers.png',
  '/vendor/leaflet/images/layers-2x.png'
];

async function fetchStatus(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0));
  });
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  let fallos = 0;

  for (const ruta of RUTAS) {
    const status = await fetchStatus('http://localhost:' + port + ruta);
    const ok = status === 200;
    console.log((ok ? '✅' : '❌ FALLO:') + ' ' + ruta + ' -> HTTP ' + status + (ok ? '' : ' (se esperaba 200: el asset no existe realmente en el repositorio o no se sirve)'));
    if (!ok) fallos++;
  }

  // manifest.webmanifest: id/scope/start_url coherentes con un despliegue bajo subruta (A20) —
  // se verifica el JSON real servido, no una copia hardcodeada en el test.
  const manifestTexto = fs.readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8');
  const manifest = JSON.parse(manifestTexto);
  const idEsAbsolutoDesdeRaiz = typeof manifest.id === 'string' && manifest.id.startsWith('/') && !manifest.id.startsWith('//');
  console.log((!idEsAbsolutoDesdeRaiz ? '✅' : '❌ FALLO:') + ' manifest.webmanifest "id" (' + manifest.id + ') no es una ruta absoluta desde la raíz del origen (rompería la identidad de la app si se despliega bajo una subruta, p.ej. github.io/mitesla/)');
  if (idEsAbsolutoDesdeRaiz) fallos++;

  const iconoMaskable = (manifest.icons || []).find((i) => (i.purpose || '').indexOf('maskable') !== -1);
  console.log((iconoMaskable ? '✅' : '❌ FALLO:') + ' el manifest declara al menos un icono con purpose "maskable"');
  if (!iconoMaskable) fallos++;

  server.close();
  console.log('\n' + (fallos === 0 ? 'TODO OK — assets estáticos reales verificados por HTTP (A19/A20)' : fallos + ' fallo(s).'));
  process.exit(fallos === 0 ? 0 : 1);
})();
