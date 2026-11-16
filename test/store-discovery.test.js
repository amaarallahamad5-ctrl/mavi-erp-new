'use strict';
const assert=require('assert');
const express=require('express');
const app=express();
const rows=[{id:'DRESS1',name:'زمرد'},{id:'DRESS2',name:'<script>alert(1)</script>'}];
app.use(require('../src/store-search-pages')({get:()=>null,all:(sql)=>sql.includes('SELECT id,name FROM styles')?rows:[]}));
const server=app.listen(0,'127.0.0.1',async()=>{
 try {
  const base='http://127.0.0.1:'+server.address().port;
  const r=await fetch(base+'/store/'); const html=await r.text();
  assert.equal(r.status,200); assert.equal(r.headers.get('cache-control'),'no-store');
  assert(html.includes('href="/store/product/DRESS1">زمرد</a>'));
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert(!html.includes('<script>alert(1)</script>'));
  assert(html.includes('function catView()')); assert(html.includes('boot();'));
  const second=await fetch(base+'/store/?product=DRESS1'); assert.equal(second.status,200);
  console.log('PASS: initial HTML product links, escaping, interactive code and query route');
 }catch(e){console.error(e);process.exitCode=1}finally{server.close()}
});
