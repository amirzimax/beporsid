// اتصال به درگاه پرداخت زرین‌پال (REST API کلاسیک v4 — همون چیزی که merchant_id براش کافیه؛
// جدا از GraphQL broker جدیدتر زرین‌پال که نیاز به توکن API جداگانه داره).
// مستندات: https://www.zarinpal.com/docs/paymentGateway/

const ZARINPAL_MERCHANT_ID = process.env.ZARINPAL_MERCHANT_ID;
const SANDBOX = process.env.ZARINPAL_SANDBOX === 'true';

if (!ZARINPAL_MERCHANT_ID) {
  console.error('هشدار: ZARINPAL_MERCHANT_ID تنظیم نشده - پرداخت اشتراک کار نمی‌کند (بقیه‌ی سرور طبیعی اجرا می‌شود).');
}

const API_BASE = SANDBOX ? 'https://sandbox.zarinpal.com' : 'https://api.zarinpal.com';
const STARTPAY_BASE = SANDBOX ? 'https://sandbox.zarinpal.com/pg/StartPay/' : 'https://www.zarinpal.com/pg/StartPay/';
const REQUEST_URL = `${API_BASE}/pg/v4/payment/request.json`;
const VERIFY_URL = `${API_BASE}/pg/v4/payment/verify.json`;

// --- پلن‌ها ---
// «responses» یعنی تعداد پاسخ‌هایی که دستیار در ماه می‌تونه بده (نه تعداد گفتگو، چون یک
// گفتگو می‌تونه چند پاسخ داشته باشه) - دقیقاً همون واحدی که تو تعرفه به مشتری نشون داده می‌شه.
// «channels» فقط برای نمایش در تعرفه‌ست؛ فعلاً فقط «widget» واقعاً پیاده‌سازی شده - بقیه در UI
// با برچسب «به‌زودی» نشون داده می‌شن تا چیزی که هنوز وجود نداره فروخته نشه.
//
// قیمت‌گذاری: هزینه‌ی هوش مصنوعی هر «پاسخ» بر اساس تعرفه‌ی مدل روی GapGPT (ورودی ۰.۱۰$ و خروجی
// ۰.۴۰$ به‌ازای هر میلیون توکن) و یک فرض محافظه‌کارانه‌ی ~۲۵۵۰ توکن به‌ازای هر پاسخ (پرامپت سیستمی +
// نتیجه‌ی جست‌وجوی محصول + تاریخچه‌ی گفتگو که هر بار همراه پیام ارسال می‌شه) تخمین زده شده: تقریباً
// ۶۸ تومان هزینه‌ی واقعی به‌ازای هر پاسخ (با نرخ ۱$ ≈ ۲۲۵,۰۰۰ تومان). همه‌ی قیمت‌های زیر طوری تنظیم
// شدن که حتی در پرداخت سالانه هم حداقل ۵ برابر همین هزینه باشن. چون مصرف توکن فعلاً لاگ نمی‌شه، این
// فقط یک تخمین محافظه‌کارانه‌ست - وقتی لاگ واقعی اضافه شد باید این اعداد بازبینی بشن.
const PLANS = {
  starter: {
    id: 'starter', name: 'آغازین', free: true,
    price: 0, yearlyPerMonth: 0,
    responses: 200, products: 20, qa: 50, links: 2, files: 2,
    channels: ['widget']
  },
  growth: {
    id: 'growth', name: 'رشد',
    price: 1190000, yearlyPerMonth: 1050000, overage: 650,
    responses: 3000, products: 3000, qa: 200, links: 10, files: 10,
    channels: ['widget', 'telegram', 'instagram', 'eitaa', 'bale']
  },
  business: {
    id: 'business', name: 'تجاری',
    price: 8900000, yearlyPerMonth: 8600000, overage: 500,
    responses: 25000, products: 20000, qa: 1000, links: 50, files: 50,
    channels: ['widget', 'telegram', 'instagram', 'eitaa', 'bale']
  }
};
// «سازمانی» عمداً اینجا نیست - قیمت و منابعش ثابت نیست و فقط از طریق تماس فروخته می‌شه

// مبلغ‌ها همه‌جای پروژه به تومان نگه‌داری می‌شن؛ فقط لحظه‌ی ارسال به زرین‌پال ضربدر ۱۰ (ریال) می‌شن
function tomanToRial(toman) { return Math.round(toman) * 10; }

async function zarinpalRequest(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error('پاسخ نامعتبر از درگاه پرداخت.'); }
  return { res, data };
}

// درخواست ساخت تراکنش - در صورت موفقیت authority برمی‌گردونه که باید کاربر رو به
// STARTPAY_BASE + authority هدایت کنیم
async function requestPayment({ amountToman, description, callbackUrl, mobile, email }) {
  if (!ZARINPAL_MERCHANT_ID) throw new Error('درگاه پرداخت هنوز در سرور تنظیم نشده است.');
  const { res, data } = await zarinpalRequest(REQUEST_URL, {
    merchant_id: ZARINPAL_MERCHANT_ID,
    amount: tomanToRial(amountToman),
    description,
    callback_url: callbackUrl,
    metadata: { mobile: mobile || undefined, email: email || undefined }
  });

  const code = data?.data?.code;
  if (!res.ok || code !== 100) {
    const msg = data?.errors?.message || (Array.isArray(data?.data?.errors) ? data.data.errors.join('، ') : null) || 'خطا در ایجاد تراکنش پرداخت.';
    console.error('خطای درخواست پرداخت زرین‌پال:', code, JSON.stringify(data).slice(0, 300));
    throw new Error(msg);
  }
  return { authority: data.data.authority };
}

// تأیید تراکنش بعد از بازگشت کاربر از درگاه. هرگز به پارامتر Status=OK که خودِ زرین‌پال در URL
// برمی‌گردونه اعتماد نمی‌کنیم - همیشه این تابع (که مستقیم با سرور زرین‌پال چک می‌کنه) منبع حقیقته.
// کد 100 یعنی تأیید موفق؛ 101 یعنی قبلاً تأیید شده (نباید دوباره پول کم بشه، ولی باز موفقه).
async function verifyPayment({ amountToman, authority }) {
  if (!ZARINPAL_MERCHANT_ID) throw new Error('درگاه پرداخت هنوز در سرور تنظیم نشده است.');
  const { res, data } = await zarinpalRequest(VERIFY_URL, {
    merchant_id: ZARINPAL_MERCHANT_ID,
    amount: tomanToRial(amountToman),
    authority
  });

  const code = data?.data?.code;
  if (!res.ok || (code !== 100 && code !== 101)) {
    const msg = data?.errors?.message || 'تراکنش تأیید نشد.';
    console.error('خطای تأیید پرداخت زرین‌پال:', code, JSON.stringify(data).slice(0, 300));
    throw new Error(msg);
  }
  return { refId: data.data.ref_id, cardPan: data.data.card_pan || null, alreadyVerified: code === 101 };
}

module.exports = { PLANS, requestPayment, verifyPayment, STARTPAY_BASE };
