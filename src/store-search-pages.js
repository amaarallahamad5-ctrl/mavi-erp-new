'use strict';
// Public, read-only search pages. Only active made-to-measure catalogue records are exposed.
const express = require('express');
module.exports = function ({get, all}) {
 const r=express.Router();
 const origin='https://9ev8jkxh7wzb-production-hkkaenim.us-central1.suga.run';
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const productPath=id=>'/store/product/'+encodeURIComponent(id);
 const style=`*{box-sizing:border-box}body{margin:0;background:#f7f3ed;color:#17294b;font-family:Tahoma,Arial,sans-serif;line-height:1.8}a{color:inherit}header{border-bottom:1px solid #e5d9ca;background:#fffdf9}header .wrap{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 0}.brand{font:30px Georgia,serif;text-decoration:none;letter-spacing:.08em}.brand small{display:block;font:9px Georgia;color:#a88962;letter-spacing:.16em}.wrap{width:min(1100px,92%);margin:auto}.back{font-size:14px}main{padding:42px 0 70px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:42px;align-items:start}.photo{background:#fffdfa;border:1px solid #e8ded0;border-radius:8px;padding:16px;text-align:center}.photo img{width:100%;height:min(72vh,680px);object-fit:contain}.eyebrow{color:#a3815c;font-size:12px;letter-spacing:.12em}h1{font-size:clamp(30px,5vw,46px);line-height:1.3;margin:12px 0 20px}.intro{color:#59616a}.price{font-weight:bold;font-size:27px}.box{background:#fffdfa;border:1px solid #e8ded0;padding:22px;margin:18px 0;border-radius:6px}.box h2{font-size:18px;margin:0 0 8px}.buttons{display:flex;gap:12px;flex-wrap:wrap;margin:26px 0}.button{background:#172c50;color:white;padding:12px 24px;border-radius:5px;text-decoration:none;font-weight:bold}.button.alt{background:transparent;color:#172c50;border:1px solid #172c50}footer{border-top:1px solid #e3d8ca;padding:25px 0;color:#6d6c6b;font-size:13px}@media(max-width:700px){.grid{grid-template-columns:1fr;gap:22px}.photo img{height:470px}main{padding-top:26px}}`;
 function page({title,description,url,image,body,structured}){
  const img=image||origin+'/brand/logo.jpg';
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(url)}"><link rel="icon" type="image/jpeg" href="/brand/logo.jpg"><meta property="og:type" content="website"><meta property="og:site_name" content="MAVI"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(img)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(img)}"><style>${style}</style>${structured?`<script type="application/ld+json">${JSON.stringify(structured).replace(/</g,"\\u003c")}</script>`:""}</head><body><header><div class="wrap"><a class="brand" href="/store/">MAVI<small>TAILOR YOUR DESIGN</small></a><a class="back" href="/store/">← العودة للمتجر</a></div></header><main class="wrap">${body}</main><footer><div class="wrap">MAVI · Tailor Your Design &nbsp; | &nbsp; <a href="/store/custom-design">التصميم الخاص</a> &nbsp; | &nbsp; <a href="https://wa.me/201013979358">تواصلي معنا</a></div></footer></body></html>`;
 }
 r.get('/sitemap.xml',(req,res)=>{
  const rows=all("SELECT id FROM styles WHERE active=1 AND type='made' ORDER BY id");
  const urls=[origin+'/store/',origin+'/store/custom-design',...rows.map(s=>origin+productPath(s.id))];
  res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+urls.map(u=>'  <url><loc>'+esc(u)+'</loc></url>').join('\n')+'\n</urlset>');
 });
 r.get('/store/product/:id',(req,res)=>{
  const id=req.params.id;if(!/^[A-Z0-9_-]{1,30}$/.test(id))return res.sendStatus(404);
  const p=get("SELECT id,name,note,price,sale_price FROM styles WHERE id=? AND active=1 AND type='made'",id);if(!p)return res.status(404).type('text/plain').send('الموديل غير متاح');
  const images=all('SELECT id FROM style_images WHERE style_id=? ORDER BY is_primary DESC,id',id);
  const fabrics=all('SELECT name FROM style_fabrics WHERE style_id=? ORDER BY name',id).map(x=>x.name);
  const colours=all('SELECT name FROM style_colours WHERE style_id=? ORDER BY sort',id).map(x=>x.name);
  const name=esc(p.name),note=esc(p.note||'');const description=('اكتشفي موديل '+p.name+' من MAVI، تفصيل على المقاس. '+(p.note||'')+' اطلبي الموديل وتابعي التفاصيل مع فريقنا.').slice(0,155);
  const src=images.length?origin+'/api/catalogue/images/'+Number(images[0].id):origin+'/brand/logo.jpg';const price=Number(p.sale_price??p.price);
  const body=`<nav aria-label="مسار الصفحة"><a href="/store/">المتجر</a> / ${name}</nav><div class="grid"><div class="photo"><img src="${esc(src)}" alt="${name} من MAVI" fetchpriority="high"></div><div><span class="eyebrow">MAVI · MADE FOR YOU</span><h1>${name}</h1>${note?`<p class="intro">${note}</p>`:''}<p class="price">${esc(price.toLocaleString('en-US'))} جنيه</p><p class="intro">السعر قبل التوصيل، وتفاصيل الطلب والتوصيل حسب الاتفاق والمحافظة.</p>${fabrics.length?`<div class="box"><h2>الخامات</h2><p>${fabrics.map(esc).join('، ')}</p></div>`:''}${colours.length?`<div class="box"><h2>الألوان المتاحة</h2><p>${colours.map(esc).join('، ')}</p></div>`:''}<p class="intro">الألوان للمعاينة وقد تختلف عن لون القماش الفعلي. اتواصلي معانا لتأكيد التفاصيل.</p><div class="buttons"><a class="button" href="/store/?product=${encodeURIComponent(p.id)}">اختاري التفاصيل واطلبي</a><a class="button alt" href="/store/">تصفحي المجموعة</a></div></div></div>`;
  const productUrl=origin+productPath(p.id);
  const structured={'@context':'https://schema.org','@type':'Product',name:p.name,description,sku:p.id,brand:{'@type':'Brand',name:'MAVI'},offers:{'@type':'Offer',url:productUrl,price:price,priceCurrency:'EGP'}};
  if(images.length)structured.image=images.map(x=>origin+'/api/catalogue/images/'+Number(x.id));
  res.set('Cache-Control','public, max-age=60').send(page({title:p.name+' | MAVI',description,url:productUrl,image:src,body,structured}));
 });
 r.get('/store/custom-design',(req,res)=>{
  const title='تصميم خاص وتفصيل على المقاس | MAVI';const description='عندك فكرة لفستان؟ شاركينا صورة تصميمك وتفاصيل اللون والخامة والمقاسات، وفريق MAVI يتواصل معك لتأكيد الطلب.';
  const body=`<nav><a href="/store/">المتجر</a> / تصميم خاص</nav><div class="grid"><div><span class="eyebrow">YOUR IDEA · OUR CRAFT</span><h1>تصميمك يبدأ بفكرة</h1><p class="intro">عندك صورة لفستان أو فكرة بتعبّر عن ذوقك؟ شاركينا التصميم والتفاصيل اللي تحبيها، ونساعدك في اختيار اللون والخامة واللمسات المناسبة.</p><div class="buttons"><a class="button" href="/store/?design=1">ابدئي تصميمك</a><a class="button alt" href="https://wa.me/201013979358">اسألينا على واتساب</a></div></div><div><div class="box"><h2>١. سجّلي مقاساتك</h2><p>من حسابك، أضيفي مقاسات الصدر والوسط والهيب والطول بالسنتيمتر.</p></div><div class="box"><h2>٢. شاركينا فكرتك</h2><p>ارفعي صورة التصميم، واكتبي اللون والخامة والتعديلات اللي تحبيها.</p></div><div class="box"><h2>٣. نراجع التفاصيل معاكِ</h2><p>بعد إرسال الطلب نتواصل لتأكيد التفاصيل والتكلفة، ونتفق على العربون وطريقة الاستلام أو التوصيل حسب المحافظة.</p></div></div></div>`;
  res.send(page({title,description,url:origin+'/store/custom-design',body}));
 });
 return r;
};
