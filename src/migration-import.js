'use strict';
// One-time upload into a NEW database path; the original live database is never opened or replaced.
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');
const Database=require('better-sqlite3');
const MAX=12*1024*1024;
function equal(a,b){return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(),crypto.createHash('sha256').update(b).digest())}
function start(){
 const token=process.env.MAVI_RESTORE_SECRET||'',port=process.env.PORT||3000,dir=path.dirname(process.env.DB_PATH||'/data/mavi.db');
 const dest=path.join(dir,'mavi-restored.db');
 if(Buffer.byteLength(token)<32){console.error('[migration] Set MAVI_RESTORE_SECRET to at least 32 bytes');process.exit(1)}
 let busy=false,attempts=0,windowStart=Date.now();
 const page=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>استعادة MAVI</title><style>body{font-family:Arial;margin:3em auto;max-width:32em;padding:1em;line-height:1.8} input,button{display:block;margin:.8em 0;padding:.8em;max-width:100%}button{background:#382c42;color:white;border:0;border-radius:6px}</style><h1>استعادة نسخة MAVI</h1><p>اختاري ملف النسخة الاحتياطية من جهازك. الملف لا يُرسل إلى GitHub. تأكدي من رابط Suga قبل المتابعة.</p><label>رمز الاستعادة<input id="secret" type="password" autocomplete="off"></label><label>ملف قاعدة البيانات<input id="file" type="file" accept=".db,.sqlite,.sqlite3"></label><button id="go">رفع النسخة وفحصها</button><p id="msg"></p><script>document.getElementById('go').onclick=async()=>{const b=document.getElementById('go'),f=document.getElementById('file').files[0],s=document.getElementById('secret').value,m=document.getElementById('msg');if(!f||!s){m.textContent='اختاري الملف وأدخلي الرمز';return}b.disabled=true;m.textContent='جارٍ الرفع والفحص...';try{let r=await fetch('/import',{method:'POST',headers:{'Authorization':'Bearer '+s,'Content-Type':'application/octet-stream'},body:f,cache:'no-store'});let t=await r.text();m.textContent=r.ok?'تم حفظ النسخة وفحصها. لا تضغطي مرة أخرى؛ ارجعي للتعليمات لتفعيلها.':'لم تكتمل العملية: '+t}catch(e){m.textContent='تعذر الاتصال؛ لا تعيدي المحاولة قبل مراجعة السجلات.'}finally{b.disabled=false}};</script></html>`;
 const server=http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(page)}
  if(req.method!=='POST'||req.url!=='/import'){res.writeHead(404);return res.end('Not found')}
  if(Date.now()-windowStart>600000){attempts=0;windowStart=Date.now()} if(++attempts>12){res.writeHead(429);return res.end('Too many attempts')}
  const header=req.headers.authorization||'';if(!header.startsWith('Bearer ')||!equal(header.slice(7),token)){res.writeHead(403);req.resume();return res.end('Invalid code')}
  if(busy||fs.existsSync(dest)){res.writeHead(409);req.resume();return res.end('Already in progress or destination exists; no changes made')}
  let n=Number(req.headers['content-length']);if(!Number.isSafeInteger(n)||n<512||n>MAX){res.writeHead(413);req.resume();return res.end('Invalid size; maximum 12 MiB')}
  busy=true;let chunks=[],size=0,ended=false;req.on('data',x=>{size+=x.length;if(size>MAX||size>n){ended=true;req.destroy()}else chunks.push(x)});
  req.on('aborted',()=>{busy=false});req.on('error',()=>{busy=false});
  req.on('end',()=>{if(ended){busy=false;return}let tmp=null,db=null;
   try{if(size!==n)throw Error('incomplete upload');fs.mkdirSync(dir,{recursive:true});tmp=path.join(dir,'.mavi-import-'+crypto.randomBytes(16).toString('hex'));fs.writeFileSync(tmp,Buffer.concat(chunks),{flag:'wx',mode:0o600});chunks=[];
    db=new Database(tmp,{readonly:true,fileMustExist:true});db.pragma('query_only = ON');if(db.pragma('integrity_check',{simple:true})!=='ok')throw Error('integrity check failed');
    const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));for(const name of ['users','customers','orders','styles'])if(!names.has(name))throw Error('not a MAVI backup');
    if(db.pragma('foreign_key_check').length)throw Error('foreign key check failed');db.close();db=null;
    fs.linkSync(tmp,dest);fs.unlinkSync(tmp);tmp=null;console.log('[migration] Backup validated and staged as mavi-restored.db');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('ok');
   }catch(e){if(db)try{db.close()}catch{};if(tmp)try{fs.unlinkSync(tmp)}catch{};console.error('[migration] Import rejected:',e.code||'validation_failed');res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});res.end('Invalid file, storage issue, or existing destination; no database replaced.')}finally{busy=false}
  });
 });
 server.requestTimeout=30000;server.headersTimeout=15000;server.listen(port,'0.0.0.0',()=>console.log('[migration] One-time import service listening'));
}
module.exports={start};
