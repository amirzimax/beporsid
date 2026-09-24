// ==================== گزارش هفتگی صاحب فروشگاه ====================
// شنبه‌ها ساعت ۱۰ صبح به وقت تهران، خلاصه‌ی هفته‌ی گذشته (شنبه تا جمعه) برای هر فروشگاه:
// چند گفتگو، چند سؤال جواب داده شد، چند بار محصول پیشنهاد شد، چند مشتری شماره گذاشت.
// هدف: صاحب فروشگاه هر هفته ببیند دستیار برایش چه کرده (مهم‌ترین دلیل تمدید اشتراک).
//
// کانال: اگر ربات تلگرام فروشگاه وصل و به صاحبش لینک شده، با همان ربات (رایگان)؛ وگرنه
// پیامک خودکار «weekly_report» در باشگاه مشتریان، که پیش‌فرض خاموش است.

const {
  periodStats, listWeeklyReportShops, claimWeeklyReport, getMonthlyUsage, countOpenKnowledgeGaps, decrypt
} = require('./db');
const billing = require('./billing');
const telegram = require('./telegram');
const crm = require('./crm');
const alerts = require('./alerts');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://api.beporsid.com/dashboard.html';
const DAY = 86400000;
// ایران از ۱۴۰۱ ساعت تابستانی ندارد؛ تهران همیشه UTC+3:30 است
const TEHRAN_OFFSET = 210 * 60000;
const SEND_HOURS = { from: 10, to: 20 };

const fa = n => crm.faNum(n);
const sqlTime = ts => new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
function faDay(ts) {
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', timeZone: 'Asia/Tehran' }).format(new Date(ts));
  } catch (e) {
    return fa(new Date(ts).toISOString().slice(0, 10));
  }
}

// هفته‌ی کاری ایران: شنبه ۰۰:۰۰ تا جمعه ۲۳:۵۹ به وقت تهران
function weekWindow(now = Date.now()) {
  const t = new Date(now + TEHRAN_OFFSET);             // ساعت تهران در فیلدهای UTC
  const sinceSaturday = (t.getUTCDay() + 1) % 7;       // شنبه = ۰
  const saturdayLocal = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - sinceSaturday);
  const end = saturdayLocal - TEHRAN_OFFSET;
  return {
    week: new Date(saturdayLocal).toISOString().slice(0, 10),
    start: end - 7 * DAY, end, prevStart: end - 14 * DAY,
    isSaturday: sinceSaturday === 0, hour: t.getUTCHours(),
    label: `${faDay(end - 7 * DAY)} تا ${faDay(end - 1)}`
  };
}

// برای «مشاهده‌ی گزارش» در پنل: ۷ روز گذشته تا همین لحظه
function rollingWindow(now = Date.now()) {
  return { start: now - 7 * DAY, end: now, prevStart: now - 14 * DAY, label: '۷ روز گذشته' };
}

function buildReport(shop, w) {
  const s = periodStats(shop.id, sqlTime(w.start), sqlTime(w.end));
  const p = periodStats(shop.id, sqlTime(w.prevStart), sqlTime(w.start));
  const plan = billing.PLANS[shop.plan] || billing.PLANS.starter;
  const used = getMonthlyUsage(shop.id);
  const usedPct = plan.responses ? Math.round(used / plan.responses * 100) : 0;

  const trend = p.conversations ? ` (هفته‌ی قبل: ${fa(p.conversations)})` : '';
  const lines = [
    `📊 گزارش هفتگی بپرسید — ${shop.shop_name || 'فروشگاه شما'}`,
    w.label,
    '',
    `💬 ${fa(s.conversations)} گفتگو با مشتری‌ها${trend}`,
    `❓ ${fa(s.questions)} سؤال جواب داده شد`,
    `🛍 ${fa(s.product_msgs)} بار محصول پیشنهاد شد`
  ];
  if (s.leads) lines.push(`📞 ${fa(s.leads)} مشتری شماره‌ی تماس گذاشتند`);
  if (s.handoffs) lines.push(`🙋 ${fa(s.handoffs)} گفتگو به شما سپرده شد`);
  lines.push('', `مصرف این ماه: ${fa(used)} از ${fa(plan.responses)} پاسخ (${fa(usedPct)}٪)`);
  if (plan.free && usedPct >= 80) {
    lines.push('⚠️ سهمیه‌ی ماهانه رو به اتمام است؛ برای اینکه دستیار وسط ماه از جواب دادن نماند، پلن را ارتقا دهید.');
  }
  const gaps = countOpenKnowledgeGaps(shop.id);
  if (gaps) lines.push(`📝 ${fa(gaps)} سؤال مشتری بی‌جواب ماند؛ جوابشان را در «پایگاه دانش» اضافه کنید تا دفعه‌ی بعد دستیار جواب بدهد.`);
  if (!s.conversations && p.conversations) {
    lines.push('⚠️ این هفته هیچ گفتگویی ثبت نشد. ویجت هنوز روی سایت هست؟ «وضعیت نصب» را در پنل ببینید.');
  }
  lines.push('', `پنل: ${DASHBOARD_URL}`);

  return {
    stats: s, prev: p, used, limit: plan.responses,
    hasActivity: s.conversations > 0 || p.conversations > 0,
    text: lines.join('\n'),
    smsVars: { conversations: fa(s.conversations), questions: fa(s.questions), products: fa(s.product_msgs), leads: fa(s.leads) }
  };
}

// اول تلگرام (رایگان)؛ اگر ربات وصل نبود یا ارسال خطا داد، پیامک (اگر در باشگاه مشتریان روشن باشد)
async function deliver(shop, report, week) {
  if (shop.telegram_bot_token_enc && shop.telegram_owner_chat_id) {
    try {
      await telegram.sendMessage(decrypt(shop.telegram_bot_token_enc), shop.telegram_owner_chat_id, report.text);
      return 'telegram';
    } catch (e) {
      console.error('خطای ارسال گزارش هفتگی در تلگرام:', shop.id, e.message);
    }
  }
  const r = await crm.sendAutomation('weekly_report', shop, { vars: report.smsVars, dedupKey: `weekly_report:${shop.id}:${week}` });
  return r && r.ok ? 'sms' : null;
}

let running = false;
async function runWeeklyReports(now = Date.now()) {
  const w = weekWindow(now);
  if (!w.isSaturday || w.hour < SEND_HOURS.from || w.hour >= SEND_HOURS.to || running) return null;
  running = true;
  const summary = { telegram: 0, sms: 0, none: 0, quiet: 0 };
  try {
    for (const shop of listWeeklyReportShops()) {
      if (shop.weekly_report_week === w.week || !claimWeeklyReport(shop.id, w.week)) continue;
      try {
        const report = buildReport(shop, w);
        // فروشگاهی که دو هفته هیچ گفتگویی نداشته، گزارش صفر نمی‌گیرد
        if (!report.hasActivity) { summary.quiet++; continue; }
        summary[(await deliver(shop, report, w.week)) || 'none']++;
      } catch (e) {
        console.error('خطای گزارش هفتگی فروشگاه', shop.id, e.message);
        summary.none++;
      }
    }
  } finally {
    running = false;
  }
  if (summary.telegram || summary.sms || summary.none) {
    alerts.notify(`📊 گزارش هفتگی فروشگاه‌ها فرستاده شد\n` +
      `${fa(summary.telegram)} تلگرام · ${fa(summary.sms)} پیامک · ${fa(summary.none)} بدون کانال فعال\n` +
      `(${fa(summary.quiet)} فروشگاه بدون گفتگو در دو هفته‌ی اخیر گزارش نگرفتند)`);
  }
  return summary;
}

function startScheduler() {
  const tick = () => runWeeklyReports().catch(e => console.error('خطای زمان‌بند گزارش هفتگی:', e.message));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
}

module.exports = { weekWindow, rollingWindow, buildReport, runWeeklyReports, startScheduler };
