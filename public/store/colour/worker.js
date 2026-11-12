/* Local garment parsing. No photo is sent to a server. */
importScripts('/store/colour/ort.wasm.min.js');
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths='/store/colour/';
let session,loading;
async function modelPart(i){const url='/store/colour/model.part'+i;let cache;try{if(self.caches)cache=await caches.open('mavi-colour-model-v1-2026')}catch(e){}let r;try{if(cache)r=await cache.match(url)}catch(e){}if(!r){r=await fetch(url);if(!r.ok)throw Error('model');if(cache)cache.put(url,r.clone()).catch(()=>{})}return new Uint8Array(await r.arrayBuffer())}
async function load(){if(session)return session;if(loading)return loading;loading=(async()=>{let parts=await Promise.all([0,1,2].map(modelPart));let len=parts.reduce((n,p)=>n+p.length,0),bytes=new Uint8Array(len),at=0;for(let p of parts){bytes.set(p,at);at+=p.length}parts=null;session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});return session})();try{return await loading}catch(e){loading=null;throw e}}
let queue=Promise.resolve();
self.onmessage=e=>{queue=queue.then(()=>run(e)).catch(()=>{});};
async function run(e){const {id,pixels}=e.data;try{const s=await load(),n=320*320,x=new Float32Array(3*n);for(let i=0;i<n;i++){x[i]=pixels[4*i]/127.5-1;x[n+i]=pixels[4*i+1]/127.5-1;x[2*n+i]=pixels[4*i+2]/127.5-1}const tensor=new ort.Tensor('float32',x,[1,3,320,320]);const output=(await s.run({input:tensor})).output;const y=output.data;const mask=new Uint8Array(n);let count=0;for(let i=0;i<n;i++){let max=y[i],k=0;for(let c=1;c<4;c++)if(y[c*n+i]>max){max=y[c*n+i];k=c}if(k){mask[i]=255;count++}}tensor.dispose();output.dispose();self.postMessage({id,mask,count},[mask.buffer])}catch(err){self.postMessage({id,error:String(err&&err.message||err)})}};
