'use strict';
const assert=require('assert');const {startDiagnostics}=require('../src/diagnostics');
const wait=n=>new Promise(r=>setTimeout(r,n));
(async()=>{
 const logs=[];const d=startDiagnostics({intervalMs:100,log:x=>logs.push(x)});
 await wait(350);d.stop();assert(logs.length>=2);
 for(const x of logs){assert(x.startsWith('[mavi-diagnostics] '));const o=JSON.parse(x.slice('[mavi-diagnostics] '.length));assert.deepStrictEqual(Object.keys(o).sort(),['event_loop_max_ms','event_loop_p99_ms','external_mib','heap_total_mib','heap_used_mib','rss_mib','timestamp','uptime_s'].sort());assert(o.rss_mib>0);for(const [k,v] of Object.entries(o))if(k!=='timestamp')assert(Number.isFinite(v)&&v>=0);}
 const before=logs.length;await wait(150);assert.equal(logs.length,before);
 process.env.MAVI_DIAGNOSTICS='0';startDiagnostics({intervalMs:10,log:x=>logs.push(x)});await wait(40);assert.equal(logs.length,before);
 console.log('Diagnostic samples contain only expected numeric process metrics; stop and opt-out pass.');
})().catch(e=>{console.error(e);process.exitCode=1});
