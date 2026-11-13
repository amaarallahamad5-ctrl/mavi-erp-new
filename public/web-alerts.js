/* Optional account notifications, active only for authenticated website users. */
(function(){
 'use strict';
 const realm=location.pathname.startsWith('/admin')?'admin':'store';const base='/api/'+realm+'/web-alerts';const ownerKey='mavi-push-binding-'+realm;const pushScope=realm==='store'?'/store/':'/admin/';
 let current=[],unread=0,open=false,authenticated=false,polling=false;
 const t={ar:{bell:'الإشعارات',empty:'لا توجد إشعارات جديدة بعد.',read:'تحديد الكل كمقروء',enable:'تفعيل إشعارات الجهاز',disable:'إيقاف إشعارات الجهاز',explain:'تنبيهات الجهاز اختيارية، وقد تتأخر حسب المتصفح. التفاصيل داخل حسابك.',off:'تم إيقاف إشعارات الجهاز.',on:'تم تفعيل إشعارات الجهاز.',denied:'الإشعارات غير مسموحة. راجعي إعدادات المتصفح والجهاز.',unsupported:'هذا المتصفح لا يدعم إشعارات الجهاز هنا.',error:'تعذر تفعيل الإشعارات. حاولي مرة أخرى.',loading:'جارٍ التحميل…',view:'عرض الطلبات'},en:{bell:'Notifications',empty:'No notifications yet.',read:'Mark all as read',enable:'Enable device notifications',disable:'Turn off device notifications',explain:'Device alerts are optional and may be delayed. Details are in your account.',off:'Device notifications turned off.',on:'Device notifications enabled.',denied:'Notifications are blocked. Check browser and device settings.',unsupported:'Device notifications are not supported in this browser.',error:'Unable to enable notifications. Please try again.',loading:'Loading…',view:'View orders'}};
 function lang(){return document.documentElement.lang==='en'?'en':'ar'}function text(k){return t[lang()][k]}
 function token(){try{return localStorage.getItem(realm==='admin'?'mavi_admin_token':'mavi_store_token')||''}catch(e){return ''}}
 async function req(path,opt={}){const tk=token();const r=await fetch(base+path,{method:opt.method||'GET',headers:{'Content-Type':'application/json',...(tk?{Authorization:'Bearer '+tk}:{})},credentials:'same-origin',body:opt.body?JSON.stringify(opt.body):undefined,cache:'no-store'});if(!r.ok)throw Object.assign(Error('request'),{status:r.status});return r.json()}
 function from64(v){const s=(v+'='.repeat((4-v.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
 const css=document.createElement('style');css.textContent='.mavi-web-bell{display:inline-flex!important;align-items:center;gap:5px;border:1px solid #cbb79f;border-radius:8px;background:#fffdf9;color:#172b50;padding:8px 10px;font:700 12px Tahoma,Arial;cursor:pointer;min-height:40px}.mavi-web-bell[hidden]{display:none!important}.mavi-web-bell-count{background:#172b50;color:white;border-radius:20px;padding:1px 6px}.mavi-web-panel{position:fixed;z-index:2147482900;top:76px;right:12px;width:min(370px,calc(100vw - 24px));max-height:75vh;overflow:auto;background:#fffdf9;border:1px solid #d9cbbb;border-radius:12px;box-shadow:0 10px 40px #0004;padding:15px;color:#172b50;font:13px/1.6 Tahoma,Arial,sans-serif}.mavi-web-panel[hidden]{display:none}.mavi-web-panel h2{font-size:17px;margin:0 0 8px}.mavi-web-panel p{margin:7px 0}.mavi-web-panel ul{list-style:none;margin:8px 0;padding:0}.mavi-web-panel li{border-top:1px solid #ece5dc;padding:9px 2px}.mavi-web-panel li.unread{font-weight:bold}.mavi-web-panel small{display:block;color:#727982;font-size:11px;direction:ltr}.mavi-web-panel button{border:1px solid #a9967e;background:#fff;color:#172b50;border-radius:6px;padding:8px 10px;margin:4px 3px;cursor:pointer;font:12px Tahoma,Arial}';document.head.appendChild(css);
 const panel=document.createElement('section');panel.className='mavi-web-panel';panel.hidden=true;panel.setAttribute('role','region');document.body.appendChild(panel);
 function bindButton(){
  const host=realm==='store'?document.querySelector('.bt-navtools'):document.querySelector('.app aside .logo');
  if(!host)return;let button=host.querySelector('.mavi-web-bell');if(!button){button=document.createElement('button');button.type='button';button.className='mavi-web-bell';button.addEventListener('click',()=>{open=!open;panel.hidden=!open;renderPanel()});host.appendChild(button)}
  button.hidden=!authenticated;button.setAttribute('aria-label',text('bell')+(unread?' '+unread:''));const label='🔔 '+text('bell')+(unread?' · '+unread:'');if(button.textContent!==label)button.textContent=label;
 }
 function status(p){const s=panel.querySelector('.mavi-web-status');if(s)s.textContent=p}
 function renderPanel(){panel.dir=lang()==='ar'?'rtl':'ltr';panel.replaceChildren();const title=document.createElement('h2');title.textContent=text('bell');panel.appendChild(title);
  const msg=document.createElement('p');msg.textContent=text('explain');panel.appendChild(msg);const list=document.createElement('ul');
  if(!current.length){const li=document.createElement('li');li.textContent=text('empty');list.appendChild(li)}
  for(const x of current){const li=document.createElement('li');if(!x.read)li.className='unread';li.appendChild(document.createTextNode(lang()==='ar'?x.ar:x.en));const small=document.createElement('small');small.textContent=x.created_at+' UTC';li.appendChild(small);list.appendChild(li)}panel.appendChild(list);
  const mark=document.createElement('button');mark.type='button';mark.textContent=text('read');mark.addEventListener('click',async()=>{try{await req('/read',{method:'POST'});await refresh()}catch(e){status(text('error'))}});panel.appendChild(mark);const view=document.createElement('button');view.type='button';view.textContent=text('view');view.addEventListener('click',()=>{panel.hidden=true;open=false;if(realm==='store')location.assign('/store/?view=mine');else if(typeof window.go==='function')window.go('orders')});panel.appendChild(view);
  const enable=document.createElement('button');enable.type='button';enable.textContent=text('enable');enable.addEventListener('click',enablePush);panel.appendChild(enable);
  const disable=document.createElement('button');disable.type='button';disable.textContent=text('disable');disable.addEventListener('click',async()=>{const ok=await window.maviPushDisable();status(text(ok?'off':'error'))});panel.appendChild(disable);
  const note=document.createElement('p');note.className='mavi-web-status';note.setAttribute('role','status');panel.appendChild(note);
 }
 async function refresh(){if(polling)return;polling=true;try{const data=await req('');authenticated=true;current=data.alerts;unread=data.unread;bindButton();if(open)renderPanel()}catch(e){if(e.status===401||e.status===403){authenticated=false;current=[];unread=0;open=false;panel.hidden=true;bindButton()}}finally{polling=false}}
 async function enablePush(){
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window)||!window.isSecureContext){status(text('unsupported'));return}
  try{const permission=await Notification.requestPermission();if(permission!=='granted'){status(text('denied'));return}status(text('loading'));
   const key=(await req('/key')).publicKey;const reg=await navigator.serviceWorker.register('/sw.js',{scope:pushScope});if(!reg.active){await new Promise((resolve,reject)=>{const w=reg.installing||reg.waiting;if(!w)return reject(Error('worker unavailable'));const timeout=setTimeout(()=>reject(Error('worker timeout')),12000);w.addEventListener('statechange',()=>{if(w.state==='activated'){clearTimeout(timeout);resolve()}else if(w.state==='redundant'){clearTimeout(timeout);reject(Error('worker failed'))}});if(w.state==='activated'){clearTimeout(timeout);resolve()}})}
   let sub=await reg.pushManager.getSubscription();const desired=from64(key);if(sub&&sub.options&&sub.options.applicationServerKey){const existing=new Uint8Array(sub.options.applicationServerKey);if(existing.length!==desired.length||existing.some((v,i)=>v!==desired[i])){await sub.unsubscribe();sub=null}}if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:desired});
   await req('/subscribe',{method:'POST',body:{subscription:sub.toJSON(),lang:lang()}});try{localStorage.setItem(ownerKey,realm)}catch(e){}status(text('on'));
  }catch(e){status(text('error'))}
 }
 window.maviPushDisable=async function(){
  try{if(!('serviceWorker' in navigator))return false;
   const reg=await navigator.serviceWorker.getRegistration(pushScope);if(!reg)return true;const sub=await reg.pushManager.getSubscription();if(!sub)return true;
   await Promise.race([req('/unsubscribe',{method:'POST',body:{endpoint:sub.endpoint}}).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);const removed=await sub.unsubscribe();try{localStorage.removeItem(ownerKey)}catch(e){}return removed;
  }catch(e){return false};
 };
 window.maviAlertsRefresh=refresh;
 let mt;new MutationObserver(()=>{clearTimeout(mt);mt=setTimeout(bindButton,120)}).observe(document.body,{childList:true,subtree:true});
 new MutationObserver(()=>{bindButton();if(open)renderPanel()}).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
 bindButton();refresh();setInterval(()=>{if(!document.hidden)refresh()},20000);
})();
