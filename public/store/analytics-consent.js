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
  const css=document.createElement('style');css.textContent='.mavi-consent-panel{position:fixed;z-index:2147483000;bottom:14px;left:14px;width:min(360px,calc(100vw - 28px));background:#fffdf9;border:1px solid #d9cbbb;border-radius:12px;box-shadow:0 6px 26px #10203f2b;padding:14px;font:13px/1.55 Tahoma,Arial,sans-serif;color:#172b50}.mavi-consent-panel[hidden]{display:none}.mavi-consent-panel h2{font:700 15px Tahoma,Arial,sans-serif;margin:0 0 5px}.mavi-consent-panel p{margin:0 0 5px;color:#4e5967}.mavi-consent-panel a{font-size:11px;color:#172b50}.mavi-consent-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}.mavi-consent-panel button{font:700 13px Tahoma,Arial,sans-serif;border:1px solid #172b50;border-radius:5px;padding:8px 15px;cursor:pointer;background:#fff;color:#172b50}.mavi-consent-settings{display:inline-block!important;position:static!important;font:12px/1.6 Tahoma,Arial,sans-serif!important;background:transparent!important;color:inherit!important;border:0!important;text-decoration:underline!important;padding:10px 0!important;cursor:pointer!important;margin:0 16px!important}';document.head.appendChild(css);
  const panel=document.createElement('section');panel.className='mavi-consent-panel';panel.setAttribute('role','region');panel.setAttribute('aria-label','Privacy choices');panel.innerHTML='<h2></h2><p></p><a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer"></a><div class="mavi-consent-actions"><button type="button" data-choice="yes"></button><button type="button" data-choice="no"></button></div>';
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
