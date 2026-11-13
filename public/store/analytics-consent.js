/* MAVI: optional analytics only. No Google script is loaded before opt-in. */
(function(){
 'use strict';
 const ID='G-JYBHFBY025', KEY='mavi-analytics-choice-v1';
 let choice=null, loaded=false, memoryChoice=null;
 function stored(){try{return localStorage.getItem(KEY)}catch(e){return memoryChoice}}
 function save(v){memoryChoice=v;try{localStorage.setItem(KEY,v)}catch(e){}}
 function clearAnalyticsCookies(){
  const domains=[location.hostname,'.'+location.hostname];const parts=location.hostname.split('.');
  for(let i=1;i<parts.length-1;i++)domains.push('.'+parts.slice(i).join('.'));
  document.cookie.split(';').forEach(part=>{const name=part.trim().split('=')[0];if(!/^_ga(?:_|$)/.test(name))return;
   document.cookie=name+'=; Max-Age=0; path=/; SameSite=Lax';domains.forEach(domain=>{document.cookie=name+'=; Max-Age=0; path=/; domain='+domain+'; SameSite=Lax'});
  });
 }
 function start(){
  if(loaded || stored()!=='yes')return;loaded=true;window['ga-disable-'+ID]=false;
  window.dataLayer=window.dataLayer||[];function gtag(){window.dataLayer.push(arguments)}window.gtag=gtag;
  // Never pass query strings, fragments, customer details, or the full referring URL.
  let ref='';try{if(document.referrer)ref=new URL(document.referrer).origin+'/'}catch(e){}
  gtag('js',new Date());gtag('config',ID,{send_page_view:false,allow_google_signals:false,allow_ad_personalization_signals:false,page_location:location.origin+location.pathname,page_referrer:ref});
  gtag('event','page_view',{send_to:ID,page_location:location.origin+location.pathname,page_referrer:ref,page_title:document.title});
  const s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(ID);s.referrerPolicy='origin';document.head.appendChild(s);
 }
 const text={ar:{title:'اختيارك يهمنا',desc:'بموافقتك نستخدم Google Analytics لتحسين تجربتك. تقدري تغيّري اختيارك في أي وقت.',accept:'موافقة',reject:'رفض',settings:'إعدادات الإحصاءات',provider:'معلومات Google عن البيانات'},en:{title:'Your choice matters',desc:'With your consent, we use Google Analytics to improve your experience. You can change your choice anytime.',accept:'Accept',reject:'Reject',settings:'Analytics settings',provider:'How Google uses data'}};
 // Fixed event names only; never pass form contents, IDs, contact details, or URLs with queries.
 function record(name){
  if(!loaded || stored()!=='yes' || typeof window.gtag!=='function')return;
  window.gtag('event',name,{send_to:ID,page_location:location.origin+location.pathname});
 }
 function trackAction(target){
  if(!target || !target.closest)return;
  const el=target.closest('a,button,.pcard');if(!el)return;
  const handler=el.getAttribute('onclick')||'';
  const href=el.getAttribute('href')||'';
  if(el.id==='order-submit'){record('order_submit_click');return}
  if(el.id==='custom-submit'){record('custom_submit_click');return}
  if(/^waContact\(\)|^waProduct\(\)|^customWhatsApp\(/.test(handler) || /^https:\/\/wa\.me\//.test(href)){record('whatsapp_click');return}
  if(/^btCustom\(\)/.test(handler) || href==='/store/?design=1' || href==='/store/custom-design'){record('custom_design_click');return}
  if(el.classList.contains('pcard') || /^\/store\/\?product=/.test(href) || /^\/store\/product\//.test(href)){record('product_detail_click')}
 }
 document.addEventListener('click',e=>trackAction(e.target),true);
 document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ') && e.target && e.target.classList && e.target.classList.contains('pcard'))trackAction(e.target)},true);
 function lang(){return document.documentElement.lang==='en'?'en':'ar'}
 function init(){
  const css=document.createElement('style');css.textContent='.mavi-consent-panel{position:fixed;z-index:2147483000;bottom:16px;left:16px;width:min(390px,calc(100vw - 32px));background:#fffdf9;border:1px solid #e2d5c5;border-radius:16px;box-shadow:0 14px 44px #15254138;overflow:hidden;color:#192d4e;font:13px/1.7 Tahoma,Arial,sans-serif}.mavi-consent-panel[hidden]{display:none}.mavi-consent-head{padding:14px 18px 11px;background:#f1e9dd;border-bottom:1px solid #e6d9c9}.mavi-consent-brand{display:block;font:10px Georgia,serif;letter-spacing:.16em;color:#a48562}.mavi-consent-panel h2{font:700 15px Tahoma,Arial,sans-serif;margin:6px 0 0;color:#192d4e}.mavi-consent-content{padding:12px 18px 15px}.mavi-consent-panel p{margin:0 0 6px;color:#5d6772;font-size:12px}.mavi-consent-panel a{font-size:11px;color:#7e6a52;text-underline-offset:3px}.mavi-consent-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:11px}.mavi-consent-panel button{min-height:39px;font:700 12px Tahoma,Arial,sans-serif;border:1px solid #b7a38c;border-radius:7px;padding:8px;cursor:pointer;background:#fffdf9;color:#192d4e}.mavi-consent-panel button:hover{background:#f3ede4}.mavi-consent-panel button:focus-visible{outline:3px solid #d7ad79;outline-offset:2px}.mavi-consent-settings{display:inline-block!important;position:static!important;font:12px/1.6 Tahoma,Arial,sans-serif!important;background:transparent!important;color:inherit!important;border:0!important;text-decoration:underline!important;padding:10px 0!important;cursor:pointer!important;margin:0 16px!important}@media(max-width:480px){.mavi-consent-panel{bottom:10px;left:10px;width:calc(100vw - 20px)}}';document.head.appendChild(css);
  const panel=document.createElement('section');panel.className='mavi-consent-panel';panel.setAttribute('role','region');panel.setAttribute('aria-label','Privacy choices');panel.innerHTML='<div class="mavi-consent-head"><span class="mavi-consent-brand">MAVI · YOUR PRIVACY</span><h2></h2></div><div class="mavi-consent-content"><p></p><a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer"></a><div class="mavi-consent-actions"><button type="button" data-choice="yes"></button><button type="button" data-choice="no"></button></div></div>';
  const settings=document.createElement('button');settings.type='button';settings.className='mavi-consent-settings';document.body.append(panel);const footer=document.querySelector('footer');(footer||document.body).appendChild(settings);
  function translate(){let a=text[lang()];panel.dir=lang()==='ar'?'rtl':'ltr';panel.querySelector('h2').textContent=a.title;panel.querySelector('p').textContent=a.desc;panel.querySelector('a').textContent=a.provider;panel.querySelector('[data-choice=yes]').textContent=a.accept;panel.querySelector('[data-choice=no]').textContent=a.reject;settings.textContent=a.settings}
  function show(){translate();panel.hidden=false;panel.querySelector('button').focus()}
  settings.addEventListener('click',show);
  panel.addEventListener('click',e=>{const btn=e.target.closest('[data-choice]');if(!btn)return;choice=btn.dataset.choice;save(choice);panel.hidden=true;if(choice==='yes')start();else{window['ga-disable-'+ID]=true;clearAnalyticsCookies();if(loaded)location.reload()}});
  translate();new MutationObserver(translate).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  choice=stored();panel.hidden=choice==='yes'||choice==='no';if(choice==='yes')start();
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
