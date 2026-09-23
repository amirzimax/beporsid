// اتصال به Bot API تلگرام. هر فروشگاه ربات خودش را در BotFather می‌سازد و توکنش را در پنل
// وارد می‌کند؛ ما فقط با همان توکن به اسم او پیام می‌فرستیم و می‌گیریم.
// توکن هرگز اینجا لاگ نمی‌شود (در URL تلگرام است و لو رفتنش یعنی کنترل کامل ربات مشتری).
const API = 'https://api.telegram.org';

// خطای تلگرام را با پیام فارسی قابل‌فهم بالا می‌فرستد، بدون افشای توکن
async function call(token, method, body) {
  let res;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  } catch (e) {
    throw new Error('ارتباط با سرور تلگرام برقرار نشد.');
  }
  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error('پاسخ نامعتبر از تلگرام.'); }

  if (!data.ok) {
    const err = new Error(data.description || 'درخواست تلگرام ناموفق بود.');
    err.telegramCode = data.error_code;
    throw err;
  }
  return data.result;
}

// اعتبارسنجی توکن: اگر درست باشد مشخصات ربات را برمی‌گرداند
function getMe(token) {
  return call(token, 'getMe');
}

// secret در هدر X-Telegram-Bot-Api-Secret-Token برمی‌گردد و در وب‌هوک بررسی می‌شود؛
// یعنی حتی اگر کسی آدرس وب‌هوک را حدس بزند، بدون این مقدار چیزی ثبت نمی‌شود.
function setWebhook(token, url, secret) {
  return call(token, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  });
}

function deleteWebhook(token) {
  return call(token, 'deleteWebhook', { drop_pending_updates: true });
}

// تلگرام سقف ۴۰۹۶ کاراکتری برای هر پیام دارد
function sendMessage(token, chatId, text, opts) {
  return call(token, 'sendMessage', Object.assign({
    chat_id: chatId,
    text: String(text || '').slice(0, 4096),
    disable_web_page_preview: true
  }, opts || {}));
}

function answerCallbackQuery(token, id, text) {
  return call(token, 'answerCallbackQuery', { callback_query_id: id, text: text || '' });
}

// متن پیام‌ها با parse_mode ارسال نمی‌شود (جواب هوش مصنوعی ممکنه کاراکتر خاص داشته باشه و
// تلگرام کل پیام رو رد کنه)، پس این فقط برای متن‌های ثابت خودمان است.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// کارت محصولات زیر جواب دستیار، به‌صورت متن ساده چون تلگرام کارت مثل ویجت ندارد
function formatProducts(products, searchLink, searchLabel) {
  if (!products || !products.length) return '';
  const lines = products.map(p => {
    const price = p.price != null && p.price !== '' ? `${Number(p.price).toLocaleString('en-US')} تومان` : 'قیمت نامشخص';
    return p.link ? `• ${p.title} — ${price}\n${p.link}` : `• ${p.title} — ${price}`;
  });
  let out = '\n\n📦 محصولات مرتبط:\n' + lines.join('\n');
  if (searchLink) out += `\n\n🔎 ${searchLabel || 'مشاهده همه'}:\n${searchLink}`;
  return out;
}

module.exports = {
  getMe, setWebhook, deleteWebhook, sendMessage, answerCallbackQuery,
  formatProducts, escapeHtml
};
