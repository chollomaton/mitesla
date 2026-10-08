const cache = new WeakMap();
export async function tokenHash(token) {
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
 return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function sessionAuthentication(request,env) {
 if(cache.has(request))return cache.get(request);
 const promise=(async()=>{
  if(!env.DB?.prepare)return {ok:false,status:503,error:'session_backend_invalid'};
  const m=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization')||'');
  if(!m)return {ok:false,status:401,error:'unauthorized'};
  try {
   const hash=await tokenHash(m[1]),now=Date.now();
   const row=await env.DB.prepare('SELECT id,expires_at,revoked_at FROM sessions WHERE token_hash=?').bind(hash).first();
   if(!row || row.revoked_at!==null || row.expires_at<=now)return {ok:false,status:401,error:'unauthorized'};
   await env.DB.prepare('UPDATE sessions SET last_used_at=? WHERE id=? AND revoked_at IS NULL AND expires_at>? AND (last_used_at IS NULL OR last_used_at<?)').bind(now,row.id,now,now-300000).run();
   return {ok:true,status:200,id:row.id};
  }catch{return {ok:false,status:503,error:'session_backend_invalid'}}
 })();cache.set(request,promise);return promise;
}
export async function bootstrap(request,env,adminAuthentication) {
 const auth=adminAuthentication(request,env);
 if(!auth.ok)return Response.json({error:auth.error},{status:auth.status});
 if(request.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405});
 if(!env.DB?.prepare)return Response.json({error:'session_backend_invalid'},{status:503});
 let body;try{body=await request.json()}catch{return Response.json({error:'invalid_body'},{status:400})}
 if(!body || typeof body!=='object' || (body.device_label!==undefined && typeof body.device_label!=='string'))return Response.json({error:'invalid_body'},{status:400});
 const device_label=(body.device_label||'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,80);
 const token=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const id=crypto.randomUUID(),now=Date.now(),expires=now+90*86400000;
 try{await env.DB.prepare('INSERT INTO sessions(id,token_hash,created_at,expires_at,device_label) VALUES(?,?,?,?,?)').bind(id,await tokenHash(token),now,expires,device_label).run()}
 catch{return Response.json({error:'session_backend_invalid'},{status:503})}
 return Response.json({session_token:token,id,expires_at:expires},{headers:{'Cache-Control':'no-store','Pragma':'no-cache'}});
}
export async function revoke(request,env){
 const auth=await sessionAuthentication(request,env);
 if(!auth.ok)return Response.json({error:auth.error},{status:auth.status});
 if(request.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405});
 try{await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(Date.now(),auth.id).run();return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}})}catch{return Response.json({error:'session_backend_invalid'},{status:503})}
}
