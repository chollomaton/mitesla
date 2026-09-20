function hexToRgb(h){ h=h.replace('#',''); if(h.length===3) h=h.split('').map(c=>c+c).join(''); const n=parseInt(h,16); return [n>>16&255,n>>8&255,n&255]; }
function luminance([r,g,b]){ const f=c=>{c/=255; return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4)}; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); }
function contrast(c1,c2){ let l1=luminance(c1), l2=luminance(c2); if(l1<l2)[l1,l2]=[l2,l1]; return (l1+0.05)/(l2+0.05); }
const checks = [
  ['txt3 claro sobre elev', '#747479', '#ffffff', 4.5],
  ['ok claro sobre elev', '#24864a', '#ffffff', 4.5],
  ['warn claro sobre elev', '#a96412', '#ffffff', 4.5],
  ['acc2-txt claro sobre elev', '#0065cc', '#ffffff', 4.5],
];
let fallos = 0;
checks.forEach(([name, fg, bg, min]) => {
  const r = contrast(hexToRgb(fg), hexToRgb(bg));
  const ok = r >= min;
  if(!ok) fallos++;
  console.log((ok?'✅ ':'❌ FALLO: ')+name+': '+r.toFixed(2)+' (mínimo '+min+')');
});
process.exit(fallos ? 1 : 0);
