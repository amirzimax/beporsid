// ==================== اعلان‌های مدیریتی ====================
// پیام فوری به مدیر سیستم برای اتفاق‌هایی که نباید دیر فهمیده شوند: ثبت‌نام، پرداخت موفق یا
// ناتمام، خطای درگاه، قطع سرویس هوش مصنوعی، کرش سرور و بکاپ شبانه.
//
// ربات جداگانه‌ای لازم نیست: از همان ربات تلگرامی استفاده می‌شود که مدیر (شماره‌های
// ADMIN_PHONES) در بخش «ربات تلگرام» حساب خودش وصل کرده است.

const { listAdminAlertTargets, decrypt } = require('./db');
const telegram = require('./telegram');

// همان نرمال‌سازی server.js؛ این ماژول در اسکریپت بکاپ (پروسه‌ی جدا) هم استفاده می‌شود
function normalizePhone(raw) {
  let s = String(raw || '')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[^\d]/g, '');
  if (s.startsWith('0098')) s = s.slice(4);
  else if (s.startsWith('98') && s.length > 10) s = s.slice(2);
  if (s.length > 1 && s[0] === '9') s = '0' + s;
  return s;
}
const ADMIN_PHONES = new Set(
  String(process.env.ADMIN_PHONES || '').split(',').map(normalizePhone).filter(p => /^09\d{9}$/.test(p))
);

function targets() {
  try {
    return listAdminAlertTargets(ADMIN_PHONES)
      .map(t => ({ name: t.shop_name || t.phone, chatId: t.telegram_owner_chat_id, token: decrypt(t.telegram_bot_token_enc) }))
      .filter(t => t.token);
  } catch (e) {
    console.error('خطای خواندن گیرندگان اعلان مدیریتی:', e.message);
    return [];
  }
}

// هر نوع خطا (key) حداکثر یک بار در بازه‌ی throttleMs اعلان می‌شود تا وقتی مثلاً سرویس
// هوش مصنوعی قطع است، به ازای هر پیام مشتری یک اعلان نیاید.
const lastSent = new Map();

async function notifyAdmins(text, { key, throttleMs = 30 * 60 * 1000 } = {}) {
  if (key) {
    const last = lastSent.get(key);
    if (last && Date.now() - last < throttleMs) return;
    lastSent.set(key, Date.now());
  }
  const list = targets();
  if (!list.length) return;
  await Promise.all(list.map(t =>
    telegram.sendMessage(t.token, t.chatId, text)
      .catch(e => console.error('خطای ارسال اعلان مدیریتی:', e.message))));
}

// نسخه‌ی «بفرست و فراموش کن» برای جاهایی که نباید منتظر تلگرام بمانند
function notify(text, opts) {
  notifyAdmins(text, opts).catch(e => console.error('خطای اعلان مدیریتی:', e.message));
}

async function sendAdminDocument(buffer, filename, caption) {
  const list = targets();
  if (!list.length) throw new Error('هیچ حساب مدیری ربات تلگرام وصل‌شده ندارد.');
  let ok = 0;
  for (const t of list) {
    try { await telegram.sendDocument(t.token, t.chatId, buffer, filename, caption); ok++; }
    catch (e) { console.error('خطای ارسال فایل به مدیر:', e.message); }
  }
  if (!ok) throw new Error('ارسال فایل به تلگرام مدیر ناموفق بود.');
  return ok;
}

function status() {
  return { admin_phones: ADMIN_PHONES.size, targets: targets().map(t => t.name) };
}

const toman = n => Number(n || 0).toLocaleString('en-US') + ' تومان';

module.exports = { notify, notifyAdmins, sendAdminDocument, status, toman };
