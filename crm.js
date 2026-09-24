// ==================== باشگاه مشتریان ====================
// پیامک به کاربران خودِ بپرسید (صاحبان فروشگاه‌ها)، نه به مشتری‌های آن‌ها:
//   - خودکار: خوش‌آمد بعد از ثبت‌نام، یادآوری ۷ روز و ۱ روز مانده به پایان اشتراک، پایان اشتراک
//   - کمپین: پیام مناسبتی یا تبلیغاتی به یک گروه از کاربران، فوری یا زمان‌بندی‌شده
//
// چند قاعده که عمداً سخت‌گیرانه است:
//   - پیام‌های خودکار پیش‌فرض خاموش‌اند؛ تا مدیر روشنشان نکند برای کسی چیزی نمی‌رود.
//   - پیام تبلیغاتی/مناسبتی فقط از خط تبلیغاتی و با «لغو۱۱» فرستاده می‌شود و به کسانی که
//     انصراف داده‌اند نمی‌رود؛ ارسال تبلیغ از خط خدماتی ممکن است خط را مسدود کند.
//   - غیر از خوش‌آمد، هیچ پیامکی بیرون از ساعت ۹ تا ۲۱ به وقت تهران ارسال نمی‌شود.
//   - هر یادآوری برای هر تاریخ انقضا فقط یک بار (کلید یکتا در sms_log).

const {
  getSmsAutomation, listSmsRecipients, reserveSmsLog, completeSmsLog, countSmsFailures,
  releaseSmsDedup, dueSmsCampaigns, claimSmsCampaign, getSmsCampaign, updateSmsCampaign,
  createSmsCampaign, failStaleSmsCampaigns
} = require('./db');
const billing = require('./billing');

const API_KEY = process.env.KAVENEGAR_API_KEY || '';
const SERVICE_SENDER = String(process.env.KAVENEGAR_SENDER || '').trim();      // خوش‌آمد و یادآوری‌ها
const ADS_SENDER = String(process.env.KAVENEGAR_ADS_SENDER || '').trim();      // مناسبتی و تبلیغاتی
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://api.beporsid.com/dashboard.html';

const SEND_HOURS = { from: 9, to: 21 };      // به وقت تهران
const BATCH_SIZE = 100;                       // کاوه‌نگار در هر درخواست sendarray تا ۲۰۰ شماره می‌پذیرد
const MAX_RETRIES = 3;
const OPT_OUT_SUFFIX = '\nلغو۱۱';

const PAID_PLANS = Object.values(billing.PLANS).filter(p => !p.free).map(p => p.id);

// ---------- کمکی‌ها ----------
const faNum = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const parseUtc = s => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function planName(plan) {
  return (billing.PLANS[plan] && billing.PLANS[plan].name) || 'آغازین';
}

function faDate(utc) {
  const d = parseUtc(utc);
  if (!d || isNaN(d)) return '';
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', timeZone: 'Asia/Tehran' }).format(d);
  } catch (e) {
    return faNum(d.toISOString().slice(0, 10));
  }
}

function tehranHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Tehran' }).format(d)) % 24;
}
function inSendingHours() {
  const h = tehranHour();
  return h >= SEND_HOURS.from && h < SEND_HOURS.to;
}

// متغیرهای قابل‌استفاده در متن پیام
const VARIABLES = {
  name: 'نام کاربر',
  shop: 'نام فروشگاه',
  plan: 'نام پلن',
  days: 'روزهای باقی‌مانده',
  expiry: 'تاریخ پایان اشتراک',
  link: 'لینک ورود به پنل'
};

function render(body, shop) {
  const exp = parseUtc(shop.plan_expires_at);
  const days = exp ? Math.max(0, Math.ceil((exp - Date.now()) / 86400000)) : null;
  const vars = {
    name: String(shop.owner_name || '').trim() || 'کاربر',
    shop: String(shop.shop_name || '').trim() || 'فروشگاه شما',
    plan: planName(shop.plan),
    days: days == null ? '' : faNum(days),
    expiry: faDate(shop.plan_expires_at),
    link: DASHBOARD_URL
  };
  return String(body).replace(/\{(name|shop|plan|days|expiry|link)\}/g, (_, k) => vars[k]);
}

// تعداد بخش‌های پیامک؛ هزینه به ازای هر بخش حساب می‌شود. متن فارسی یونی‌کد است:
// تک‌بخشی تا ۷۰ نویسه، و در پیام چندبخشی هر بخش ۶۷ نویسه.
function smsParts(text) {
  const len = [...String(text)].length;
  if (!len) return 0;
  if (/[^\x00-\x7F]/.test(text)) return len <= 70 ? 1 : Math.ceil(len / 67);
  return len <= 160 ? 1 : Math.ceil(len / 153);
}

// ---------- گروه‌های مخاطب ----------
function isPaidActive(s) {
  const exp = parseUtc(s.plan_expires_at);
  return PAID_PLANS.includes(s.plan) && !!exp && exp > Date.now();
}
function isPaidExpired(s) {
  const exp = parseUtc(s.plan_expires_at);
  return PAID_PLANS.includes(s.plan) && !!exp && exp <= Date.now();
}

const AUDIENCES = {
  all:         { label: 'همه‌ی کاربران',                    test: () => true },
  free:        { label: 'کاربران پلن رایگان',               test: s => !isPaidActive(s) && !isPaidExpired(s) },
  paid:        { label: 'مشترکان فعالِ پلن پولی',           test: isPaidActive },
  expired:     { label: 'کسانی که اشتراکشان تمام شده',       test: isPaidExpired },
  recent:      { label: 'ثبت‌نام در ۷ روز اخیر',             test: s => { const c = parseUtc(s.created_at); return !!c && Date.now() - c < 7 * 86400000; } },
  unconnected: { label: 'هنوز فروشگاهشان را وصل نکرده‌اند',  test: s => !s.store_connected }
};

function selectAudience(key, { excludeOptOut = true } = {}) {
  const a = AUDIENCES[key];
  if (!a) return [];
  return listSmsRecipients().filter(s => a.test(s) && !(excludeOptOut && s.sms_marketing_opt_out));
}

function audienceCounts() {
  const all = listSmsRecipients();
  return Object.entries(AUDIENCES).map(([key, a]) => {
    const matched = all.filter(a.test);
    return { key, label: a.label, total: matched.length, reachable: matched.filter(s => !s.sms_marketing_opt_out).length };
  });
}

// ---------- ارسال از طریق کاوه‌نگار ----------
// یک مسیر برای همه‌چیز: sendarray اجازه می‌دهد هر گیرنده متن شخصی‌سازی‌شده‌ی خودش را بگیرد.
async function kavenegarSendArray(items) {
  if (!API_KEY) throw new Error('کلید کاوه‌نگار (KAVENEGAR_API_KEY) تنظیم نشده است.');
  const form = new URLSearchParams();
  form.append('receptor', JSON.stringify(items.map(i => i.phone)));
  form.append('sender', JSON.stringify(items.map(i => i.sender)));
  form.append('message', JSON.stringify(items.map(i => i.message)));

  const res = await fetch(`https://api.kavenegar.com/v1/${API_KEY}/sms/sendarray.json`, { method: 'POST', body: form });
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('پاسخ نامعتبر از سرویس پیامک.'); }
  if (!data || !data.return || data.return.status !== 200) {
    throw new Error((data && data.return && data.return.message) || 'ارسال پیامک ناموفق بود.');
  }
  return Array.isArray(data.entries) ? data.entries : [];
}

async function getCredit() {
  if (!API_KEY) return null;
  try {
    const res = await fetch(`https://api.kavenegar.com/v1/${API_KEY}/account/info.json`);
    const data = await res.json();
    if (!data.return || data.return.status !== 200) return null;
    return { remaincredit: data.entries && data.entries.remaincredit, expiredate: data.entries && data.entries.expiredate };
  } catch (e) {
    return null;
  }
}

// ارسال تکی با ثبت در sms_log. اگر dedupKey قبلاً ارسال شده باشد، کاری نمی‌کند.
async function sendOne({ shop, phone, body, kind, ref, dedupKey, sender }) {
  const logId = reserveSmsLog({ shop_id: shop && shop.id, phone, kind, ref, dedup_key: dedupKey, body });
  if (!logId) return { skipped: true };
  try {
    const [entry] = await kavenegarSendArray([{ phone, message: body, sender }]);
    completeSmsLog(logId, { status: 'sent', provider_id: entry && entry.messageid });
    return { ok: true };
  } catch (e) {
    completeSmsLog(logId, { status: 'failed', error: e.message });
    // قفل را آزاد می‌کنیم تا در اجرای بعدی دوباره تلاش شود (تا سقف MAX_RETRIES)
    if (dedupKey) releaseSmsDedup(logId);
    return { ok: false, error: e.message };
  }
}

// ---------- پیام‌های خودکار ----------
async function sendWelcome(shop) {
  const a = getSmsAutomation('welcome');
  if (!a || !a.enabled || !shop || !shop.phone) return;
  if (!SERVICE_SENDER) { console.error('پیامک خوش‌آمد فرستاده نشد: KAVENEGAR_SENDER تنظیم نشده است.'); return; }
  const r = await sendOne({
    shop, phone: shop.phone, body: render(a.body, shop), kind: 'welcome',
    ref: `welcome:${shop.id}`, dedupKey: `welcome:${shop.id}`, sender: SERVICE_SENDER
  });
  if (r.error) console.error('خطای پیامک خوش‌آمد:', r.error);
}

// کدام یادآوری برای این کاربر وقتش رسیده؟ پنجره‌ها پشت‌سرهم‌اند تا هر کاربر در هر دوره‌ی
// اشتراک حداکثر یک بار از هر نوع پیام بگیرد.
function reminderFor(s, now = Date.now()) {
  if (!PAID_PLANS.includes(s.plan)) return null;
  const exp = parseUtc(s.plan_expires_at);
  if (!exp) return null;
  const hoursLeft = (exp - now) / 3600000;
  if (hoursLeft > 36 && hoursLeft <= 7 * 24) return 'renew_7';
  if (hoursLeft > 0 && hoursLeft <= 36) return 'renew_1';
  if (hoursLeft <= 0 && hoursLeft > -72) return 'expired';
  return null;
}

async function runReminders() {
  if (!SERVICE_SENDER || !inSendingHours()) return;
  const autos = {};
  for (const k of ['renew_7', 'renew_1', 'expired']) autos[k] = getSmsAutomation(k);
  if (!Object.values(autos).some(a => a && a.enabled)) return;

  for (const s of listSmsRecipients()) {
    const key = reminderFor(s);
    if (!key || !autos[key] || !autos[key].enabled) continue;
    // کلید شامل تاریخ انقضاست: با تمدید، تاریخ عوض می‌شود و دوره‌ی بعد دوباره یادآوری می‌گیرد
    const dedup = `${key}:${s.id}:${s.plan_expires_at}`;
    if (countSmsFailures(dedup) >= MAX_RETRIES) continue;
    await sendOne({ shop: s, phone: s.phone, body: render(autos[key].body, s), kind: key, ref: dedup, dedupKey: dedup, sender: SERVICE_SENDER });
  }
}

// ---------- کمپین‌ها ----------
async function runCampaign(id) {
  if (!claimSmsCampaign(id)) return;
  const c = getSmsCampaign(id);
  if (!ADS_SENDER) {
    updateSmsCampaign(id, { status: 'failed', error: 'خط تبلیغاتی (KAVENEGAR_ADS_SENDER) تنظیم نشده است.', finished_at: nowSql() });
    return;
  }

  const recipients = selectAudience(c.audience, { excludeOptOut: true });
  updateSmsCampaign(id, { total: recipients.length });
  let sent = 0, failed = 0, skipped = 0, lastError = null;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const items = [];
    for (const s of recipients.slice(i, i + BATCH_SIZE)) {
      const body = render(c.body, s) + OPT_OUT_SUFFIX;
      // کلید یکتا به ازای کمپین و کاربر: اگر کمپین به هر دلیلی دوباره اجرا شود، کسی دو بار پیام نمی‌گیرد
      const logId = reserveSmsLog({ shop_id: s.id, phone: s.phone, kind: 'campaign', ref: `campaign:${id}`, dedup_key: `campaign:${id}:${s.id}`, body });
      if (!logId) { skipped++; continue; }
      items.push({ logId, phone: s.phone, message: body, sender: ADS_SENDER });
    }
    if (items.length) {
      try {
        const entries = await kavenegarSendArray(items);
        items.forEach((it, idx) => completeSmsLog(it.logId, { status: 'sent', provider_id: entries[idx] && entries[idx].messageid }));
        sent += items.length;
      } catch (e) {
        lastError = e.message;
        items.forEach(it => completeSmsLog(it.logId, { status: 'failed', error: e.message }));
        failed += items.length;
      }
    }
    updateSmsCampaign(id, { sent, failed, skipped });
    if (i + BATCH_SIZE < recipients.length) await sleep(1500);
  }

  updateSmsCampaign(id, {
    status: sent === 0 && failed > 0 ? 'failed' : 'sent',
    sent, failed, skipped, error: lastError, finished_at: nowSql()
  });
}

function validateCampaign({ title, kind, audience, body }) {
  if (!title || !String(title).trim()) return 'عنوان کمپین را وارد کنید.';
  if (!['promo', 'occasion'].includes(kind)) return 'نوع کمپین نامعتبر است.';
  if (!AUDIENCES[audience]) return 'گروه مخاطب نامعتبر است.';
  if (!body || !String(body).trim()) return 'متن پیام خالی است.';
  if (String(body).length > 700) return 'متن پیام بیش از حد طولانی است (حداکثر ۷۰۰ نویسه).';
  return null;
}

// ساخت کمپین. «ارسال فوری» بیرون از ساعت مجاز، خودکار برای ساعت ۹ صبح بعدی می‌ماند.
function scheduleCampaign({ title, kind, audience, body, scheduled_at }) {
  const campaign = createSmsCampaign({
    title: String(title).trim().slice(0, 120), kind, audience, body: String(body).trim(),
    scheduled_at: scheduled_at || null
  });
  const deferred = !scheduled_at && !inSendingHours();
  if (!scheduled_at && !deferred) setImmediate(() => runCampaign(campaign.id).catch(e => console.error('خطای کمپین:', e.message)));
  return { campaign, deferred };
}

async function sendTest(shop, body, channel) {
  const sender = channel === 'ads' ? ADS_SENDER : SERVICE_SENDER;
  if (!sender) {
    throw new Error(channel === 'ads'
      ? 'خط تبلیغاتی (KAVENEGAR_ADS_SENDER) در .env تنظیم نشده است.'
      : 'خط خدماتی (KAVENEGAR_SENDER) در .env تنظیم نشده است.');
  }
  if (!shop.phone) throw new Error('شماره‌ی موبایل حساب شما ثبت نشده است.');
  const text = render(body, shop) + (channel === 'ads' ? OPT_OUT_SUFFIX : '');
  const r = await sendOne({ shop, phone: shop.phone, body: text, kind: 'test', ref: 'test', sender });
  if (!r.ok) throw new Error(r.error || 'ارسال آزمایشی ناموفق بود.');
  return { text, parts: smsParts(text) };
}

function status() {
  return {
    api_key: !!API_KEY,
    service_sender: !!SERVICE_SENDER,
    ads_sender: !!ADS_SENDER,
    in_sending_hours: inSendingHours(),
    send_hours: SEND_HOURS
  };
}

// ---------- زمان‌بند ----------
let ticking = false;
async function tick() {
  if (ticking) return;       // اجرای قبلی هنوز تمام نشده
  ticking = true;
  try {
    failStaleSmsCampaigns();
    await runReminders();
    if (inSendingHours()) {
      for (const { id } of dueSmsCampaigns()) await runCampaign(id);
    }
  } catch (e) {
    console.error('خطای زمان‌بند باشگاه مشتریان:', e.message);
  } finally {
    ticking = false;
  }
}

function startScheduler() {
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, 5 * 60 * 1000).unref();
}

module.exports = {
  AUDIENCES, VARIABLES, OPT_OUT_SUFFIX,
  render, smsParts, reminderFor, selectAudience, audienceCounts,
  validateCampaign, scheduleCampaign, runCampaign, runReminders, sendWelcome, sendTest,
  getCredit, status, startScheduler, tick
};
