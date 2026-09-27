// ساخت صفحه‌ی HTML ریلز ۱ از روی مدت واقعی هر تکه‌ی گویندگی.
//   node build-reel-01.js durations.json > reel-01.html
// durations.json: آرایه‌ی ۸ عدد (ثانیه) برای ۸ جمله‌ی گویندگی به همان ترتیب سناریو.
// خروجی با render-reel.py فریم‌به‌فریم ضبط و با صدا ترکیب می‌شود.
const fs = require('fs');
const dur = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const LEAD = 0.4, GAP = 0.35, OUTRO = 2.2;
const starts = []; let t = LEAD;
for (const d of dur) { starts.push(+t.toFixed(2)); t += d + GAP; }
const total = +(t - GAP + OUTRO).toFixed(2);
// صحنه‌ی i از شروع جمله‌ی i تا شروع جمله‌ی بعد (آخری تا پایان ویدیو)
const scene = i => ({ s: starts[i] - (i ? 0.15 : LEAD), d: (i < dur.length - 1 ? starts[i + 1] : total) - (starts[i] - (i ? 0.15 : LEAD)) });

const ITEMS = [
  ['موجوده؟', 'موجودی را واضح بنویس؛ «ناموجود» هم بهتر از سکوت است.'],
  ['کی به دستم می‌رسه؟', 'زمان ارسال تهران و شهرستان را جدا بنویس.'],
  ['هزینه‌ی ارسال چنده؟', 'هزینه‌ی ارسال را قبل از سبد خرید نشان بده.'],
  ['اگه خوب نبود، پس می‌گیرید؟', 'شرایط مرجوعی را در یک خط، کنار دکمه‌ی خرید بنویس.'],
  ['به گوشی من می‌خوره؟', 'مدل‌های سازگار یا جدول سایز را بگذار.']
];
const FA = ['۱', '۲', '۳', '۴', '۵'];
const at = x => x.toFixed(2);

const itemScenes = ITEMS.map(([q, tip], k) => {
  const i = k + 1, sc = scene(i), s0 = starts[i];
  return `
  <div class="scene" style="--s:${at(sc.s)};--d:${at(sc.d)}">
    <div class="num pop" style="--t:${at(s0)}">${FA[k]}</div>
    <div class="ask pop" style="--t:${at(s0 + 0.35)}"><span class="who">مشتری</span>${q}</div>
    <div class="tip pop" style="--t:${at(s0 + 1.6)}"><b>راه‌حل</b>${tip}</div>
  </div>`;
}).join('');

const s6 = scene(6), s7 = scene(7);
const checks = ITEMS.map(([q], k) => `<li class="pop" style="--t:${at(starts[6] + 0.3 + k * 0.45)}"><i>✓</i>${q}</li>`).join('');
// نوار پیشرفت بالای صفحه: هر خانه با شروع سؤال خودش پر می‌شود
const bars = FA.map((_, k) => `<i><b class="fill" style="--t:${at(starts[k + 1])}"></b></i>`).join('');

const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@600;700;800;900&display=swap" rel="stylesheet">
<!-- ریلز ۱: «۵ سؤالی که مشتری قبل از خرید می‌پرسه» · ۱۰۸۰×۱۹۲۰ · ${total} ثانیه · ساخته‌شده با build-reel-01.js -->
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1080px; height: 1920px; overflow: hidden; font-family: 'Vazirmatn', Tahoma, sans-serif; }
  #stage { position: relative; width: 1080px; height: 1920px; overflow: hidden; color: #fff;
    background: linear-gradient(165deg, #19a79e 0%, #12807a 50%, #0b5e59 100%); }
  #stage::before { content: ''; position: absolute; inset: 0;
    background: radial-gradient(circle at 80% 8%, rgba(255,255,255,.22), transparent 42%), radial-gradient(rgba(255,255,255,.08) 2px, transparent 2.2px) 0 0 / 28px 28px; }
  .scene { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 260px 80px 420px; opacity: 0;
    animation: scene calc(var(--d) * 1s) linear calc(var(--s) * 1s) both; }
  @keyframes scene { 0% { opacity: 0; } 4% { opacity: 1; } 95% { opacity: 1; } 100% { opacity: 0; } }
  .pop { animation: pop .55s cubic-bezier(.2,.8,.3,1.25) calc(var(--t) * 1s) both; }
  @keyframes pop { from { opacity: 0; transform: translateY(40px) scale(.94); } to { opacity: 1; transform: none; } }

  .bars { position: absolute; top: 150px; right: 80px; left: 80px; display: flex; gap: 12px; z-index: 5; opacity: 0;
    animation: scene calc(${at(starts[6] - starts[1] + 0.2)} * 1s) linear calc(${at(starts[1] - 0.15)} * 1s) both; }
  .bars i { flex: 1; height: 12px; border-radius: 6px; background: rgba(255,255,255,.25); overflow: hidden; }
  .bars b { display: block; height: 100%; background: #f5b93f; transform-origin: right; transform: scaleX(0);
    animation: fill .5s ease calc(var(--t) * 1s) both; }
  @keyframes fill { to { transform: scaleX(1); } }

  h1 { font-weight: 900; text-align: center; line-height: 1.3; letter-spacing: -.02em; }
  .y { color: #ffd98a; }
  .dm { width: 100%; display: grid; gap: 26px; margin-top: 70px; }
  .dm div { justify-self: start; background: #fff; color: #10292d; font-size: 50px; font-weight: 800; padding: 26px 40px; border-radius: 40px; border-bottom-right-radius: 12px; box-shadow: 0 20px 40px -18px rgba(0,0,0,.45); }
  .dm small { display: block; font-size: 30px; font-weight: 700; color: #b0bec0; margin-top: 4px; }
  .num { width: 230px; height: 230px; border-radius: 64px; background: #f5b93f; color: #3a2503; display: grid; place-items: center; font-size: 150px; font-weight: 900; box-shadow: 0 26px 50px -20px rgba(0,0,0,.5); }
  .ask { margin-top: 80px; align-self: stretch; background: #fff; color: #10292d; font-size: 76px; font-weight: 900; line-height: 1.35; padding: 44px 50px; border-radius: 56px; border-bottom-right-radius: 16px; box-shadow: 0 26px 50px -20px rgba(0,0,0,.45); }
  .ask .who { display: block; font-size: 32px; font-weight: 800; color: #12807a; margin-bottom: 8px; }
  .tip { margin-top: 56px; align-self: stretch; background: rgba(255,255,255,.14); border: 3px solid rgba(255,255,255,.35); border-radius: 44px; padding: 38px 46px; font-size: 54px; font-weight: 800; line-height: 1.55; }
  .tip b { display: block; font-size: 32px; color: #ffd98a; font-weight: 900; margin-bottom: 8px; }
  .list { list-style: none; width: 100%; display: grid; gap: 22px; margin-top: 60px; }
  .list li { display: flex; align-items: center; gap: 26px; background: rgba(255,255,255,.14); border-radius: 30px; padding: 24px 32px; font-size: 50px; font-weight: 800; }
  .list i { flex: none; width: 70px; height: 70px; border-radius: 50%; background: #f5b93f; color: #3a2503; display: grid; place-items: center; font-style: normal; font-size: 42px; font-weight: 900; }
  .save { width: 200px; height: 200px; border-radius: 56px; background: #fff; display: grid; place-items: center; box-shadow: 0 26px 50px -20px rgba(0,0,0,.5); }
  .save svg { width: 110px; height: 110px; fill: #12807a; }
  .brand { display: flex; flex-direction: column; align-items: center; gap: 18px; margin-top: 100px; }
  .brand svg { width: 190px; height: 190px; filter: drop-shadow(0 16px 26px rgba(0,0,0,.3)); }
  .brand b { font-size: 64px; font-weight: 900; } .brand span { font-size: 38px; font-weight: 700; opacity: .9; }
</style></head><body>
<svg width="0" height="0" style="position:absolute"><symbol id="botbubble" viewBox="0 0 100 100">
  <path d="M50 12C27 12 9 27.5 9 46.5c0 9.6 4.6 18.3 12 24.5V88l16.3-8.4c4 1 8.3 1.5 12.7 1.5 23 0 41-15.5 41-34.6S73 12 50 12z" fill="#fff"/>
  <rect x="28" y="30" width="44" height="32" rx="12" fill="#12807a"/><circle cx="40" cy="44" r="5.2" fill="#fff"/><circle cx="60" cy="44" r="5.2" fill="#fff"/>
  <path d="M41 53.5q9 5 18 0" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round"/>
  <line x1="50" y1="30" x2="50" y2="23" stroke="#12807a" stroke-width="3.2" stroke-linecap="round"/><circle cx="50" cy="21" r="3.6" fill="#f5b93f"/></symbol></svg>
<div id="stage">
  <div class="bars">${bars}</div>

  <div class="scene" style="--s:0;--d:${at(scene(0).d)}">
    <h1 class="pop" style="--t:0.1;font-size:92px">مشتری قبل از خرید<br><span class="y">این ۵ سؤال رو می‌پرسه</span></h1>
    <div class="dm">
      <div class="pop" style="--t:1.4">موجوده؟<small>بدون جواب</small></div>
      <div class="pop" style="--t:2.1">کی می‌رسه؟<small>بدون جواب</small></div>
      <div class="pop" style="--t:2.8">هزینه‌ی ارسال؟<small>بدون جواب</small></div>
    </div>
    <h1 class="pop" style="--t:${at(starts[0] + 3.9)};font-size:64px;margin-top:70px">و اگه جواب نگیره، <span class="y">نمی‌خره.</span></h1>
  </div>
${itemScenes}
  <div class="scene" style="--s:${at(s6.s)};--d:${at(s6.d)}">
    <h1 class="pop" style="--t:${at(starts[6])};font-size:70px">هر سؤال بی‌جواب<br><span class="y">= یک مشتری منتظر</span></h1>
    <ul class="list">${checks}</ul>
    <h1 class="pop" style="--t:${at(starts[6] + 4.6)};font-size:58px;margin-top:60px">و مشتری منتظر، زیاد صبر نمی‌کنه.</h1>
  </div>

  <div class="scene" style="--s:${at(s7.s)};--d:${at(s7.d)}">
    <div class="save pop" style="--t:${at(starts[7])}"><svg viewBox="0 0 24 24"><path d="M6 2h12a1 1 0 0 1 1 1v19l-7-4.5L5 22V3a1 1 0 0 1 1-1z"/></svg></div>
    <h1 class="pop" style="--t:${at(starts[7] + 0.4)};font-size:80px;margin-top:60px">ذخیره‌اش کن</h1>
    <h1 class="pop" style="--t:${at(starts[7] + 1.2)};font-size:54px;margin-top:26px;font-weight:800">و همین امروز <span class="y">پرفروش‌ترین محصولت</span> رو<br>با این ۵ سؤال چک کن</h1>
    <div class="brand pop" style="--t:${at(starts[7] + dur[7] - 0.2)}"><svg><use href="#botbubble"/></svg><b>بپرسید</b><span>آموزش فروش آنلاین · beporsid.com</span></div>
  </div>
</div>
<script>window.REEL = ${JSON.stringify({ total, starts, dur })};</script>
</body></html>`;
process.stdout.write(html);
