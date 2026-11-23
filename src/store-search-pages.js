'use strict';
// Public, read-only search pages. Only active made-to-measure catalogue records are exposed.
const express = require('express');
const fs = require('fs');
const path = require('path');
const publicCache = require('./public-cache');
module.exports = function ({get, all}) {
 const r=express.Router();
 const localCache=new Map();
 let lastVer=publicCache.getCatalogueVersion();
 function routerCache(key,ttlMs,fn){
  const ver=publicCache.getCatalogueVersion();
  if(ver!==lastVer){localCache.clear();lastVer=ver;}
  const now=Date.now(),cur=localCache.get(key);
  if(cur&&cur.expiresAt>now)return cur;
  const value=fn();
  const entry={value,etag:'"mavi-'+require('node:crypto').createHash('sha1').update(value).digest('hex').slice(0,16)+'"',expiresAt:now+ttlMs};
  localCache.set(key,entry);
  return entry;
 }
 const defaultOrigin='https://9ev8jkxh7wzb-production-hkkaenim.us-central1.suga.run';
 const origin=(()=>{
  const raw=String(process.env.PUBLIC_ORIGIN||process.env.PUBLIC_URL||'').trim().replace(/\/+$/,'');
  if(!raw)return defaultOrigin;
  try{const u=new URL(raw);if(u.protocol==='https:'||u.protocol==='http:')return u.origin;}catch(_){}
  return defaultOrigin;
 })();
 const defaultOg=origin+'/brand/og-cover.jpg';
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const productPath=id=>'/store/product/'+encodeURIComponent(id);
 const style=`*{box-sizing:border-box}body{margin:0;background:#f7f3ed;color:#17294b;font-family:Tahoma,Arial,sans-serif;line-height:1.8}a{color:inherit}header{border-bottom:1px solid #e5d9ca;background:#fffdf9}header .wrap{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 0}.brand{font:30px Georgia,serif;text-decoration:none;letter-spacing:.08em}.brand small{display:block;font:9px Georgia;color:#a88962;letter-spacing:.16em}.wrap{width:min(1100px,92%);margin:auto}.back{font-size:14px}main{padding:42px 0 70px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:42px;align-items:start}.photo{background:#fffdfa;border:1px solid #e8ded0;border-radius:8px;padding:16px;text-align:center}.photo img{width:100%;height:min(72vh,680px);object-fit:contain}.eyebrow{color:#a3815c;font-size:12px;letter-spacing:.12em}h1{font-size:clamp(30px,5vw,46px);line-height:1.3;margin:12px 0 20px}.intro{color:#59616a}.price{font-weight:bold;font-size:27px}.box{background:#fffdfa;border:1px solid #e8ded0;padding:22px;margin:18px 0;border-radius:6px}.box h2{font-size:18px;margin:0 0 8px}.video-box{margin-top:16px;border:1px solid #e5d9ca;border-radius:10px;overflow:hidden;background:#121E48}.video-box video{display:block;width:100%;aspect-ratio:16/9;background:#121E48}.video-cap{padding:10px 14px;background:#fffdfa;font-size:12.5px;color:#59616a;border-top:1px solid #e8ded0}.buttons{display:flex;gap:12px;flex-wrap:wrap;margin:26px 0}.button{background:#172c50;color:white;padding:12px 24px;border-radius:5px;text-decoration:none;font-weight:bold}.button.alt{background:transparent;color:#172c50;border:1px solid #172c50}footer{border-top:1px solid #e3d8ca;padding:25px 0;color:#6d6c6b;font-size:13px}@media(max-width:700px){.grid{grid-template-columns:1fr;gap:22px}.photo img{height:470px}main{padding-top:26px}}`;
 function page({title,description,url,image,ogType='website',structured,body}){
  const img=image||defaultOg;
  const isDefaultOg=img===defaultOg;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(url)}"><link rel="icon" type="image/jpeg" href="/brand/logo.jpg"><meta property="og:type" content="${esc(ogType)}"><meta property="og:locale" content="ar_EG"><meta property="og:site_name" content="MAVI"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(img)}">${isDefaultOg?'<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">':''}<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(img)}"><style>${style}.gallery-extra{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}.gallery-extra img{width:100%;height:300px;object-fit:contain;background:#fffdfa;border:1px solid #e8ded0;border-radius:5px}.related{border-top:1px solid #e3d8ca;margin-top:48px;padding-top:26px}.related h2{font-size:25px}.related-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.related-card{text-decoration:none;background:#fffdfa;border:1px solid #e8ded0;padding:12px;display:block}.related-card img{height:250px;width:100%;object-fit:contain}.related-card strong{display:block;margin:8px 0}.details-list{padding-inline-start:20px}.details-list li{margin:8px 0}@media(max-width:700px){.gallery-extra img{height:200px}.related-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.related-card img{height:180px}}</style>${structured?`<script type="application/ld+json">${JSON.stringify(structured).replace(/</g,"\\u003c")}</script>`:""}</head><body><header><div class="wrap"><a class="brand" href="/store/">MAVI<small>TAILOR YOUR DESIGN</small></a><a class="back" href="/store/">← العودة للمتجر</a></div></header><main class="wrap">${body}</main><footer><div class="wrap">MAVI · Tailor Your Design &nbsp; | &nbsp; <a href="/store/custom-design">التصميم الخاص</a> &nbsp; | &nbsp; <a href="/store/returns">الإصلاح والاسترجاع</a> &nbsp; | &nbsp; <a href="https://wa.me/201013979358" target="_blank" rel="noopener noreferrer">تواصلي معنا</a></div></footer><script src="/store/analytics-consent.js" defer></script></body></html>`;
 }
 // Provide real catalogue links in the initial HTML; the existing storefront
 // replaces this initial view with its interactive catalogue after it loads.
 r.get('/store/', (req,res,next)=>{
  if (req.path !== '/store/') return next();
  try {
   const cached=routerCache('store_home_html',30000,()=>{
    const rawTemplate=fs.readFileSync(path.join(__dirname,'..','public','store','index.html'),'utf8');
    const template=origin===defaultOrigin?rawTemplate:rawTemplate.split(defaultOrigin).join(origin);
    const placeholder='<div id="view"></div>';
    if (!template.includes(placeholder)) return template;
    const rows=all("SELECT id,name FROM styles WHERE active=1 AND type='made' ORDER BY id");
    const links=rows.map(item=>`<li><a href="${esc(productPath(item.id))}">${esc(item.name)}</a></li>`).join('');
    const initial=`<div id="view"><section aria-label="موديلات MAVI"><h2 class="sec">اكتشفي موديلات MAVI</h2><ul style="padding:0 22px 20px;line-height:2.2">${links}</ul></section></div>`;
    return template.replace(placeholder,initial);
   });
   res.set('Cache-Control','no-store').type('html').send(cached.value);
  } catch (err) { next(err); }
 });
 if (origin !== defaultOrigin) {
  for (const [routePath, contentType] of [['/robots.txt', 'text/plain; charset=utf-8'], ['/llms.txt', 'text/plain; charset=utf-8']]) {
   r.get(routePath, (req, res, next) => {
    try {
     const raw = fs.readFileSync(path.join(__dirname, '..', 'public', routePath.slice(1)), 'utf8');
     res.set('Cache-Control', 'public, max-age=300').type(contentType).send(raw.split(defaultOrigin).join(origin));
    } catch (err) { next(err); }
   });
  }
 }
 r.get('/sitemap.xml',(req,res)=>{
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo'}).format(new Date());
  const cached=routerCache('sitemap_xml:'+today,60000,()=>{
   const rows=all("SELECT id,name FROM styles WHERE active=1 AND type='made' ORDER BY id")||[];
   const photos=all('SELECT style_id,id FROM style_images ORDER BY is_primary DESC,id')||[];
   const primaryPhoto=new Map();
   for(const ph of photos)if(!primaryPhoto.has(ph.style_id))primaryPhoto.set(ph.style_id,ph.id);
   const staticUrls=[
    {loc:origin+'/store/',changefreq:'daily',priority:'1.0',img:defaultOg,title:'MAVI — فساتين وتصميم خاص على مقاسك'},
    {loc:origin+'/store/custom-design',changefreq:'weekly',priority:'0.9',img:defaultOg,title:'تصميم خاص على مقاسك — MAVI'},
    {loc:origin+'/store/returns',changefreq:'monthly',priority:'0.7',img:null,title:null},
   ];
   const productUrls=rows.map(s=>{
    const photoId=primaryPhoto.get(s.id);
    return {
     loc:origin+productPath(s.id),
     changefreq:'weekly',
     priority:'0.8',
     img:photoId?origin+'/api/catalogue/images/'+Number(photoId):null,
     title:s.name?String(s.name)+' — MAVI':null
    };
   });
   const xmlEntries=[...staticUrls,...productUrls].map(u=>{
    const imgBlock=u.img?`\n    <image:image><image:loc>${esc(u.img)}</image:loc>${u.title?`<image:title>${esc(u.title)}</image:title>`:''}</image:image>`:'';
    return `  <url>\n    <loc>${esc(u.loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>${imgBlock}\n  </url>`;
   }).join('\n');
   return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n'+xmlEntries+'\n</urlset>';
  });
  res.set({'Cache-Control':'public, max-age=300','ETag':cached.etag});
  if(req.headers['if-none-match']===cached.etag)return res.sendStatus(304);
  res.type('application/xml').send(cached.value);
 });
 r.get('/store/product/:id',(req,res)=>{
  const id=req.params.id;if(!/^[A-Z0-9_-]{1,30}$/.test(id))return res.sendStatus(404);
  const p=get("SELECT id,name,note,price,sale_price FROM styles WHERE id=? AND active=1 AND type='made'",id);if(!p)return res.status(404).type('text/plain').send('الموديل غير متاح');
  const cached=routerCache('product_page:'+id,30000,()=>{
   const images=all('SELECT id FROM style_images WHERE style_id=? ORDER BY is_primary DESC,id',id);
   const fabrics=all('SELECT name FROM style_fabrics WHERE style_id=? ORDER BY name',id).map(x=>x.name);
   const colours=all('SELECT name FROM style_colours WHERE style_id=? ORDER BY sort',id).map(x=>x.name);
   const name=esc(p.name),note=esc(p.note||'');const description=('اكتشفي موديل '+p.name+' من MAVI، تفصيل على المقاس. '+(p.note||'')+' اطلبي الموديل وتابعي التفاصيل مع فريقنا.').slice(0,155);
   const src=images.length?origin+'/api/catalogue/images/'+Number(images[0].id):defaultOg;const price=Number(p.sale_price??p.price);
   const related=all("SELECT id,name,price,sale_price FROM styles WHERE active=1 AND type='made' AND id<>? ORDER BY id LIMIT 3",id);
   const relPhotoMap=new Map();
   if(related.length){
    const ph=related.map(()=>'?').join(',');
    for(const rph of all(`SELECT style_id,id FROM style_images WHERE style_id IN (${ph}) ORDER BY is_primary DESC,id`,...related.map(x=>x.id))){
     if(!relPhotoMap.has(rph.style_id))relPhotoMap.set(rph.style_id,rph.id);
    }
   }
   const relatedCards=related.map(item=>{const photoId=relPhotoMap.get(item.id);return `<a class="related-card" href="${esc(productPath(item.id))}">${photoId?`<img loading="lazy" decoding="async" src="/api/catalogue/images/${Number(photoId)}" alt="${esc(item.name)} من MAVI">`:''}<strong>${esc(item.name)}</strong><span>${esc(Number(item.sale_price??item.price).toLocaleString('en-US'))} جنيه</span></a>`}).join('');
   const extraImages=images.slice(1).map((im,i)=>`<img loading="lazy" decoding="async" src="/api/catalogue/images/${Number(im.id)}" alt="${name} من MAVI — صورة ${i+2}">`).join('');
   const body=`<nav aria-label="مسار الصفحة"><a href="/store/">المتجر</a> / ${name}</nav><div class="grid"><div class="photo"><img src="${esc(src)}" alt="${name} من MAVI" fetchpriority="high">${extraImages?`<div class="gallery-extra" aria-label="صور إضافية للموديل">${extraImages}</div>`:''}</div><div><span class="eyebrow">MAVI · MADE FOR YOU</span><h1>${name}</h1>${note?`<p class="intro">${note}</p>`:''}<p class="price">${esc(price.toLocaleString('en-US'))} جنيه</p><p class="intro">السعر قبل التوصيل. بنراجع تكلفة التوصيل وتفاصيل الطلب معاكِ حسب المحافظة قبل تأكيد الحجز ودفع العربون.</p>${fabrics.length?`<div class="box"><h2>الخامات</h2><p>${fabrics.map(esc).join('، ')}</p></div>`:''}${colours.length?`<div class="box"><h2>الألوان المتاحة</h2><p>${colours.map(esc).join('، ')}</p></div>`:''}<p class="intro">الألوان للمعاينة وقد تختلف عن لون القماش الفعلي. اتواصلي معانا لتأكيد التفاصيل.</p><div class="buttons"><a class="button" href="/store/?product=${encodeURIComponent(p.id)}">اختاري التفاصيل واطلبي</a><a class="button alt" href="/store/">تصفحي المجموعة</a></div><div class="box"><h2>خطوات طلبك</h2><ol class="details-list"><li>اختاري تفاصيل الموديل وسجّلي مقاساتك.</li><li>ابعتي الطلب، ونراجع معاكِ التفاصيل وتكلفة التوصيل قبل تأكيد الحجز والعربون.</li><li>تابعي حالة التنفيذ من «طلباتي» بعد تأكيد الطلب.</li></ol><a href="/store/returns">اقرأي سياسة الإصلاح والاسترجاع</a></div></div></div>${relatedCards?`<section class="related" aria-labelledby="related-title"><h2 id="related-title">اكتشفي موديلات تانية</h2><div class="related-grid">${relatedCards}</div></section>`:''}`;
   const productUrl=origin+productPath(p.id);
   const productLd={'@type':'Product',name:p.name,description,sku:p.id,brand:{'@type':'Brand',name:'MAVI'},offers:{'@type':'Offer',url:productUrl,price:price,priceCurrency:'EGP',availability:'https://schema.org/MadeToOrder',itemCondition:'https://schema.org/NewCondition',seller:{'@id':origin+'/store/#store'}}};
   if(images.length)productLd.image=images.map(x=>origin+'/api/catalogue/images/'+Number(x.id));
   const structured={'@context':'https://schema.org','@graph':[productLd,{'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:'المتجر',item:origin+'/store/'},{'@type':'ListItem',position:2,name:p.name,item:productUrl}]}]};
   return page({title:p.name+(p.note?' — '+String(p.note).slice(0,45):'')+' | MAVI',description,url:productUrl,image:src,ogType:'product',body,structured});
  });
  res.set({'Cache-Control':'public, max-age=60','ETag':cached.etag});
  if(req.headers['if-none-match']===cached.etag)return res.sendStatus(304);
  res.send(cached.value);
 });
 r.get('/store/returns',(req,res)=>{
  const title='سياسة التعديل والاسترجاع | MAVI - ضمان جودة التفصيل';
  const description='تعرفي على طريقة MAVI في التعامل مع مشكلات القطع المفصّلة، والإصلاح والاسترجاع والتواصل معنا.';
  const url=origin+'/store/returns';
  const body=`<nav aria-label="مسار الصفحة"><a href="/store/">المتجر</a> / سياسة الإصلاح والاسترجاع</nav><div class="grid"><div><span class="eyebrow">MAVI · HERE FOR YOU</span><h1>معاكِ حتى بعد الاستلام</h1><p class="intro">كل قطعة من MAVI بتتعمل مخصوص ليكِ. لو واجهتك أي مشكلة، يهمنا نسمع منك ونساعدك.</p><div class="buttons"><a class="button" href="https://wa.me/201013979358" target="_blank" rel="noopener noreferrer">تواصلي معانا على واتساب</a></div></div><div><div class="box"><h2>إبلاغنا بالمشكلة</h2><p>لو في مشكلة في القطعة، تواصلي معانا مباشرة بعد الاستلام على واتساب ووضّحي المشكلة وتفاصيل طلبك، عشان نراجعها معاكِ.</p></div><div class="box"><h2>لو المشكلة بسبب MAVI</h2><p>لو المشكلة نتيجة خطأ من البراند ويمكن إصلاحها، بنتحمّل تكاليف شحن القطعة وإصلاحها وإعادتها ليكِ بالكامل. ولو المشكلة لا يمكن إصلاحها، بنسترجع المبلغ فورًا للعميلة.</p></div><div class="box"><h2>لو المشكلة نتيجة اختيارات العميلة</h2><p>لو المشكلة نتيجة قرارات أو اختيارات العميلة، بنساعدها في الإصلاح، وتتحمل هي التكاليف.</p></div><div class="box"><h2>الاستبدال وحقوقك</h2><p>لأن كل قطعة تفصيل خاص، لا نقدم استبدالًا. لا تؤثر هذه السياسة على حقوقك المقررة بموجب القوانين الواجبة التطبيق.</p></div><div class="box" lang="en" dir="ltr"><h2>Repairs and refunds</h2><p>Please contact us promptly after delivery if there is a problem. If MAVI is responsible and the item can be repaired, we cover shipping, repair and return delivery. If the problem cannot be repaired, we refund the customer immediately. If the issue results from the customer's choices, we help with repairs at the customer's expense. Custom-made items are not exchanged. Your rights under applicable law remain unaffected.</p><a href="https://wa.me/201013979358" target="_blank" rel="noopener noreferrer">Contact us on WhatsApp</a></div></div></div>`;
  const structured={'@context':'https://schema.org','@graph':[
   {'@type':'WebPage','@id':url+'#webpage',url,name:title,description,inLanguage:['ar','en']},
   {'@type':'MerchantReturnPolicy','@id':url+'#policy',name:'سياسة الإصلاح والاسترجاع — MAVI',applicableCountry:'EG',returnPolicyCategory:'https://schema.org/MerchantReturnFiniteReturnWindow',merchantReturnDays:14,returnMethod:'https://schema.org/ReturnByMail',returnFees:'https://schema.org/FreeReturn',customerRemorseReturnFees:'https://schema.org/ReturnShippingFees',url},
   {'@type':'FAQPage','@id':url+'#faq',mainEntity:[
    {'@type':'Question',name:'ماذا يحدث لو كانت المشكلة في القطعة بسبب MAVI؟',acceptedAnswer:{'@type':'Answer',text:'إذا كانت المشكلة نتيجة خطأ من MAVI ويمكن إصلاحها، تتحمل MAVI تكاليف شحن القطعة وإصلاحها وإعادتها بالكامل، وإذا تعذر الإصلاح يُسترد المبلغ فورًا.'}},
    {'@type':'Question',name:'ماذا لو كانت المشكلة بسبب اختيارات أو مقاسات العميلة؟',acceptedAnswer:{'@type':'Answer',text:'إذا نتجت المشكلة عن اختيارات العميلة أو مقاساتها، تساعد MAVI في التعديل والإصلاح وتتحمل العميلة التكاليف.'}},
    {'@type':'Question',name:'هل يوجد استبدال لقطع التفصيل الخاص؟',acceptedAnswer:{'@type':'Answer',text:'لأن كل قطعة تُفصّل خصيصًا للعميلة، لا يتوفر استبدال، دون الإخلال بالحقوق القانونية المقررة.'}}
   ]},
   {'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:'المتجر',item:origin+'/store/'},{'@type':'ListItem',position:2,name:'الإصلاح والاسترجاع',item:url}]}
  ]};
  res.set('Cache-Control','public, max-age=300').send(page({title,description,url,body,structured}));
 });
 r.get('/store/custom-design',(req,res)=>{
  const title='تصميم وتفصيل فستان خاص على مقاسك | MAVI مصر';const description='عندك فكرة لفستان؟ شاركينا صورة تصميمك وتفاصيل اللون والخامة والمقاسات، وفريق MAVI يتواصل معك لتأكيد الطلب.';
  const url=origin+'/store/custom-design';
  const body=`<nav aria-label="مسار الصفحة"><a href="/store/">المتجر</a> / تصميم خاص</nav><div class="grid"><div><span class="eyebrow">YOUR IDEA · OUR CRAFT</span><h1>تصميمك يبدأ بفكرة</h1><p class="intro">عندك صورة لفستان أو فكرة بتعبّر عن ذوقك؟ شاركينا التصميم والتفاصيل اللي تحبيها، ونساعدك في اختيار اللون والخامة واللمسات المناسبة.</p><div class="buttons"><a class="button" href="/store/?design=1">ابدئي تصميمك</a><a class="button alt" href="https://wa.me/201013979358" target="_blank" rel="noopener noreferrer">اسألينا على واتساب</a></div><div class="video-box"><video controls playsinline preload="none" poster="/brand/measurements-poster.webp"><source src="/brand/measurements-guide.mp4" type="video/mp4">دليلك لأخذ المقاسات الصحيحة في دقيقتين مع MAVI.</video><div class="video-cap"><b>فيديو إرشادي (٢:٢٦):</b> الطريقة الصحيحة لأخذ مقاسات الصدر والوسط والهيب وعرض الكتف والطول قبل إرسال تصميمك.</div></div></div><div><div class="box"><h2>١. سجّلي مقاساتك</h2><p>من حسابك، أضيفي مقاسات الصدر والوسط والهيب وعرض الكتف والطول بالسنتيمتر (مع إمكانية إضافة طول الكم ودوران الذراع).</p></div><div class="box"><h2>٢. شاركينا فكرتك</h2><p>ارفعي صورة التصميم، واكتبي اللون والخامة والتعديلات اللي تحبيها، سواء من خامات MAVI أو قماشك الخاص.</p></div><div class="box"><h2>٣. نراجع التفاصيل معاكِ</h2><p>بعد إرسال الطلب نتواصل لتأكيد التفاصيل والتكلفة وتكلفة التوصيل حسب المحافظة، ونتفق على العربون وطريقة الاستلام.</p></div></div></div>`;
  const structured={'@context':'https://schema.org','@graph':[
   {'@type':'Service','@id':url+'#service',name:'تصميم وتفصيل فساتين خاصة على المقاس — MAVI',serviceType:'Custom Dressmaking & Bespoke Tailoring',provider:{'@id':origin+'/store/#store'},areaServed:{'@type':'Country',name:'Egypt'},url,description},
   {'@type':'HowTo','@id':url+'#howto',name:'خطوات طلب تصميم فستان خاص من MAVI',totalTime:'PT5M',step:[
    {'@type':'HowToStep',position:1,name:'تسجيل المقاسات',text:'أضيفي مقاسات الصدر والوسط والهيب وعرض الكتف والطول بالسنتيمتر في حسابك، مع طول الكم ودوران الذراع اختياريًا.'},
    {'@type':'HowToStep',position:2,name:'رفع صورة التصميم والتفاصيل',text:'ارفعي صورة التصميم المطلوب وحددي اللون والخامة ومصدر القماش والتعديلات المفضلة.'},
    {'@type':'HowToStep',position:3,name:'المراجعة وتأكيد العربون',text:'يراجع فريق MAVI تفاصيل الطلب ويحدد تكلفة التوصيل حسب المحافظة ثم يتفق معك على العربون وبدء التفصيل.'}
   ]},
   {'@type':'VideoObject','@id':origin+'/store/#measurements-video',name:'دليل أخذ المقاسات الصحيحة لتفصيل الفساتين — MAVI',description:'فيديو إرشادي باللهجة المصرية لشرح طريقة أخذ 7 مقاسات بالمازورة (الصدر، الوسط، الهيب، عرض الكتف، الطول، الكم، الذراع) في دقيقتين.',thumbnailUrl:origin+'/brand/measurements-poster.webp',contentUrl:origin+'/brand/measurements-guide.mp4',uploadDate:'2026-11-02T00:00:00+02:00',duration:'PT2M26S',inLanguage:'ar'},
   {'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:'المتجر',item:origin+'/store/'},{'@type':'ListItem',position:2,name:'تصميم خاص',item:url}]}
  ]};
  res.set('Cache-Control','public, max-age=300').send(page({title,description,url,body,structured}));
 });
 return r;
};
