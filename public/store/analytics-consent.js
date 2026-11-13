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
 const text={ar:{title:'خصوصيتك واختيارك',desc:'بموافقتك، نستخدم Google Analytics لفهم زيارات الموقع وتحسين تجربتك. لا نفعّله قبل موافقتك، ويمكنك تغيير اختيارك في أي وقت من إعدادات الإحصاءات.',accept:'أوافق على الإحصاءات',reject:'رفض الإحصاءات',settings:'إعدادات الإحصاءات',provider:'معلومات Google عن البيانات'},en:{title:'Your privacy, your choice',desc:'With your consent, we use Google Analytics to understand visits and improve your experience. It will not load before consent. You can change your choice at any time in Analytics settings.',accept:'Accept analytics',reject:'Reject analytics',settings:'Analytics settings',provider:'How Google uses data'}};
 function lang(){return document.documentElement.lang==='en'?'en':'ar'}
 function init(){
  const css=document.createElement('style');css.textContent='.mavi-consent-panel{position:fixed;z-index:2147483000;bottom:18px;left:18px;width:min(420px,calc(100vw - 36px));background:#fffdf9;border:1px solid #dac9b6;border-radius:14px;box-shadow:0 10px 40px #10203f38;padding:19px;font:14px/1.7 Tahoma,Arial,sans-serif;color:#172b50}.mavi-consent-panel[hidden]{display:none}.mavi-consent-panel h2{font:700 17px Tahoma,Arial,sans-serif;margin:0 0 8px}.mavi-consent-panel p{margin:0 0 10px;color:#4e5967}.mavi-consent-panel a{font-size:12px;color:#172b50}.mavi-consent-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}.mavi-consent-panel button,.mavi-consent-settings{font:700 13px Tahoma,Arial,sans-serif;border:1px solid #172b50;border-radius:6px;padding:10px 13px;cursor:pointer}.mavi-consent-panel button:first-child{background:#172b50;color:white}.mavi-consent-panel button:last-child{background:white;color:#172b50}.mavi-consent-settings{position:fixed;z-index:2147482999;bottom:5px;left:8px;background:#fffdf9;color:#172b50;padding:5px 8px;font-size:11px;box-shadow:0 2px 8px #0002}';document.head.appendChild(css);
  const panel=document.createElement('section');panel.className='mavi-consent-panel';panel.setAttribute('role','region');panel.setAttribute('aria-label','Privacy choices');panel.innerHTML='<h2></h2><p></p><a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer"></a><div class="mavi-consent-actions"><button type="button" data-choice="yes"></button><button type="button" data-choice="no"></button></div>';
  const settings=document.createElement('button');settings.type='button';settings.className='mavi-consent-settings';document.body.append(panel,settings);
  function translate(){let a=text[lang()];panel.dir=lang()==='ar'?'rtl':'ltr';panel.querySelector('h2').textContent=a.title;panel.querySelector('p').textContent=a.desc;panel.querySelector('a').textContent=a.provider;panel.querySelector('[data-choice=yes]').textContent=a.accept;panel.querySelector('[data-choice=no]').textContent=a.reject;settings.textContent=a.settings}
  function show(){translate();panel.hidden=false;panel.querySelector('button').focus()}
  settings.addEventListener('click',show);
  panel.addEventListener('click',e=>{const btn=e.target.closest('[data-choice]');if(!btn)return;choice=btn.dataset.choice;save(choice);panel.hidden=true;if(choice==='yes')start();else{window['ga-disable-'+ID]=true;clearAnalyticsCookies();if(loaded)location.reload()}});
  translate();new MutationObserver(translate).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  choice=stored();panel.hidden=choice==='yes'||choice==='no';if(choice==='yes')start();
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
