// جلوگیری از SSRF: آدرس سایت فروشگاه و صفحات پایگاه دانش را خودِ کاربر وارد می‌کند، پس هر
// درخواستی که سرور به آن آدرس‌ها می‌زند باید اول بررسی شود. بدون این بررسی می‌شد سرور را وادار
// کرد به شبکه‌ی داخلی خودمان درخواست بزند (مثلاً localhost یا 169.254.169.254 که متادیتای
// سرویس‌های ابری است) و جواب را از دل پیام خطا یا محتوای ذخیره‌شده در پایگاه دانش بیرون کشید.
const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;  // متادیتای سرویس‌های ابری
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;                // multicast و رزروشده
    return false;
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true;
  if (/^(fc|fd|fe80|ff)/.test(v6)) return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (e) { throw new Error('آدرس سایت معتبر نیست.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('فقط آدرس http یا https پذیرفته می‌شود.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('آدرس داخلی یا محلی پذیرفته نمی‌شود.');
    return u;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch (e) { throw new Error('دامنه‌ی واردشده پیدا نشد.'); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
    throw new Error('آدرس داخلی یا محلی پذیرفته نمی‌شود.');
  }
  return u;
}

// fetch امن: قبل از هر پرش (redirect) دوباره آدرس مقصد بررسی می‌شود، وگرنه یک سایت
// می‌توانست ما را با 302 به آدرس داخلی بفرستد و همه‌ی بررسی‌های بالا بی‌اثر می‌شد.
async function safeFetch(url, options = {}, maxRedirects = 3) {
  let current = String(url);
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(current);
    const res = await fetch(current, Object.assign({}, options, { redirect: 'manual' }));
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).href;
      continue;
    }
    return res;
  }
  throw new Error('تعداد تغییر مسیرها بیش از حد مجاز بود.');
}

module.exports = { isPrivateIp, assertPublicUrl, safeFetch };
