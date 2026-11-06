'use strict';
const assert=require('assert'), fs=require('fs'), os=require('os'), path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mavi-auth-test-'));
process.env.DB_PATH=path.join(dir,'test.db');
const oldInterval=global.setInterval, oldNow=Date.now;let sweep,now=1_700_000_000_000;
global.setInterval=(fn,ms)=>{assert.equal(ms,60000);sweep=fn;return {unref(){}}};Date.now=()=>now;
const A=require('../src/auth');global.setInterval=oldInterval;
try{
 for(let i=0;i<6;i++){assert(!A.throttled('locked'));A.noteFailure('locked')}
 assert(A.throttled('locked'),'customer lockout active');
 for(let i=0;i<2047;i++){const key='p'+i;assert(!A.throttled(key));A.noteFailure(key)}
 assert(A.throttled('new-key'),'capacity fails closed');assert(A.throttled('locked'),'existing lockout not evicted');
 for(let i=0;i<8;i++){assert(!A.adminThrottled('owner'));A.adminFailure('owner')}
 assert(A.adminThrottled('owner'));
 for(let i=0;i<2047;i++){const key='e'+i;assert(!A.adminThrottled(key));A.adminFailure(key)}
 assert(A.adminThrottled('new-owner'));assert(A.adminThrottled('owner'));
 now+=16*60*1000;sweep();assert(!A.throttled('new-key'));assert(!A.throttled('locked'));assert(!A.adminThrottled('new-owner'));assert(!A.adminThrottled('owner'));
 console.log('Lockout, capacity, non-eviction and timed cleanup: passed');
} finally {Date.now=oldNow;require('../src/db').db.close();fs.rmSync(dir,{recursive:true,force:true});}
