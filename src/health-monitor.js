'use strict';
// Diagnostic only: probes this process over loopback and logs no request/user data.
const http=require('node:http');
function startLocalHealthProbe({port=process.env.PORT||3000,intervalMs=30000,log=console.log}={}){
 if(process.env.MAVI_DIAGNOSTICS==='0')return {stop(){}};
 let pending=null,stopped=false;
 function check(){
  if(stopped||pending)return;
  const start=process.hrtime.bigint();let finished=false;
  function finish(code){if(finished)return;finished=true;pending=null;if(stopped)return;const ms=Math.round(Number(process.hrtime.bigint()-start)/1e6);try{log('[mavi-local-health] '+JSON.stringify({timestamp:new Date().toISOString(),http_status:code,duration_ms:ms}))}catch{}}
  try{pending=http.get({hostname:'127.0.0.1',port,path:'/healthz',agent:false,timeout:3000},r=>{r.resume();r.on('end',()=>finish(r.statusCode));r.on('error',()=>finish(0))});pending.on('timeout',()=>pending?.destroy());pending.on('error',()=>finish(0));}catch{finish(0)}
 }
 const timer=setInterval(check,intervalMs);timer.unref();
 return {stop(){stopped=true;clearInterval(timer);if(pending)pending.destroy();}};
}
module.exports={startLocalHealthProbe};
