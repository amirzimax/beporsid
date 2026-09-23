// استخراج متن صفحات وب برای پایگاه دانش (مقالات وبلاگ، صفحات راهنما و...).
// بدون مرورگر: فقط HTML ساده خونده می‌شه (محتوایی که با جاوااسکریپت رندر بشه دیده نمی‌شه).
// لینک‌های داخلی همون سایت تا عمق ۱ و حداکثر MAX_PAGES صفحه دنبال می‌شن، با احترام به robots.txt.
const knowledge = require('./knowledge');
const { assertPublicUrl, safeFetch } = require('./safeurl');

const UA = 'Mozilla/5.0 (compatible; BeporsidBot/1.0; +https://beporsid.com)';
const FETCH_TIMEOUT = 12000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = knowledge.LIMITS.url.maxPages;
const MAX_URL_ITEMS_PER_SHOP = 100;
const SKIP_EXT = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|json|xml|pdf|zip|rar|mp4|mp3|woff2?|ttf)(\?|$)/i;

async function fetchText(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await safeFetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'fa,en;q=0.8' }, signal: controller.signal });
    if (!res.ok) throw new Error(`پاسخ ${res.status} از سایت`);
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) throw new Error('این آدرس یک صفحه‌ی HTML نیست.');
    const buf = Buffer.from(await res.arrayBuffer());
    return { html: buf.subarray(0, MAX_BYTES).toString('utf8'), finalUrl: res.url || url };
  } finally { clearTimeout(t); }
}

// robots.txt ساده: فقط بخش User-agent: * و Disallow ها
const robotsCache = new Map();
async function isAllowed(url) {
  const u = new URL(url);
  const origin = u.origin;
  let rules = robotsCache.get(origin);
  if (!rules) {
    rules = [];
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const r = await safeFetch(origin + '/robots.txt', { headers: { 'User-Agent': UA }, signal: controller.signal });
      clearTimeout(t);
      if (r.ok) {
        const txt = await r.text();
        let applies = false;
        for (const line of txt.split(/\r?\n/)) {
          const l = line.replace(/#.*/, '').trim();
          const m = l.match(/^([a-z-]+)\s*:\s*(.*)$/i);
          if (!m) continue;
          const [, k, v] = m;
          if (/^user-agent$/i.test(k)) applies = v.trim() === '*' || /beporsid/i.test(v);
          else if (applies && /^disallow$/i.test(k) && v.trim()) rules.push(v.trim());
        }
      }
    } catch (e) { /* بدون robots یا در دسترس نبود → مجاز */ }
    robotsCache.set(origin, rules);
  }
  return !rules.some(rule => u.pathname.startsWith(rule));
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '‌', laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return named[e.toLowerCase()] ?? m;
  });
}

// HTML → متن خوانا. بخش‌های غیرمحتوایی (منو، فوتر، اسکریپت) حذف و بلوک‌ها به خط جدید تبدیل می‌شن
function htmlToText(html) {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|form|select|button)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
  const main = h.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (main && main[2].replace(/<[^>]+>/g, '').trim().length > 300) h = main[2];
  else { const body = h.match(/<body[^>]*>([\s\S]*)<\/body>/i); if (body) h = body[1]; }
  h = h
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote|pre|td|th|dd|dt)>/gi, '\n')
    .replace(/<(h[1-6])[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // خط‌های خیلی کوتاه پشت‌سرهم معمولاً باقی‌مانده‌ی منو هستن
  const lines = h.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length < 25 && !/[.!?؟:]$/.test(l)) {
      const near = lines.slice(Math.max(0, i - 2), i + 3).filter(x => x.length < 25).length;
      if (near >= 4) continue;
    }
    kept.push(l);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, knowledge.LIMITS.url.maxChars);
}

function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const t = og ? og[1] : ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  return decodeEntities(t).replace(/\s+/g, ' ').split(/\s[|\-–—]\s/)[0].trim().slice(0, 120);
}

function extractInternalLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const seen = new Set();
  const out = [];
  const re = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u;
    try { u = new URL(m[1], baseUrl); } catch (e) { continue; }
    if (u.hostname !== base.hostname || !/^https?:$/.test(u.protocol)) continue;
    if (SKIP_EXT.test(u.pathname)) continue;
    if (/\/(cart|checkout|login|register|wp-admin|wp-login|account|my-account|tag|feed|search)\b/i.test(u.pathname)) continue;
    u.hash = ''; u.search = '';
    const key = u.href.replace(/\/$/, '');
    if (key === base.href.replace(/\/$/, '') || seen.has(key)) continue;
    seen.add(key);
    out.push(u.href);
  }
  return out;
}

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error('فقط آدرس http/https پذیرفته می‌شود.');
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) throw new Error('آدرس نامعتبر است.');
  u.hash = '';
  return u.href;
}

// یک صفحه رو می‌گیره و به‌عنوان آیتم دانش ثبت/کامل می‌کنه. اگر itemId داده بشه، همون آیتم تکمیل می‌شه
async function processPage(shopId, url, itemId, meta) {
  if (!(await isAllowed(url))) throw new Error('robots.txt این سایت اجازه‌ی خواندن این صفحه را نمی‌دهد.');
  const { html, finalUrl } = await fetchText(url);
  const text = htmlToText(html);
  if (text.length < 80) throw new Error('متن قابل استفاده‌ای در این صفحه پیدا نشد (شاید با جاوااسکریپت ساخته می‌شود).');
  const title = extractTitle(html) || finalUrl;
  if (itemId) {
    knowledge.finishProcessing(itemId, shopId, text, Object.assign({ url: finalUrl, title }, meta || {}));
    const { db } = require('./db');
    db.prepare('UPDATE knowledge_items SET title = ? WHERE id = ?').run(title, itemId);
  } else {
    knowledge.addItem(shopId, 'url', title, text, Object.assign({ url: finalUrl }, meta || {}));
  }
  return { html, finalUrl, title };
}

// شروع کار در پس‌زمینه: صفحه‌ی اصلی + (اختیاری) لینک‌های داخلی‌اش
function startCrawl(shopId, rootItemId, url, followLinks) {
  setImmediate(async () => {
    try {
      const { html, finalUrl } = await processPage(shopId, url, rootItemId, { root: true, depth: 0 });
      if (!followLinks) return;
      const links = extractInternalLinks(html, finalUrl).slice(0, MAX_PAGES - 1);
      let done = 0;
      for (const link of links) {
        if (knowledge.countItems(shopId, 'url') >= MAX_URL_ITEMS_PER_SHOP) break;
        try {
          await processPage(shopId, link, null, { root: false, parent: finalUrl, depth: 1 });
          done++;
        } catch (e) { /* صفحه‌ی غیرقابل‌استفاده رد می‌شه */ }
        await new Promise(r => setTimeout(r, 400)); // فشار روی سایت مشتری نیاریم
      }
      knowledge.finishProcessing(rootItemId, shopId, knowledge.getItem(shopId, rootItemId).content, { linked_pages: done, links_found: links.length });
    } catch (e) {
      knowledge.finishProcessing(rootItemId, shopId, '', null, e.message || 'خطا در خواندن صفحه');
    }
  });
}

module.exports = { normalizeUrl, startCrawl, htmlToText, extractInternalLinks, extractTitle, MAX_PAGES, MAX_URL_ITEMS_PER_SHOP };
