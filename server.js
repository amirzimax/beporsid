require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { assertPublicUrl, safeFetch } = require('./safeurl');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const knowledge = require('./knowledge');
const products = require('./products');
const scraper = require('./scraper');
const { extractText, SUPPORTED: SUPPORTED_DOCS } = require('./extract');
const billing = require('./billing');
const telegram = require('./telegram');
// آپلود فایل‌های پایگاه دانش (docx/xlsx/pdf/txt) - حداکثر ۱۰ مگابایت
const uploadDoc = multer({ storage: multer.memoryStorage(), limits: { fileSize: knowledge.LIMITS.file.maxBytes } });

const {
  getShopById,
  getShopBySiteKey,
  updateShopSettings,
  updateShopfaCredentials,
  updateWooCredentials,
  logExchange,
  logCustomerMessage,
  addAgentMessage,
  isAgentActive,
  endAgentSession,
  getAgentMessagesAfter,
  getConversationBySession,
  listConversations,
  markConversationHandled,
  markSessionHandled,
  reopenConversation,
  countPendingConversations,
  getConversation,
  deleteConversation,
  getShopStats,
  createPayment,
  setPaymentAuthority,
  getPaymentById,
  markPaymentPaid,
  markPaymentFailed,
  listPayments,
  extendShopPlan,
  activateFreePlan,
  getMonthlyUsage,
  adminShopView,
  getAdminOverview,
  listAllShops,
  getShopAdminDetail,
  listAllPayments,
  adminSearchConversations,
  getConversationAsAdmin,
  createTicket,
  countRecentTickets,
  listTickets,
  getTicket,
  replyToTicket,
  setTicketStatus,
  adminListTickets,
  adminGetTicket,
  adminReplyToTicket,
  adminSetTicketStatus,
  countOpenTickets,
  setTelegramBot,
  clearTelegramBot,
  getShopByTelegramSecret,
  setTelegramOwnerChat,
  getOrCreateTelegramChat,
  touchTelegramChat,
  startTelegramHandoff,
  endTelegramHandoff,
  isTelegramHandoffActive,
  saveTelegramNotification,
  getTelegramNotification,
  cleanupTelegramNotifications,
  getShopByPhone,
  createShopWithPhone,
  createOtpCode,
  getLastOtpRequest,
  getActiveOtpCode,
  countRecentOtpRequests,
  incrementOtpAttempts,
  consumeOtpCode,
  cleanupOldOtpCodes,
  decrypt,
  toPublicShop
} = require('./db');

const app = express();
// هدرهای امنیتی استاندارد HTTP (helmet). CSP خاموشه چون dashboard.html اسکریپت/استایل
// inline زیاد داره و با CSP پیش‌فرض می‌شکنه؛ CORP روی cross-origin تنظیم شده چون widget.js
// و /api/* باید از هر سایت مشتری (نه فقط api.beporsid.com) قابل بارگذاری/فراخوانی باشن.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
// سقف حجم بدنه‌ی درخواست؛ صریح نوشته شده تا کسی با یک JSON غول‌پیکر حافظه‌ی سرور را پر نکند
app.use(express.json({ limit: '100kb' }));
// nginx روی همین سرور (لوکال‌هاست) جلوی اپ نشسته و IP واقعی کاربر را در X-Forwarded-For می‌گذارد.
// فقط به لوکال‌هاست اعتماد می‌کنیم تا کسی نتواند با جعل این هدر، محدودیت نرخ را دور بزند.
app.set('trust proxy', 'loopback');

// --- محدودیت نرخ درخواست (جلوگیری از سوءاستفاده، هزینه‌ی بی‌مورد هوش مصنوعی و پیامک) ---
const limiterOpts = { standardHeaders: true, legacyHeaders: false };
// چت عمومی است (siteKey در سورس سایت هر مشتری پیداست)، پس باید سخت‌گیرانه محدود شود
const chatLimiter = rateLimit(Object.assign({}, limiterOpts, {
  windowMs: 60 * 1000,
  limit: 20,
  message: { error: 'تعداد پیام‌های شما زیاد بود. چند لحظه صبر کنید.' }
}));
// ارسال کد پیامکی: علاوه بر محدودیت هر شماره، سقف روی هر IP هم لازم است وگرنه یک نفر
// می‌تواند با چرخاندن شماره‌های مختلف، اعتبار پیامک را خالی کند
const otpRequestLimiter = rateLimit(Object.assign({}, limiterOpts, {
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { error: 'تعداد درخواست‌های شما زیاد بوده. یک ساعت دیگر دوباره تلاش کنید.' }
}));
const otpVerifyLimiter = rateLimit(Object.assign({}, limiterOpts, {
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: { error: 'تعداد تلاش‌های شما زیاد بوده. کمی بعد دوباره تلاش کنید.' }
}));
// سقف کلی روی مسیرهای پنل، فقط برای جلوگیری از اسکریپت‌های مزاحم
const apiLimiter = rateLimit(Object.assign({}, limiterOpts, {
  windowMs: 60 * 1000,
  limit: 240,
  message: { error: 'تعداد درخواست‌ها زیاد بود. کمی صبر کنید.' }
}));
// وب‌هوک تلگرام عمومی است؛ سقفش سخاوتمندانه‌ست (همه‌ی مشتری‌های همه‌ی ربات‌ها از IP تلگرام
// می‌آیند) ولی جلوی سیل درخواست جعلی را می‌گیرد. هزینه‌ی هوش مصنوعی را سقف پلن کنترل می‌کند.
const telegramLimiter = rateLimit(Object.assign({}, limiterOpts, {
  windowMs: 60 * 1000,
  limit: 600,
  message: { error: 'too many requests' }
}));

// بدنه‌ی خراب یا بزرگ‌تر از حد مجاز، به‌جای صفحه‌ی خطای پیش‌فرض و استک‌تریس در لاگ،
// یک پیام کوتاه فارسی بگیرد
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'درخواست نامعتبر یا بیش از حد بزرگ است.' });
  }
  next(err);
});

app.use('/api/', apiLimiter);

// مهاجرت یک‌باره: «توضیحات تکمیلی» قدیمی (فایل txt که مستقیم توی پرامپت می‌رفت) به پایگاه دانش
// منتقل می‌شه تا مثل بقیه‌ی محتوا ایندکس بشه؛ بعدش ستون extra_info خالی می‌مونه.
{
  const { db } = require('./db');
  const legacy = db.prepare("SELECT id, extra_info FROM shops WHERE extra_info IS NOT NULL AND extra_info != ''").all();
  for (const s of legacy) {
    knowledge.addItem(s.id, 'text', 'توضیحات تکمیلی فروشگاه', s.extra_info.slice(0, 200000), { migrated: true });
    db.prepare("UPDATE shops SET extra_info = '' WHERE id = ?").run(s.id);
  }
  if (legacy.length) console.log(`مهاجرت ${legacy.length} توضیحات تکمیلی قدیمی به پایگاه دانش انجام شد.`);
}

// اسکریپت ویجت باید بدون نیاز به رمز، از هر سایتی قابل دسترس باشد
app.get('/widget.js', (req, res) => {
  res.type('application/javascript');
  // بدون Cache-Control، مرورگر خودش تا چند روز کش می‌کنه و آپدیت‌های ویجت دیر به سایت مشتری‌ها می‌رسه
  res.set('Cache-Control', 'public, max-age=600');
  res.sendFile(path.join(__dirname, 'widget.js'));
});

// پنل مشتری (ثبت‌نام/ورود/تنظیمات) - خود صفحه عمومیه، وضعیت ورود سمت کلاینت با توکن مدیریت می‌شه
app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

const PORT = process.env.PORT || 3000;
// اپ فقط روی لوکال‌هاست گوش می‌دهد؛ دسترسی از بیرون فقط از مسیر nginx (با HTTPS) ممکن باشد.
// اگر مستقیم روی 0.0.0.0 باز باشد، همه‌ی API روی http ساده و بدون رمزنگاری از اینترنت در دسترس است.
const HOST = process.env.HOST || '127.0.0.1';
const JWT_SECRET = process.env.JWT_SECRET;
// اگر این کلید تنظیم نشده باشد نباید با یک مقدار پیش‌فرضِ عمومی ادامه بدهیم: هرکسی که آن مقدار
// را بداند می‌تواند برای هر فروشگاهی توکن جعلی بسازد و وارد پنلش شود.
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('خطا: JWT_SECRET تنظیم نشده یا کوتاه‌تر از ۳۲ کاراکتر است. یک مقدار تصادفی بلند در .env بگذار.');
  process.exit(1);
}

// آدرس عمومی خود سرور و پنل - برای ساخت callback_url زرین‌پال و ریدایرکت بعد از پرداخت
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://api.beporsid.com';
const PUBLIC_DASHBOARD_URL = `${PUBLIC_BASE_URL}/dashboard.html`;

// اتصال به GapGPT (سرویس واسط ایرانی، فرمت سازگار با OpenAI) به‌جای اتصال مستقیم به Gemini
const GAPGPT_API_KEY = process.env.GAPGPT_API_KEY;
const GAPGPT_MODEL = process.env.GAPGPT_MODEL || 'gemini-2.5-flash-lite';
const GAPGPT_URL = 'https://api.gapgpt.app/v1/chat/completions';

if (!GAPGPT_API_KEY) {
  console.error('خطا: GAPGPT_API_KEY تنظیم نشده. آن را در فایل .env قرار بده.');
  process.exit(1);
}

// ارسال کد ورود یک‌بارمصرف با سرویس کاوه‌نگار (لازم برای /auth/otp/*)
const KAVENEGAR_API_KEY = process.env.KAVENEGAR_API_KEY;
// نام قالب (Template) از پیش تأییدشده در پنل کاوه‌نگار برای پیامک وریفای؛ پیش‌فرض «verify»
const KAVENEGAR_OTP_TEMPLATE = process.env.KAVENEGAR_OTP_TEMPLATE || 'verify';
if (!KAVENEGAR_API_KEY) {
  console.error('هشدار: KAVENEGAR_API_KEY تنظیم نشده - ورود با کد پیامکی کار نمی‌کند (بقیه‌ی سرور طبیعی اجرا می‌شود).');
}

// کلید خصوصی شاپفای هر مشتری رو جدا نگه می‌داریم (چون هرکدوم حساب شاپفای خودشون رو دارن)
const shopfaKeyCache = new Map(); // shopId -> private_key

async function shopfaSignin(shop) {
  const form = new URLSearchParams();
  form.append('user_name', shop.shopfa_username);
  form.append('user_password', decrypt(shop.shopfa_password_enc));

  const res = await safeFetch(`${shop.shopfa_site_domain}/api/user/signin`, {
    method: 'POST',
    body: form
  });
  const data = await res.json();

  if (!data.successful || !data.private_key) {
    throw new Error('ورود به شاپفا ناموفق بود: ' + (data.error || 'نامشخص'));
  }

  shopfaKeyCache.set(shop.id, data.private_key);
  return data.private_key;
}

// بررسی اینکه آیا صفحه‌ی محصول واقعاً روی سایت وجود داره یا نه (برای فیلتر کردن لینک‌های خراب)
// نکته‌ی مهم: فقط وقتی سایت صریحاً می‌گه «پیدا نشد» (404) لینک رو نامعتبر در نظر می‌گیریم.
// اگه درخواست به‌خاطر قطعی موقت شبکه timeout بخوره یا خطای دیگری بده، فرض می‌کنیم لینک
// درسته (safe default) - وگرنه یک قطعی موقت باعث می‌شه همه‌ی لینک‌های سالم هم حذف بشن.
async function verifyLinkExists(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    if (r.status === 404) return false;
    return true;
  } catch (e) {
    console.log('⚠️ بررسی لینک با خطا مواجه شد (نادیده گرفته شد، لینک نگه داشته می‌شه):', e.message);
    return true;
  }
}

// جست‌وجوی محصولات واقعی از API شاپفای همون مشتری (شامل موجودی واقعی)
async function searchShopfaProducts(shop, query, isRetry = false) {
  if (!shop.shopfa_site_domain || !shop.shopfa_username || !shop.shopfa_password_enc) {
    return { error: 'اتصال به فروشگاه شاپفا هنوز در پنل تنظیم نشده است.' };
  }

  let privateKey = shopfaKeyCache.get(shop.id);
  if (!privateKey) {
    privateKey = await shopfaSignin(shop);
  }

  const form = new URLSearchParams();
  form.append('q', query);
  // بیشتر از تعداد نهایی می‌گیریم تا بعد از رتبه‌بندی دقیق و حذف ناموجودها، هنوز نتیجه‌ی کافی بمونه
  form.append('limit', '20');
  form.append('fields', 'id,title,slug,thumb,price,old_price,product_status,quantity,variant');

  const res = await safeFetch(`${shop.shopfa_site_domain}/api/shop/product/list`, {
    method: 'POST',
    headers: { 'Private-Key': privateKey },
    body: form
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.error('خطای API شاپفا: پاسخ JSON نبود (احتمالاً صفحه‌ی خطای HTML)');
    return { error: 'خطا در ارتباط با فروشگاه.' };
  }

  // اگه کلید منقضی شده بود، یک بار دیگه لاگین کن و دوباره تلاش کن
  if ((res.status === 401 || data.error_code === 401) && !isRetry) {
    shopfaKeyCache.delete(shop.id);
    await shopfaSignin(shop);
    return searchShopfaProducts(shop, query, true);
  }

  if (!res.ok || data.successful === false) {
    console.error('خطای API شاپفا:', res.status, JSON.stringify(data));
    return { error: 'خطا در ارتباط با فروشگاه.' };
  }

  const rawItems = (data.items || []).map(p => ({
    title: p.title,
    price: p.price,
    old_price: p.old_price,
    quantity: p.quantity,
    product_status: p.product_status,
    thumb: p.thumb || null,
    link: p.slug ? `${shop.shopfa_site_domain}/product/${p.slug}` : null
  }));

  // جست‌وجوی خود شاپفا خیلی آزاده (برای «Redmi 13» نوت ۱۳ و 13C هم می‌آره)؛
  // اینجا نتایج رو بر اساس تطابق دقیق با عبارت جست‌وجو رتبه‌بندی و فیلتر می‌کنیم
  const ranked = rankByRelevance(rawItems, query);

  // محصولات ناموجود به مشتری نشون داده نمی‌شن؛ فقط تعدادشون به مدل گفته می‌شه
  // تا بدونه باید جایگزین پیشنهاد بده
  const inStock = ranked.filter(p => p.quantity === undefined || p.quantity === null || p.quantity > 0);
  const hiddenOutOfStock = ranked.length - inStock.length;
  const top = inStock.slice(0, 8);

  // بعضی محصولات توی دیتابیس فروشگاه به‌صورت تکراری با شناسه‌های مختلف ثبت شدن که
  // یکیشون صفحه‌ی زنده نداره - قبل از نشون‌دادن لینک، وجودش رو با یک درخواست سبک تأیید می‌کنیم
  const items = await Promise.all(top.map(async (item) => {
    if (!item.link) return item;
    const ok = await verifyLinkExists(item.link);
    return ok ? item : { ...item, link: null };
  }));

  // لینک صفحه‌ی جستجوی کامل سایت (برای وقتی که چند محصول پیدا شده و مشتری بخواد همه رو ببینه)
  const searchLink = `${shop.shopfa_site_domain}/search?q=${encodeURIComponent(query)}`;

  return {
    items,
    total_count: Math.max(inStock.length, items.length),
    hidden_out_of_stock: hiddenOutOfStock,
    searchLink,
    searchQuery: query
  };
}

// --- رتبه‌بندی نتایج جست‌وجو بر اساس تطابق با عبارت مشتری ---
// عناوین شاپفا معمولاً ترکیب فارسی/انگلیسی هستن («قاب ... Xiaomi Redmi 13X / Redmi 13 4G»).
// عبارت مشتری رو نرمال می‌کنیم (اعداد فارسی→لاتین، برندهای فارسی→انگلیسی) و سه سطح تطابق داریم:
//   ۳: همه‌ی توکن‌های مهم توی عنوان هست و «برند + شماره مدل» پشت‌سرهم اومده (Redmi 13 ≠ Redmi Note 13)
//   ۲: همه‌ی توکن‌های مهم هست ولی پشت‌سرهم نیست
//   ۱: بقیه
// فقط بالاترین سطحی که خالی نیست برگردونده می‌شه.
const FA_ALIASES = {
  'ردمی': 'redmi', 'شیائومی': 'xiaomi', 'شیاومی': 'xiaomi', 'سامسونگ': 'samsung', 'گلکسی': 'galaxy',
  'آیفون': 'iphone', 'ایفون': 'iphone', 'اپل': 'apple', 'نوت': 'note', 'پوکو': 'poco', 'پرو': 'pro',
  'پلاس': 'plus', 'اولترا': 'ultra', 'مکس': 'max', 'مینی': 'mini', 'هواوی': 'huawei', 'آنر': 'honor',
  'نوکیا': 'nokia', 'ال‌جی': 'lg', 'سونی': 'sony', 'وان‌پلاس': 'oneplus', 'ریلمی': 'realme', 'اوپو': 'oppo', 'ویوو': 'vivo'
};
// کلمات عمومی که تقریباً توی همه‌ی عناوین هست و نباید تعیین‌کننده باشن
const GENERIC_TOKENS = new Set(['قاب', 'کاور', 'گارد', 'گلس', 'محافظ', 'صفحه', 'کیس', 'مدل', 'گوشی', 'موبایل', 'مناسب', 'برای', 'case', 'cover', 'glass', 'for', 'مخصوص', 'رنگ']);

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[يك]/g, c => (c === 'ي' ? 'ی' : 'ک'))
    .replace(/[‌‏‎]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
    .map(t => FA_ALIASES[t] || t);
}

function rankByRelevance(items, query) {
  const qTokens = normalizeText(query);
  const key = qTokens.filter(t => !GENERIC_TOKENS.has(t));
  if (key.length === 0) return items;

  // جفت‌های «برند/کلمه + عدد» که باید پشت‌سرهم بیان، مثل ["redmi","13"] یا ["note","13"]
  const adjacentPairs = [];
  for (let i = 0; i < key.length - 1; i++) {
    if (/^\d+[a-z]?$/.test(key[i + 1])) adjacentPairs.push([key[i], key[i + 1]]);
  }

  // امتیاز = تعداد توکن‌های مهمی که توی عنوان هست + یک امتیاز اضافه برای هر جفت پشت‌سرهم.
  // فقط محصولاتی که بالاترین امتیاز رو دارن برمی‌گردن؛ مثلاً برای «redmi 13»:
  //   «Redmi 13 4G» = ۲ توکن + ۱ مجاورت = ۳ ، «Redmi Note 13» = ۲ ، «Redmi 13C» = ۱
  const scored = items.map(item => {
    const t = normalizeText(item.title);
    const set = new Set(t);
    let score = key.filter(k => set.has(k)).length;
    for (const [a, b] of adjacentPairs) {
      for (let i = 0; i < t.length - 1; i++) {
        if (t[i] === a && t[i + 1] === b) { score += 1; break; }
      }
    }
    return { item, score };
  });

  const best = Math.max(0, ...scored.map(s => s.score));
  if (best === 0) return items;
  return scored.filter(s => s.score === best).map(s => s.item);
}

// پیگیری سفارش با کد سفارش
// نکته: عمداً فقط وضعیت سفارش و کد رهگیری پستی برگردونده می‌شه و هیچ اطلاعات
// شخصی (نام، آدرس، کد پستی، شماره موبایل) به چت‌بات داده نمی‌شه.
async function trackShopfaOrder(shop, orderCode, isRetry = false) {
  if (!shop.shopfa_site_domain || !shop.shopfa_username || !shop.shopfa_password_enc) {
    return { error: 'اتصال به فروشگاه شاپفا هنوز در پنل تنظیم نشده است.' };
  }
  if (!orderCode) {
    return { error: 'کد سفارش لازم است.' };
  }

  let privateKey = shopfaKeyCache.get(shop.id);
  if (!privateKey) {
    privateKey = await shopfaSignin(shop);
  }

  const code = String(orderCode).trim();

  const form = new URLSearchParams();
  form.append('search', code);
  form.append('limit', '10');

  const res = await safeFetch(`${shop.shopfa_site_domain}/api/shop/orders`, {
    method: 'POST',
    headers: { 'Private-Key': privateKey },
    body: form
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { error: 'خطا در ارتباط با فروشگاه.' };
  }

  if ((res.status === 401 || data.error_code === 401) && !isRetry) {
    shopfaKeyCache.delete(shop.id);
    await shopfaSignin(shop);
    return trackShopfaOrder(shop, orderCode, true);
  }

  if (!res.ok || data.successful === false) {
    console.error('خطای API سفارش‌های شاپفا:', res.status);
    return { error: 'خطا در ارتباط با فروشگاه.' };
  }

  const baskets = data.baskets || [];
  const matched = baskets.find(b =>
    String(b.id) === code || String(b.session) === code
  );

  if (!matched) {
    return { found: false, message: 'سفارشی با این کد پیدا نشد. لطفاً کد سفارش را دوباره بررسی کنید.' };
  }

  // کد رهگیری پستی در پنل شاپفا داخل فیلد «توضیحات سبد» ذخیره می‌شه.
  // چون ممکنه در خروجی API با چند اسم مختلف بیاد، همه‌ی حالت‌های محتمل رو چک می‌کنیم
  // و فقط رشته‌ای که واقعاً شبیه کد رهگیری پستی باشه (حداقل ۱۵ رقم) رو برمی‌داریم.
  const possibleFields = [
    matched.basket_description,
    matched.description,
    matched.message,
    matched.post_code,
    matched.tracking_code,
    matched.post_tracking_code
  ];
  let trackingCode = null;
  for (const field of possibleFields) {
    if (!field) continue;
    const digitsMatch = String(field).match(/\d{15,}/);
    if (digitsMatch) {
      trackingCode = digitsMatch[0];
      break;
    }
  }

  return {
    found: true,
    order_code: matched.session || matched.id,
    status: matched.status_title || 'نامشخص',
    tracking_code: trackingCode,
    items_count: (matched.items || []).length,
    sum_price: matched.sum_price
  };
}

// ==================== اتصال به ووکامرس (WooCommerce REST API v3) ====================

// بعضی سایت‌های ووردپرس پرمالینک «ساده» (Plain) دارن و مسیر زیبای /wp-json/... روش کار
// نمی‌کنه (۴۰۴ می‌ده) چون ری‌رایت مخصوص REST API فعال نیست؛ در اون حالت باید از فرم
// ?rest_route=/wc/v3/... استفاده کرد که مستقل از تنظیمات پرمالینک همیشه جواب می‌ده.
// این تابع اول مسیر معمول رو امتحان می‌کنه و فقط در صورت ۴۰۴ به فرم جایگزین می‌ره.
async function wooFetch(base, path, params) {
  const qs = new URLSearchParams(params).toString();
  let res = await safeFetch(`${base}/wp-json${path}?${qs}`);
  if (res.status === 404) {
    res = await safeFetch(`${base}/?rest_route=${encodeURIComponent(path)}&${qs}`);
  }
  return res;
}

// جست‌وجوی محصولات از فروشگاه ووکامرس. کلید عمومی/خصوصی به‌صورت پارامتر URL ارسال می‌شن
// (روش رسمی ووکامرس برای احراز هویت روی HTTPS، بدون نیاز به امضای OAuth).
async function searchWooProducts(shop, query) {
  if (!shop.woo_site_domain || !shop.woo_consumer_key || !shop.woo_consumer_secret_enc) {
    return { error: 'اتصال به فروشگاه ووکامرس هنوز در پنل تنظیم نشده است.' };
  }

  const base = shop.woo_site_domain.replace(/\/$/, '');
  const secret = decrypt(shop.woo_consumer_secret_enc);

  let res;
  try {
    res = await wooFetch(base, '/wc/v3/products', {
      search: query, per_page: 20, status: 'publish',
      consumer_key: shop.woo_consumer_key, consumer_secret: secret
    });
  } catch (e) {
    console.error('خطای اتصال به ووکامرس:', e.message);
    return { error: 'خطا در ارتباط با فروشگاه.' };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.error('خطای API ووکامرس: پاسخ JSON نبود (احتمالاً صفحه‌ی خطای HTML)');
    return { error: 'خطا در ارتباط با فروشگاه.' };
  }

  if (!res.ok || !Array.isArray(data)) {
    console.error('خطای API ووکامرس:', res.status, JSON.stringify(data).slice(0, 300));
    return { error: 'خطا در ارتباط با فروشگاه.' };
  }

  const rawItems = data.map(p => {
    const price = p.price !== '' && p.price != null ? Number(p.price) : null;
    const regular = p.regular_price !== '' && p.regular_price != null ? Number(p.regular_price) : null;
    const onSale = !!p.on_sale && regular != null && price != null && regular > price;
    // ووکامرس معمولاً فقط "موجود/ناموجود" رو می‌دونه، نه تعداد دقیق (مگر مدیریت موجودی روشن باشه)
    let quantity;
    if (p.stock_status === 'outofstock') quantity = 0;
    else if (p.manage_stock && typeof p.stock_quantity === 'number') quantity = p.stock_quantity;
    else quantity = 1;
    return {
      title: p.name,
      price,
      old_price: onSale ? regular : null,
      quantity,
      product_status: p.stock_status,
      thumb: (p.images && p.images[0] && p.images[0].src) || null,
      link: p.permalink || null
    };
  });

  const ranked = rankByRelevance(rawItems, query);
  const inStock = ranked.filter(p => p.quantity === undefined || p.quantity === null || p.quantity > 0);
  const hiddenOutOfStock = ranked.length - inStock.length;
  const items = inStock.slice(0, 8);

  const totalHeader = res.headers.get('x-wp-total');
  const searchLink = `${base}/?s=${encodeURIComponent(query)}&post_type=product`;

  return {
    items,
    total_count: Number(totalHeader) || Math.max(inStock.length, items.length),
    hidden_out_of_stock: hiddenOutOfStock,
    searchLink,
    searchQuery: query
  };
}

const WOO_STATUS_FA = {
  pending: 'در انتظار پرداخت', processing: 'در حال پردازش', 'on-hold': 'در انتظار بررسی',
  completed: 'تکمیل و ارسال‌شده', cancelled: 'لغوشده', refunded: 'بازپرداخت‌شده', failed: 'ناموفق'
};

// پیگیری سفارش ووکامرس با شناسه یا شماره‌ی سفارش. برخلاف شاپفا، ووکامرس فیلد استاندارد
// «کد رهگیری پستی» نداره؛ اگه افزونه‌ای مثل WooCommerce Shipment Tracking نصب باشه، این
// اطلاعات داخل meta_data سفارش با یک کلید شامل «track» ذخیره می‌شه - همونو جست‌وجو می‌کنیم.
async function trackWooOrder(shop, orderCode) {
  if (!shop.woo_site_domain || !shop.woo_consumer_key || !shop.woo_consumer_secret_enc) {
    return { error: 'اتصال به فروشگاه ووکامرس هنوز در پنل تنظیم نشده است.' };
  }
  const code = String(orderCode || '').trim().replace(/^#/, '');
  if (!code) {
    return { error: 'کد سفارش لازم است.' };
  }

  const base = shop.woo_site_domain.replace(/\/$/, '');
  const secret = decrypt(shop.woo_consumer_secret_enc);
  const authParams = { consumer_key: shop.woo_consumer_key, consumer_secret: secret };

  async function fetchOrderById(id) {
    const r = await wooFetch(base, `/wc/v3/orders/${encodeURIComponent(id)}`, authParams);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('bad status ' + r.status);
    return r.json();
  }

  let order = null;
  try {
    if (/^\d+$/.test(code)) order = await fetchOrderById(code);
    if (!order) {
      // شماره‌ی نمایشی سفارش گاهی با شناسه‌ی داخلی ووکامرس یکی نیست (مثلاً با افزونه‌ی
      // شماره‌گذاری سفارشیده) - در این حالت با جست‌وجو در سفارش‌ها تلاش می‌کنیم
      const r = await wooFetch(base, '/wc/v3/orders', Object.assign({ search: code, per_page: 5 }, authParams));
      if (r.ok) {
        const list = await r.json();
        if (Array.isArray(list)) {
          order = list.find(o => String(o.id) === code || String(o.number) === code) || null;
        }
      }
    }
  } catch (e) {
    console.error('خطای API سفارش‌های ووکامرس:', e.message);
    return { error: 'خطا در ارتباط با فروشگاه.' };
  }

  if (!order) {
    return { found: false, message: 'سفارشی با این کد پیدا نشد. لطفاً کد سفارش را دوباره بررسی کنید.' };
  }

  let trackingCode = null;
  for (const m of order.meta_data || []) {
    if (!String(m.key || '').toLowerCase().includes('track')) continue;
    const raw = typeof m.value === 'string' ? m.value : JSON.stringify(m.value || '');
    const digitsMatch = raw.match(/\d{10,}/);
    if (digitsMatch) { trackingCode = digitsMatch[0]; break; }
  }

  return {
    found: true,
    order_code: order.number || order.id,
    status: WOO_STATUS_FA[order.status] || order.status || 'نامشخص',
    tracking_code: trackingCode,
    items_count: (order.line_items || []).length,
    sum_price: order.total
  };
}

// ==================== انتخاب پلتفرم متصل (شاپفا یا ووکامرس) ====================
// یک فروشگاه معمولاً فقط یکی از این دو رو وصل می‌کنه؛ اگه به هر دلیلی هر دو تنظیم شده
// باشن، شاپفا اولویت داره (چون قدیمی‌تر و پابرجاتره).
function getCommercePlatform(shop) {
  if (shop.shopfa_site_domain && shop.shopfa_username && shop.shopfa_password_enc) return 'shopfa';
  if (shop.woo_site_domain && shop.woo_consumer_key && shop.woo_consumer_secret_enc) return 'woocommerce';
  if (products.countProducts(shop.id) > 0) return 'manual';
  return null;
}

// جست‌وجو در محصولات دستی (فرم/CSV) - همون خروجی و همون رتبه‌بندی بقیه‌ی پلتفرم‌ها
function searchManualProducts(shop, query) {
  const rows = products.searchCandidates(shop.id, query, 40);
  const rawItems = rows.map(p => ({
    title: p.name,
    price: p.final_price ?? p.price,
    old_price: (p.final_price != null && p.price != null && p.price > p.final_price) ? p.price : null,
    quantity: p.stock_status === 'outofstock' ? 0 : (p.stock_qty ?? 1),
    product_status: p.stock_status,
    thumb: p.image || null,
    link: p.link || null,
    description: p.short_desc || (p.description ? p.description.slice(0, 200) : '')
  }));
  const ranked = rankByRelevance(rawItems, query);
  const inStock = ranked.filter(p => p.quantity === undefined || p.quantity === null || p.quantity > 0);
  const items = inStock.slice(0, 8);
  return {
    items,
    total_count: inStock.length,
    hidden_out_of_stock: ranked.length - inStock.length,
    searchLink: null,
    searchQuery: query
  };
}

async function searchProducts(shop, query) {
  const platform = getCommercePlatform(shop);
  if (platform === 'woocommerce') return searchWooProducts(shop, query);
  if (platform === 'shopfa') return searchShopfaProducts(shop, query);
  if (platform === 'manual') return searchManualProducts(shop, query);
  return { error: 'اتصال به فروشگاه هنوز در پنل تنظیم نشده است.' };
}

async function trackOrder(shop, orderCode) {
  const platform = getCommercePlatform(shop);
  if (platform === 'woocommerce') return trackWooOrder(shop, orderCode);
  if (platform === 'shopfa') return trackShopfaOrder(shop, orderCode);
  if (platform === 'manual') return { error: 'پیگیری سفارش فقط با اتصال به شاپفا یا ووکامرس ممکن است. مشتری را به پشتیبانی راهنمایی کن.' };
  return { error: 'اتصال به فروشگاه هنوز در پنل تنظیم نشده است.' };
}

// تعریف این قابلیت به‌عنوان یک "ابزار" به فرمت استاندارد OpenAI که خود مدل می‌تواند صدا بزند
const tools = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description: 'جست‌وجوی محصولات موجود فروشگاه بر اساس نام یا کلمه کلیدی، برای گرفتن قیمت و موجودی واقعی از سایت. هر وقت مشتری درباره‌ی یک محصول خاص یا قیمت/موجودی آن سوال پرسید، این تابع را صدا بزن. محصولات ناموجود در نتیجه نمی‌آیند؛ اگر نتیجه خالی بود یا hidden_out_of_stock بزرگ‌تر از صفر بود، با عبارت کلی‌تر (بدون رنگ) یا لوازم جانبی همان مدل دوباره جست‌وجو کن تا جایگزین پیشنهاد بدهی.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'عبارت دقیق: برند + مدل دقیق + نوع محصول (+ رنگ اگر گفته شده). مثلاً "قاب Redmi 13" یا "گلس Galaxy A56". مدل را دقیق بنویس: Redmi 13 با Redmi Note 13 و Redmi 13C فرق دارد.'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'جست‌وجو در پایگاه دانش فروشگاه (سوالات متداول، توضیحات، مقالات، فایل‌ها و جدول‌های آپلودشده). وقتی مشتری چیزی پرسید که به محصول مشخصی مربوط نیست ولی به فروشگاه مربوطه (شرایط، روش‌ها، آموزش، مقایسه، سوال متداول، جزئیات خدمات) یا وقتی «اطلاعات مرتبط» داخل پرامپت کافی نبود، این را صدا بزن.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'کلمات کلیدی سوال مشتری، کوتاه و مشخص. مثلاً "اقساط" یا "نحوه نصب گلس" یا "ساعت کاری"'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'connect_to_agent',
      description: 'ارجاع مشتری به کارشناس انسانی فروشگاه. وقتی صدا بزن که مشتری صریحاً کارشناس/اپراتور خواست، یا موضوع از عهده‌ی تو خارج است (لغو یا تغییر سفارش ثبت‌شده، مشکل پرداخت، کد رهگیری اشتباه، مرجوعی، شکایت، مشتری عصبانی). نتیجه‌ی این ابزار به‌صورت کارت تماس زیر پیام تو نمایش داده می‌شود.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'خلاصه‌ی یک‌خطی موضوع مشتری، مثلاً "لغو سفارش ثبت‌شده" یا "مشکل در پرداخت"'
          }
        },
        required: ['reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'track_order',
      description: 'پیگیری وضعیت سفارش مشتری با کد سفارش. کد سفارش بعد از خرید برای مشتری پیامک می‌شود.',
      parameters: {
        type: 'object',
        properties: {
          order_code: {
            type: 'string',
            description: 'کد سفارش که بعد از خرید برای مشتری پیامک شده است'
          }
        },
        required: ['order_code']
      }
    }
  }
];

// پرامپت کلی بپرسید (آموزش مشترک همه‌ی فروشگاه‌ها) از فایل prompt.txt خونده می‌شه تا بدون
// دست زدن به کد قابل ویرایش باشه. بعد از هر تغییر در این فایل، سرور باید ری‌استارت بشه.
const PROMPT_FILE = path.join(__dirname, 'prompt.txt');
let BASE_PROMPT = '';
try {
  BASE_PROMPT = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
} catch (e) {
  console.error('هشدار: prompt.txt پیدا نشد؛ از پرامپت حداقلی داخلی استفاده می‌شه.');
  BASE_PROMPT = 'تو دستیار فروش هوش مصنوعی فروشگاه اینترنتی «{{shop_name}}» هستی. فقط به زبان فارسی و کوتاه جواب بده. برای هر سوال درباره‌ی محصول، ابزار search_products را صدا بزن و هرگز قیمت یا موجودی را حدس نزن.';
}

// صفحه‌ای که مشتری داخلشه به‌صورت یک بخش جدا به پرامپت اضافه می‌شه تا «اینو دارین؟» معنی داشته باشه
function describePageContext(page) {
  if (!page || typeof page !== 'object') return '';
  const url = typeof page.url === 'string' ? page.url : '';
  const product = typeof page.product === 'string' ? page.product.trim().slice(0, 200) : '';
  const type = page.type;
  if (type === 'product' && product) {
    return `\n\nصفحه‌ای که مشتری الان داخلشه: صفحه‌ی محصول «${product}». اگر مشتری گفت «اینو»، «این»، «همین»، «موجوده؟» یا «رنگ دیگه داره؟»، منظورش همین محصوله؛ با عنوانش جست‌وجو کن و مستقیم جواب بده.`;
  }
  if (type === 'checkout') {
    return `\n\nصفحه‌ای که مشتری الان داخلشه: سبد خرید / پرداخت. احتمالاً برای تکمیل خرید، روش پرداخت یا ارسال سوال داره؛ کوتاه و کاربردی راهنمایی کن.`;
  }
  if (url) return `\n\nآدرس صفحه‌ای که مشتری داخلشه: ${url.slice(0, 200)}`;
  return '';
}

// ساخت پرامپت سیستمی مخصوص هر فروشگاه: پرامپت کلی + قوانین و اطلاعات همون فروشگاه + صفحه‌ی فعلی مشتری
// تکه‌های مرتبط پایگاه دانش با پیام فعلی مشتری، برای تزریق مستقیم در پرامپت (مدل بدون
// صدا زدن ابزار هم جواب درست داشته باشه). سقف حجم داره تا پرامپت سنگین نشه.
function retrieveKnowledgeContext(shopId, message) {
  const hits = knowledge.search(shopId, message, 4);
  if (!hits.length) return '';
  let budget = 2500;
  const parts = [];
  for (const h of hits) {
    const text = h.content.slice(0, Math.max(200, budget));
    budget -= text.length;
    const label = h.type === 'qa' ? 'سوال متداول' : (h.title || 'اطلاعات فروشگاه');
    parts.push(`[${label}]\n${text}`);
    if (budget <= 0) break;
  }
  return `\n\n═══════════════════════════════
اطلاعات مرتبط از پایگاه دانش فروشگاه (بر اساس پیام مشتری)
═══════════════════════════════
${parts.join('\n\n')}
اگر جواب مشتری اینجا هست، از همین استفاده کن. اگر کافی نبود، ابزار search_knowledge را صدا بزن.`;
}

function buildSystemPrompt(shop, page, message) {
  const base = BASE_PROMPT.replace(/\{\{\s*shop_name\s*\}\}/g, shop.shop_name || 'فروشگاه');
  const support = (shop.support_phone || shop.support_link)
    ? `\n\nکارشناس انسانی: در دسترسه (ابزار connect_to_agent اطلاعات تماس رو نشون می‌ده).${shop.support_hours ? ` ساعات پاسخ‌گویی: ${shop.support_hours}` : ''}`
    : '\n\nکارشناس انسانی: اطلاعات تماس در پنل ثبت نشده؛ در صورت نیاز مشتری رو به بخش «تماس با ما» سایت راهنمایی کن.';

  let kb = '';
  try { kb = retrieveKnowledgeContext(shop.id, message); } catch (e) { console.error('خطای بازیابی دانش:', e.message); }

  return `${base}

═══════════════════════════════
اطلاعات و قوانین این فروشگاه
═══════════════════════════════
- نام فروشگاه: ${shop.shop_name || 'فروشگاه'}
- ارسال: ${shop.shipping_policy || 'اطلاعاتی ثبت نشده است.'}
- مرجوعی: ${shop.returns_policy || 'اطلاعاتی ثبت نشده است.'}
- گارانتی: ${shop.warranty_policy || 'اطلاعاتی ثبت نشده است.'}${support}${kb}${describePageContext(page)}`;
}

// ارسال کد وریفای با API لوک‌آپ کاوه‌نگار (مخصوص کدهای یک‌بارمصرف، نیازی به شماره‌خط نداره،
// فقط باید یک قالب پیامکی از قبل در پنل کاوه‌نگار بسازی و تأیید بگیری - نام قالب را در
// KAVENEGAR_OTP_TEMPLATE بگذار. متن قالب باید یک متغیر token داشته باشد، مثلاً:
// «کد ورود شما به بپرسید: %token%»)
async function sendOtpSms(phone, code) {
  if (!KAVENEGAR_API_KEY) {
    throw new Error('سرویس پیامک تنظیم نشده است.');
  }
  const url = `https://api.kavenegar.com/v1/${KAVENEGAR_API_KEY}/verify/lookup.json` +
    `?receptor=${encodeURIComponent(phone)}&token=${encodeURIComponent(code)}&template=${encodeURIComponent(KAVENEGAR_OTP_TEMPLATE)}`;

  const res = await fetch(url);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('پاسخ نامعتبر از سرویس پیامک.');
  }

  if (!res.ok || !data.return || data.return.status !== 200) {
    const msg = data?.return?.message || 'ارسال پیامک ناموفق بود.';
    console.error('خطای کاوه‌نگار:', res.status, msg);
    throw new Error(msg);
  }
  return data;
}

const IRAN_MOBILE_RE = /^09\d{9}$/;

// نرمال‌سازی شماره موبایل: رقم‌های فارسی/عربی به لاتین، حذف جداکننده‌ها، و اصلاح
// پیشوندهای +98/0098/98 یا نبود صفر اول. کلاینت هم همین کار رو می‌کنه؛ اینجا دوباره
// انجامش می‌دیم چون نباید به ورودی سمت کلاینت اعتماد کرد (API مستقیم هم ممکنه صدا زده بشه).
function normalizeIranPhone(raw) {
  let s = String(raw || '')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[^\d]/g, '');
  if (s.startsWith('0098')) s = s.slice(4);
  else if (s.startsWith('98') && s.length > 10) s = s.slice(2);
  if (s.length > 1 && s[0] === '9') s = '0' + s;
  return s;
}

// ==================== احراز هویت پنل مشتری ====================

// ورود و ثبت‌نام پنل مشتری فقط از طریق شماره موبایل و کد یک‌بارمصرف پیامکی است (کاوه‌نگار).
// اگر شماره‌ای که کد را تأیید می‌کند قبلاً
// حسابی نداشته باشد، همان لحظه یک حساب جدید فقط با این شماره ساخته می‌شود - یعنی این
// مسیر هم برای ثبت‌نام و هم برای ورود کار می‌کند و مستقل از حساب‌های ایمیل/رمزعبور است.
app.post('/auth/otp/request', otpRequestLimiter, async (req, res) => {
  const phone = normalizeIranPhone(req.body.phone);
  if (!IRAN_MOBILE_RE.test(phone)) {
    return res.status(400).json({ error: 'شماره موبایل معتبر نیست. مثال: 09121234567' });
  }

  try { cleanupOldOtpCodes(); } catch (e) { /* پاک‌سازی مهم نیست، اگه خطا داد ادامه بده */ }

  // فاصله‌ی حداقل ۶۰ ثانیه بین دو درخواست برای همون شماره
  const last = getLastOtpRequest(phone);
  if (last) {
    const elapsedMs = Date.now() - new Date(last.created_at.replace(' ', 'T') + 'Z').getTime();
    if (elapsedMs < 60 * 1000) {
      return res.status(429).json({ error: 'کمی صبر کن و دوباره تلاش کن.', retryAfter: Math.ceil((60 * 1000 - elapsedMs) / 1000) });
    }
  }
  // سقف تعداد درخواست در یک ساعت، برای جلوگیری از سوءاستفاده و هزینه‌ی پیامک بی‌مورد
  if (countRecentOtpRequests(phone, 60) >= 5) {
    return res.status(429).json({ error: 'تعداد درخواست‌های شما زیاد بوده. یک ساعت دیگر دوباره تلاش کن.' });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  createOtpCode(phone, codeHash, expiresAt);

  try {
    await sendOtpSms(phone, code);
  } catch (err) {
    console.error('خطای ارسال کد ورود:', err.message);
    return res.status(500).json({ error: 'ارسال پیامک ناموفق بود. کمی بعد دوباره تلاش کن.' });
  }

  res.json({ ok: true, message: 'کد ورود پیامک شد.' });
});

app.post('/auth/otp/verify', otpVerifyLimiter, (req, res) => {
  const phone = normalizeIranPhone(req.body.phone);
  const code = String(req.body.code || '').trim();
  if (!IRAN_MOBILE_RE.test(phone) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'شماره یا کد وارد‌شده نامعتبر است.' });
  }

  const otp = getActiveOtpCode(phone);
  if (!otp) {
    return res.status(400).json({ error: 'کدی برای این شماره فعال نیست. دوباره درخواست کد بده.' });
  }
  if (otp.attempts >= 5) {
    return res.status(429).json({ error: 'تعداد تلاش بیش از حد مجاز بود. دوباره کد بگیر.' });
  }

  incrementOtpAttempts(otp.id);
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  if (codeHash !== otp.code_hash) {
    return res.status(400).json({ error: 'کد وارد‌شده اشتباه است.' });
  }

  consumeOtpCode(otp.id);

  let shop = getShopByPhone(phone);
  if (!shop) {
    // اسم فقط موقع ساخت حساب جدید استفاده می‌شه؛ اگه حساب از قبل بود، نادیده گرفته می‌شه
    // (مثلاً کسی اشتباهی برای شماره‌ی ثبت‌شده‌ی قبلی از فرم ثبت‌نام استفاده کنه)
    const name = typeof req.body.owner_name === 'string' ? req.body.owner_name.trim().slice(0, 120) : '';
    shop = createShopWithPhone(phone, name);
  }

  const token = jwt.sign({ shopId: shop.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, shop: publicShop(shop) });
});

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'نیاز به ورود دارید.' });
  }
  try {
    const payload = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    req.shop = getShopById(payload.shopId);
    if (!req.shop) return res.status(401).json({ error: 'حساب کاربری پیدا نشد.' });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'ورود شما منقضی شده، دوباره وارد شوید.' });
  }
}

// ==================== مدیر کل سیستم ====================
// شماره‌ی مدیر فقط از .env خوانده می‌شود (نه از کد، نه از دیتابیس): شماره‌ی شخصی داخل مخزن
// کد نمی‌ماند، با یک ویرایش .env و ری‌استارت قابل تغییر است، و اگر تنظیم نشده باشد هیچ‌کس
// مدیر نیست - یعنی حالت پیش‌فرضِ امن، دقیقاً همان داشبورد فعلی برای همه.
// چند شماره را می‌توان با کاما جدا کرد: ADMIN_PHONES=09120000000,09350000000
const ADMIN_PHONES = new Set(
  String(process.env.ADMIN_PHONES || '')
    .split(',')
    .map(s => normalizeIranPhone(s))
    .filter(p => IRAN_MOBILE_RE.test(p))
);
if (!ADMIN_PHONES.size) {
  console.log('یادآوری: ADMIN_PHONES تنظیم نشده - پنل مدیریت سیستم برای هیچ حسابی فعال نیست.');
}

function isAdminShop(shop) {
  return !!(shop && shop.phone && ADMIN_PHONES.has(shop.phone));
}

// همیشه از روی رکورد دیتابیسِ همین درخواست تصمیم می‌گیریم، نه از روی چیزی که کلاینت فرستاده
function requireAdmin(req, res, next) {
  if (!isAdminShop(req.shop)) {
    console.error('تلاش برای دسترسی به پنل مدیریت بدون مجوز:', req.shop && req.shop.id, req.path);
    return res.status(403).json({ error: 'این بخش فقط برای مدیر سیستم است.' });
  }
  next();
}

// نسخه‌ی عمومی فروشگاه + نشانه‌ی مدیر بودن، تا فرانت‌اند بداند منوی مدیریت را نشان بدهد یا نه.
// این فقط برای نمایش است؛ اجازه‌ی واقعی همیشه سمت سرور در requireAdmin بررسی می‌شود.
function publicShop(shop) {
  return Object.assign(toPublicShop(shop), { is_admin: isAdminShop(shop) });
}

const adminOnly = [requireAuth, requireAdmin];

app.get('/api/admin/overview', adminOnly, (req, res) => {
  res.json(Object.assign(getAdminOverview(), { open_tickets: countOpenTickets() }));
});

app.get('/api/admin/shops', adminOnly, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  res.json(listAllShops({ q, limit, offset }));
});

app.get('/api/admin/shops/:id', adminOnly, (req, res) => {
  const detail = getShopAdminDetail(Number(req.params.id));
  if (!detail) return res.status(404).json({ error: 'فروشگاه پیدا نشد.' });
  res.json(detail);
});

// تمدید/تغییر دستی پلن یک فروشگاه - برای پشتیبانی (مثلاً جبران یک مشکل یا هدیه‌ی آزمایشی)
app.post('/api/admin/shops/:id/plan', adminOnly, (req, res) => {
  const shopId = Number(req.params.id);
  const target = getShopById(shopId);
  if (!target) return res.status(404).json({ error: 'فروشگاه پیدا نشد.' });

  const planId = req.body.plan;
  if (!billing.PLANS[planId]) return res.status(400).json({ error: 'پلن نامعتبر است.' });

  if (billing.PLANS[planId].free) {
    console.log(`مدیر ${req.shop.id} پلن فروشگاه ${shopId} را به رایگان تغییر داد.`);
    return res.json({ shop: adminShopView(activateFreePlan(shopId)) });
  }
  const days = Math.min(Math.max(parseInt(req.body.days, 10) || 30, 1), 3650);
  console.log(`مدیر ${req.shop.id} پلن ${planId} را ${days} روز برای فروشگاه ${shopId} فعال کرد.`);
  res.json({ shop: adminShopView(extendShopPlan(shopId, planId, days)) });
});

// --- تیکت‌ها از دید مدیر ---
app.get('/api/admin/tickets', adminOnly, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const status = ['open', 'answered', 'closed'].includes(req.query.status) ? req.query.status : '';
  res.json(Object.assign(adminListTickets({ status, limit, offset }), { open_count: countOpenTickets() }));
});

app.get('/api/admin/tickets/:id', adminOnly, (req, res) => {
  const t = adminGetTicket(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'تیکت پیدا نشد.' });
  res.json({ ticket: t });
});

app.post('/api/admin/tickets/:id/reply', adminOnly, (req, res) => {
  const body = clip(req.body.body, TICKET_LIMITS.body);
  if (!body) return res.status(400).json({ error: 'متن پاسخ الزامی است.' });
  const t = adminReplyToTicket(Number(req.params.id), body);
  if (!t) return res.status(404).json({ error: 'تیکت پیدا نشد.' });
  res.json({ ticket: t });
});

app.post('/api/admin/tickets/:id/status', adminOnly, (req, res) => {
  const status = ['open', 'answered', 'closed'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'وضعیت نامعتبر است.' });
  const t = adminSetTicketStatus(Number(req.params.id), status);
  if (!t) return res.status(404).json({ error: 'تیکت پیدا نشد.' });
  res.json({ ticket: t });
});

app.get('/api/admin/payments', adminOnly, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const status = ['pending', 'paid', 'failed'].includes(req.query.status) ? req.query.status : '';
  res.json(listAllPayments({ status, limit, offset }));
});

app.get('/api/admin/conversations', adminOnly, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  res.json(adminSearchConversations({ q, limit, offset }));
});

app.get('/api/admin/conversations/:id', adminOnly, (req, res) => {
  const conv = getConversationAsAdmin(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: 'گفتگو پیدا نشد.' });
  res.json({ conversation: conv });
});

// خروجی CSV برای کارهای بازاریابی (پیامک گروهی، دعوت به ارتقای پلن و...)
// نکته‌ی امنیتی: سلولی که با = + - @ شروع شود را اکسل به‌عنوان فرمول اجرا می‌کند، پس
// با یک آپاستروف خنثی می‌شود. BOM هم اضافه می‌شود وگرنه اکسل فارسی را خراب نشان می‌دهد.
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

app.get('/api/admin/export/shops.csv', adminOnly, (req, res) => {
  const { items } = listAllShops({ q: '', limit: 5000, offset: 0 });
  const header = ['شناسه', 'نام فروشگاه', 'نام صاحب حساب', 'شماره موبایل', 'پلن', 'انقضای پلن',
    'تاریخ ثبت‌نام', 'شاپفا', 'ووکامرس', 'تعداد گفتگو', 'پاسخ این ماه', 'تعداد محصول',
    'آیتم دانش', 'مجموع پرداختی (تومان)', 'آخرین فعالیت'];
  const rows = items.map(s => [
    s.id, s.shop_name, s.owner_name, s.phone, s.plan, s.plan_expires_at || '',
    s.created_at, s.shopfa_connected ? 'بله' : 'خیر', s.woo_connected ? 'بله' : 'خیر',
    s.conversations, s.responses_this_month, s.products, s.knowledge_items, s.revenue,
    s.last_activity || ''
  ].map(csvCell).join(','));
  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="beporsid-shops-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + [header.map(csvCell).join(','), ...rows].join('\r\n'));
});

// ==================== پنل تنظیمات مشتری ====================

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ shop: publicShop(req.shop) });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const {
    shop_name, shipping_policy, returns_policy, warranty_policy, theme_color,
    widget_side, desktop_bottom, desktop_side_offset, mobile_bottom, mobile_side_offset,
    support_phone, support_link, support_hours
  } = req.body;

  // لینک پشتیبانی فقط http(s) یا tel/mailto پذیرفته می‌شه تا چیز عجیبی توی ویجت مشتری رندر نشه
  const cleanLink = typeof support_link === 'string'
    ? (support_link.trim() === '' || /^(https?:\/\/|tel:|mailto:)/i.test(support_link.trim()) ? support_link.trim().slice(0, 300) : null)
    : undefined;

  const updated = updateShopSettings(req.shop.id, {
    shop_name, shipping_policy, returns_policy, warranty_policy, theme_color,
    widget_side: widget_side === 'right' ? 'right' : (widget_side === 'left' ? 'left' : null),
    desktop_bottom, desktop_side_offset, mobile_bottom, mobile_side_offset,
    support_phone: typeof support_phone === 'string' ? support_phone.trim().slice(0, 40) : undefined,
    support_link: cleanLink === null ? undefined : cleanLink,
    support_hours: typeof support_hours === 'string' ? support_hours.trim().slice(0, 120) : undefined
  });
  res.json({ shop: publicShop(updated) });
});

app.post('/api/shopfa-credentials', requireAuth, async (req, res) => {
  const { shopfa_site_domain, shopfa_username, shopfa_password } = req.body;
  if (!shopfa_site_domain || !shopfa_username || !shopfa_password) {
    return res.status(400).json({ error: 'آدرس سایت، نام‌کاربری و رمزعبور شاپفا الزامی است.' });
  }

  const shopfaBase = String(shopfa_site_domain).trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(shopfaBase)) {
    return res.status(400).json({ error: 'آدرس سایت باید با http:// یا https:// شروع شود.' });
  }
  try { await assertPublicUrl(shopfaBase); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // قبل از ذخیره، اتصال رو تست می‌کنیم تا مطمئن بشیم اطلاعات درسته
  try {
    const testForm = new URLSearchParams();
    testForm.append('user_name', shopfa_username);
    testForm.append('user_password', shopfa_password);
    const testRes = await safeFetch(`${shopfaBase}/api/user/signin`, {
      method: 'POST',
      body: testForm
    });
    const testData = await testRes.json();
    if (!testData.successful) {
      return res.status(400).json({ error: 'اتصال به شاپفا ناموفق بود. نام‌کاربری/رمزعبور یا آدرس سایت را بررسی کنید.' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'امکان اتصال به آدرس سایت داده‌شده وجود نداشت.' });
  }

  const updated = updateShopfaCredentials(req.shop.id, {
    shopfa_site_domain: shopfaBase,
    shopfa_username,
    shopfa_password
  });
  shopfaKeyCache.delete(req.shop.id); // اطلاعات عوض شده، کلید قبلی رو دور می‌ریزیم

  res.json({ shop: publicShop(updated) });
});

app.post('/api/woocommerce-credentials', requireAuth, async (req, res) => {
  const { woo_site_domain, woo_consumer_key, woo_consumer_secret } = req.body;
  if (!woo_site_domain || !woo_consumer_key || !woo_consumer_secret) {
    return res.status(400).json({ error: 'آدرس سایت، کلید عمومی و کلید خصوصی الزامی است.' });
  }

  const base = String(woo_site_domain).trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) {
    return res.status(400).json({ error: 'آدرس سایت باید با http:// یا https:// شروع شود.' });
  }
  try { await assertPublicUrl(base); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const consumerKey = String(woo_consumer_key).trim();
  const consumerSecret = String(woo_consumer_secret).trim();

  // قبل از ذخیره، اتصال رو با یک درخواست سبک تست می‌کنیم تا مطمئن بشیم کلیدها و آدرس درسته
  try {
    const testRes = await wooFetch(base, '/wc/v3/products', {
      per_page: 1, consumer_key: consumerKey, consumer_secret: consumerSecret
    });
    if (!testRes.ok) {
      let msg = 'کلیدها یا آدرس سایت درست نیست.';
      try { const d = await testRes.json(); if (d && d.message) msg = d.message; } catch (e) { /* پاسخ JSON نبود */ }
      return res.status(400).json({ error: 'اتصال به ووکامرس ناموفق بود: ' + msg });
    }
  } catch (e) {
    return res.status(400).json({ error: 'امکان اتصال به آدرس سایت داده‌شده وجود نداشت.' });
  }

  const updated = updateWooCredentials(req.shop.id, {
    woo_site_domain: base,
    woo_consumer_key: consumerKey,
    woo_consumer_secret: consumerSecret
  });

  res.json({ shop: publicShop(updated) });
});

// ==================== پایگاه دانش (برای پنل) ====================

const KB = knowledge.LIMITS;
const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

app.get('/api/knowledge', requireAuth, (req, res) => {
  const type = ['qa', 'text', 'file', 'url'].includes(req.query.type) ? req.query.type : undefined;
  res.json({ items: knowledge.listItems(req.shop.id, type), stats: knowledge.getStats(req.shop.id), limits: KB });
});

// سوال و جواب
app.post('/api/knowledge/qa', requireAuth, (req, res) => {
  const question = clip(req.body.question, KB.qa.question);
  const answer = clip(req.body.answer, KB.qa.answer);
  if (!question || !answer) return res.status(400).json({ error: 'پرسش و پاسخ هر دو الزامی است.' });
  const qaLimit = getPlanLimits(req.shop).qa;
  if (knowledge.countItems(req.shop.id, 'qa') >= qaLimit) {
    return res.status(400).json({ error: `پلن فعلی شما تا ${qaLimit} جفت سوال و جواب اجازه می‌دهد. برای افزایش این سقف، پلن را ارتقا دهید.` });
  }
  res.json({ item: knowledge.addItem(req.shop.id, 'qa', question, answer) });
});

// ورود گروهی سوال‌وجواب از CSV (هر خط: سوال,جواب)
app.post('/api/knowledge/qa/import', requireAuth, uploadDoc.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی ارسال نشده است.' });
  const qaLimit = getPlanLimits(req.shop).qa;
  const text = req.file.buffer.toString('utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let added = 0, skipped = 0;
  for (const line of lines) {
    if (knowledge.countItems(req.shop.id, 'qa') >= qaLimit) break;
    const m = line.match(/^"?(.*?)"?\s*[,\t؛;]\s*"?(.*?)"?$/);
    if (!m) { skipped++; continue; }
    const q = clip(m[1], KB.qa.question), a = clip(m[2], KB.qa.answer);
    if (!q || !a || /^(سوال|پرسش|question)$/i.test(q)) { skipped++; continue; }
    knowledge.addItem(req.shop.id, 'qa', q, a);
    added++;
  }
  res.json({ added, skipped, items: knowledge.listItems(req.shop.id, 'qa') });
});

// متن بلند
app.post('/api/knowledge/text', requireAuth, (req, res) => {
  const title = clip(req.body.title, KB.text.title);
  const content = clip(req.body.content, KB.text.content);
  if (!title || !content) return res.status(400).json({ error: 'عنوان و متن هر دو الزامی است.' });
  // متن‌های بلند هم مثل بقیه‌ی منابع سقف پلن دارن (وگرنه می‌شد بی‌نهایت متن ثبت کرد)
  const textLimit = getPlanLimits(req.shop).qa;
  if (knowledge.countItems(req.shop.id, 'text') >= textLimit) {
    return res.status(400).json({ error: `پلن فعلی شما تا ${textLimit} متن اجازه می‌دهد. برای افزایش این سقف، پلن را ارتقا دهید.` });
  }
  res.json({ item: knowledge.addItem(req.shop.id, 'text', title, content) });
});

// ویرایش سوال‌وجواب یا متن
app.put('/api/knowledge/:id', requireAuth, (req, res) => {
  const item = knowledge.getItem(req.shop.id, Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'آیتم پیدا نشد.' });
  let title, content;
  if (item.type === 'qa') { title = clip(req.body.question ?? req.body.title, KB.qa.question); content = clip(req.body.answer ?? req.body.content, KB.qa.answer); }
  else if (item.type === 'text') { title = clip(req.body.title, KB.text.title); content = clip(req.body.content, KB.text.content); }
  else return res.status(400).json({ error: 'این نوع آیتم قابل ویرایش نیست؛ حذف و دوباره اضافه کنید.' });
  if (!title || !content) return res.status(400).json({ error: 'عنوان/پرسش و متن/پاسخ الزامی است.' });
  res.json({ item: knowledge.updateItem(req.shop.id, item.id, title, content) });
});

// فایل (txt / docx / xlsx / pdf) - استخراج متن در پس‌زمینه تا درخواست HTTP معطل نمونه
app.post('/api/knowledge/file', requireAuth, (req, res, next) => {
  uploadDoc.single('file')(req, res, err => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'حجم فایل بیشتر از ۱۰ مگابایت است.' });
    if (err) return res.status(400).json({ error: 'آپلود ناموفق بود.' });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی ارسال نشده است.' });
  const filename = req.file.originalname;
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED_DOCS.includes(ext)) {
    return res.status(400).json({ error: 'فقط فایل‌های txt، docx، xlsx و pdf پذیرفته می‌شود.' });
  }
  const fileLimit = getPlanLimits(req.shop).files;
  if (knowledge.countItems(req.shop.id, 'file') >= fileLimit) {
    return res.status(400).json({ error: `پلن فعلی شما تا ${fileLimit} فایل اجازه می‌دهد. برای افزایش این سقف، پلن را ارتقا دهید.` });
  }

  const item = knowledge.addItem(req.shop.id, 'file', filename.slice(0, 120), '', { filename, bytes: req.file.size }, 'processing');
  const buffer = req.file.buffer;
  setImmediate(async () => {
    try {
      const text = await extractText(filename, buffer);
      if (!text) throw new Error('متنی در فایل پیدا نشد (شاید تصویری/اسکن‌شده باشد).');
      knowledge.finishProcessing(item.id, req.shop.id, text, { chars: text.length });
    } catch (e) {
      console.error('خطای پردازش فایل دانش:', e.message);
      knowledge.finishProcessing(item.id, req.shop.id, '', null, e.message || 'خطای پردازش فایل');
    }
  });
  res.json({ item });
});

// صفحه‌ی وب: خواندن در پس‌زمینه، با گزینه‌ی دنبال کردن لینک‌های داخلی
app.post('/api/knowledge/url', requireAuth, async (req, res) => {
  let url;
  try {
    url = scraper.normalizeUrl(req.body.url);
    // بررسی واقعی (با resolve دامنه) تا آدرس‌های داخلی حتی با دامنه‌ی ظاهراً عمومی رد بشن
    await assertPublicUrl(url);
  } catch (e) { return res.status(400).json({ error: e.message }); }
  const linkLimit = Math.min(getPlanLimits(req.shop).links, scraper.MAX_URL_ITEMS_PER_SHOP);
  if (knowledge.countItems(req.shop.id, 'url') >= linkLimit) {
    return res.status(400).json({ error: `پلن فعلی شما تا ${linkLimit} صفحه‌ی وب اجازه می‌دهد. برای افزایش این سقف، پلن را ارتقا دهید.` });
  }
  const followLinks = !!req.body.follow_links;
  const item = knowledge.addItem(req.shop.id, 'url', url, '', { url, follow_links: followLinks }, 'processing');
  scraper.startCrawl(req.shop.id, item.id, url, followLinks);
  res.json({ item });
});

app.delete('/api/knowledge/:id', requireAuth, (req, res) => {
  if (!knowledge.deleteItem(req.shop.id, Number(req.params.id))) return res.status(404).json({ error: 'آیتم پیدا نشد.' });
  res.json({ ok: true, stats: knowledge.getStats(req.shop.id) });
});

// ==================== محصولات دستی (برای پنل) ====================

function platformInfo(shop) {
  const p = getCommercePlatform(shop);
  return { platform: p, manual_active: p === 'manual' || p === null };
}

app.get('/api/products', requireAuth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  res.json(Object.assign(products.listProducts(req.shop.id, { q, limit, offset }), platformInfo(req.shop), { limits: products.LIMITS }));
});

app.get('/api/products/sample.csv', requireAuth, (req, res) => {
  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="beporsid-products-sample.csv"');
  res.send(products.SAMPLE_CSV);
});

app.post('/api/products', requireAuth, (req, res) => {
  if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: 'نام محصول الزامی است.' });
  const productLimit = getPlanLimits(req.shop).products;
  if (products.countProducts(req.shop.id) >= productLimit) {
    return res.status(400).json({ error: `پلن فعلی شما تا ${productLimit} محصول اجازه می‌دهد. برای افزایش این سقف، پلن را ارتقا دهید.` });
  }
  const r = products.addProduct(req.shop.id, req.body);
  res.json({ product: products.getProduct(req.shop.id, r.id), updated: !!r.updated });
});

app.post('/api/products/import', requireAuth, (req, res, next) => {
  uploadDoc.single('file')(req, res, err => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'حجم فایل بیشتر از ۱۰ مگابایت است.' });
    if (err) return res.status(400).json({ error: 'آپلود ناموفق بود.' });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی ارسال نشده است.' });
  if (!/\.(csv|xlsx|xls|txt)$/i.test(req.file.originalname)) return res.status(400).json({ error: 'فقط فایل CSV یا Excel پذیرفته می‌شود.' });
  let parsed;
  try { parsed = products.parseProductFile(req.file.originalname, req.file.buffer); }
  catch (e) { return res.status(400).json({ error: e.message || 'فایل قابل خواندن نیست.' }); }
  if (!parsed.rows.length) return res.status(400).json({ error: 'ردیفی با «نام محصول» در فایل پیدا نشد.' });
  const result = products.importProducts(req.shop.id, parsed.rows, getPlanLimits(req.shop).products);
  res.json(Object.assign(result, { unknownHeaders: parsed.unknownHeaders, total: products.countProducts(req.shop.id) }));
});

app.put('/api/products/:id', requireAuth, (req, res) => {
  const p = products.updateProduct(req.shop.id, Number(req.params.id), req.body);
  if (!p) return res.status(404).json({ error: 'محصول پیدا نشد یا نام خالی است.' });
  res.json({ product: p });
});

app.delete('/api/products/all', requireAuth, (req, res) => {
  res.json({ deleted: products.clearProducts(req.shop.id) });
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  if (!products.deleteProduct(req.shop.id, Number(req.params.id))) return res.status(404).json({ error: 'محصول پیدا نشد.' });
  res.json({ ok: true, total: products.countProducts(req.shop.id) });
});

// ==================== مدیریت مالی و اشتراک (زرین‌پال) ====================

// حدود مصرف فروشگاه بر اساس پلنش. حساب‌های قدیمی/بدون‌پلن (plan='trial') به سطح آغازین
// (پلن رایگان) محدود می‌شن، نه صفر - وگرنه یک فروشگاه فعال یک‌شبه قفل می‌شد.
function getPlanLimits(shop) {
  return billing.PLANS[shop.plan] || billing.PLANS.starter;
}

app.get('/api/billing/plans', (req, res) => {
  res.json({ plans: Object.values(billing.PLANS) });
});

app.get('/api/billing/status', requireAuth, (req, res) => {
  const shop = req.shop;
  const limits = getPlanLimits(shop);
  const now = new Date();
  const expiresAt = shop.plan_expires_at;
  // پلن آغازین (رایگان) منقضی نمی‌شه؛ بقیه‌ی پلن‌ها فقط تا plan_expires_at فعال‌ان
  const active = shop.plan === 'starter' || (!!expiresAt && new Date(expiresAt.replace(' ', 'T') + 'Z') > now);
  res.json({
    plan: shop.plan,
    plan_name: limits.name,
    is_free: !!limits.free,
    active: !!active,
    plan_expires_at: expiresAt,
    limits: { responses: limits.responses, products: limits.products, qa: limits.qa, links: limits.links, files: limits.files },
    usage: {
      responses: getMonthlyUsage(shop.id),
      products: products.countProducts(shop.id),
      qa: knowledge.countItems(shop.id, 'qa'),
      links: knowledge.countItems(shop.id, 'url'),
      files: knowledge.countItems(shop.id, 'file')
    }
  });
});

app.get('/api/billing/payments', requireAuth, (req, res) => {
  res.json({ items: listPayments(req.shop.id, 30) });
});

// فعال‌سازی پلن رایگان «آغازین» - بدون پرداخت، فوری
app.post('/api/billing/activate-free', requireAuth, (req, res) => {
  const updated = activateFreePlan(req.shop.id);
  res.json({ shop: publicShop(updated) });
});

// شروع خرید/تمدید یک پلن پولی: تراکنش pending ساخته می‌شه و کاربر به درگاه زرین‌پال هدایت می‌شه
app.post('/api/billing/checkout', requireAuth, async (req, res) => {
  const plan = billing.PLANS[req.body.plan];
  const cycle = req.body.cycle === 'yearly' ? 'yearly' : 'monthly';
  if (!plan || plan.free) return res.status(400).json({ error: 'پلن نامعتبر است.' });

  const amount = cycle === 'yearly' ? plan.yearlyPerMonth * 12 : plan.price;
  const paymentId = createPayment(req.shop.id, plan.id, amount, cycle);
  const callbackUrl = `${PUBLIC_BASE_URL}/billing/callback?pid=${paymentId}`;

  try {
    const { authority } = await billing.requestPayment({
      amountToman: amount,
      description: `اشتراک ${cycle === 'yearly' ? 'سالانه' : 'ماهانه'} ${plan.name} - بپرسید`,
      callbackUrl,
      mobile: req.shop.phone || undefined,
      email: /^phone-\d+@otp\.beporsid\.local$/.test(req.shop.email) ? undefined : req.shop.email
    });
    setPaymentAuthority(paymentId, authority);
    res.json({ url: billing.STARTPAY_BASE + authority });
  } catch (err) {
    markPaymentFailed(paymentId);
    res.status(500).json({ error: err.message || 'خطا در اتصال به درگاه پرداخت.' });
  }
});

// بازگشت از درگاه زرین‌پال (GET، بدون هدر Authorization چون مرورگر مستقیم اینجا ریدایرکت می‌شه).
// هویت فروشگاه از خودِ رکورد پرداخت (pid که خودمون موقع ساخت تراکنش دادیم) میاد، نه از توکن کاربر.
// Status=OK در URL هرگز به‌تنهایی ملاک نیست؛ همیشه با verifyPayment نزد خودِ زرین‌پال چک می‌شه.
app.get('/billing/callback', async (req, res) => {
  const paymentId = Number(req.query.pid);
  const payment = paymentId ? getPaymentById(paymentId) : null;
  if (!payment) return res.redirect(`${PUBLIC_DASHBOARD_URL}?billing=error#billing`);

  if (payment.status === 'paid') {
    // کاربر صفحه رو رفرش کرده یا دوباره برگشته - تراکنش قبلاً پردازش شده، دوباره پول کم نمی‌کنیم
    return res.redirect(`${PUBLIC_DASHBOARD_URL}?billing=success#billing`);
  }
  if (req.query.Status !== 'OK') {
    markPaymentFailed(payment.id);
    return res.redirect(`${PUBLIC_DASHBOARD_URL}?billing=cancelled#billing`);
  }
  // Authority باید دقیقاً همانی باشد که موقع ساخت همین تراکنش از زرین‌پال گرفتیم. بدون این
  // بررسی می‌شد یک Authority پرداخت‌شده را روی چند تراکنش pending دیگر هم اعمال کرد
  // (زرین‌پال برای تراکنش تکراری کد ۱۰۱ می‌دهد که موفق حساب می‌شود) و با یک بار پرداخت،
  // چند دوره اشتراک گرفت.
  if (!payment.authority || payment.authority !== req.query.Authority) {
    markPaymentFailed(payment.id);
    return res.redirect(`${PUBLIC_DASHBOARD_URL}?billing=failed#billing`);
  }

  try {
    const plan = billing.PLANS[payment.plan];
    const { refId, cardPan } = await billing.verifyPayment({ amountToman: payment.amount, authority: payment.authority });
    markPaymentPaid(payment.id, refId, cardPan);
    if (plan) extendShopPlan(payment.shop_id, plan.id, payment.cycle === 'yearly' ? 365 : 30);
    res.redirect(`${PUBLIC_DASHBOARD_URL}?billing=success#billing`);
  } catch (err) {
    console.error('خطای تأیید پرداخت:', err.message);
    markPaymentFailed(payment.id);
    res.redirect(`${PUBLIC_DASHBOARD_URL}?billing=failed#billing`);
  }
});

// ==================== گفتگوهای مشتری‌ها (برای پنل) ====================

app.get('/api/stats', requireAuth, (req, res) => {
  res.json(getShopStats(req.shop.id));
});

app.get('/api/conversations', requireAuth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  const filter = req.query.filter === 'pending' ? 'pending' : '';
  res.json(listConversations(req.shop.id, { q, limit, offset, filter }));
});

// پاسخ مستقیم کارشناس به مشتریِ ویجت سایت، از داخل پنل.
// بعد از این، دستیار هوش مصنوعی تا AGENT_HANDOFF_MINUTES دقیقه در این گفتگو ساکت می‌ماند
// تا وسط حرف کارشناس نپرد؛ ویجت مشتری این پیام را با poll کوتاه دریافت می‌کند.
app.post('/api/conversations/:id/reply', requireAuth, (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'متن پیام خالی است.' });
  if (text.length > 4000) return res.status(400).json({ error: 'متن پیام طولانی‌تر از حد مجاز است.' });

  const msg = addAgentMessage(req.shop.id, Number(req.params.id), text.slice(0, 4000), AGENT_HANDOFF_MINUTES);
  if (!msg) return res.status(404).json({ error: 'گفتگو پیدا نشد.' });

  res.json({ ok: true, message: msg, pending: countPendingConversations(req.shop.id) });
});

// برگرداندن گفتگو به دستیار، قبل از پایان مهلت
app.post('/api/conversations/:id/release', requireAuth, (req, res) => {
  if (!endAgentSession(req.shop.id, Number(req.params.id))) {
    return res.status(404).json({ error: 'گفتگو پیدا نشد.' });
  }
  res.json({ ok: true });
});

// «رسیدگی کردم» - گفتگو از تب در حال انتظار خارج می‌شود
app.post('/api/conversations/:id/handled', requireAuth, (req, res) => {
  if (!markConversationHandled(req.shop.id, Number(req.params.id))) {
    return res.status(404).json({ error: 'گفتگو پیدا نشد.' });
  }
  res.json({ ok: true, pending: countPendingConversations(req.shop.id) });
});

app.post('/api/conversations/:id/reopen', requireAuth, (req, res) => {
  if (!reopenConversation(req.shop.id, Number(req.params.id))) {
    return res.status(404).json({ error: 'گفتگو پیدا نشد.' });
  }
  res.json({ ok: true, pending: countPendingConversations(req.shop.id) });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = getConversation(req.shop.id, Number(req.params.id));
  if (!conv) return res.status(404).json({ error: 'گفتگو پیدا نشد.' });
  res.json({ conversation: conv });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  if (!deleteConversation(req.shop.id, Number(req.params.id))) {
    return res.status(404).json({ error: 'گفتگو پیدا نشد.' });
  }
  res.json({ ok: true });
});

// ==================== تیکت پشتیبانی ====================

const TICKET_LIMITS = { subject: 120, body: 4000, perHour: 10 };

app.get('/api/tickets', requireAuth, (req, res) => {
  res.json({ items: listTickets(req.shop.id) });
});

app.post('/api/tickets', requireAuth, (req, res) => {
  const subject = clip(req.body.subject, TICKET_LIMITS.subject);
  const body = clip(req.body.body, TICKET_LIMITS.body);
  if (!subject || !body) return res.status(400).json({ error: 'موضوع و متن پیام هر دو الزامی است.' });
  // جلوگیری از پر کردن جدول با تیکت‌های پشت‌سرهم
  if (countRecentTickets(req.shop.id, 60) >= TICKET_LIMITS.perHour) {
    return res.status(429).json({ error: 'در یک ساعت گذشته تیکت زیادی ثبت کرده‌اید. کمی بعد دوباره تلاش کنید.' });
  }
  res.json({ ticket: createTicket(req.shop.id, subject, body) });
});

app.get('/api/tickets/:id', requireAuth, (req, res) => {
  const t = getTicket(req.shop.id, Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'تیکت پیدا نشد.' });
  res.json({ ticket: t });
});

app.post('/api/tickets/:id/reply', requireAuth, (req, res) => {
  const body = clip(req.body.body, TICKET_LIMITS.body);
  if (!body) return res.status(400).json({ error: 'متن پیام الزامی است.' });
  const t = replyToTicket(req.shop.id, Number(req.params.id), body);
  if (!t) return res.status(404).json({ error: 'تیکت پیدا نشد.' });
  res.json({ ticket: t });
});

app.post('/api/tickets/:id/close', requireAuth, (req, res) => {
  const t = setTicketStatus(req.shop.id, Number(req.params.id), 'closed');
  if (!t) return res.status(404).json({ error: 'تیکت پیدا نشد.' });
  res.json({ ticket: t });
});

// ==================== اتصال به تلگرام ====================

// بعد از جواب دستی فروشنده، ربات این‌قدر دقیقه برای همان مشتری ساکت می‌ماند تا گفتگو
// دست خودش باشد و مشتری دو جواب موازی نگیرد.
const TELEGRAM_HANDOFF_MINUTES = 30;

// همین قاعده برای گفتگوی ویجت سایت: بعد از پاسخ کارشناس (از پنل یا از تلگرام)، دستیار
// این‌قدر دقیقه در آن گفتگو ساکت می‌ماند تا مشتری دو جواب موازی نگیرد.
const AGENT_HANDOFF_MINUTES = 30;

function telegramWebhookUrl(secret) {
  return `${PUBLIC_BASE_URL}/telegram/webhook/${secret}`;
}

function shopSupportsTelegram(shop) {
  const plan = billing.PLANS[shop.plan];
  return !!(plan && Array.isArray(plan.channels) && plan.channels.includes('telegram'));
}

function shopTelegramToken(shop) {
  return shop.telegram_bot_token_enc ? decrypt(shop.telegram_bot_token_enc) : null;
}

// اتصال ربات: توکن اعتبارسنجی می‌شود، وب‌هوک روی همین سرور ثبت می‌شود و توکن رمزنگاری‌شده
// ذخیره می‌گردد. کد اتصالِ یک‌بارمصرف هم ساخته می‌شود تا فروشنده خودش را به ربات معرفی کند.
app.post('/api/telegram/connect', requireAuth, async (req, res) => {
  if (!shopSupportsTelegram(req.shop)) {
    return res.status(403).json({ error: 'اتصال تلگرام در پلن‌های رشد و تجاری فعال است. برای استفاده، پلن را ارتقا دهید.' });
  }
  const token = String(req.body.token || '').trim();
  // فرمت توکن بات‌فادر: <عدد>:<رشته>
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    return res.status(400).json({ error: 'توکن معتبر نیست. همان چیزی را که BotFather داده کامل کپی کنید.' });
  }

  let me;
  try {
    me = await telegram.getMe(token);
  } catch (e) {
    return res.status(400).json({ error: 'تلگرام این توکن را نپذیرفت: ' + e.message });
  }

  const secret = crypto.randomBytes(24).toString('hex');
  const linkCode = crypto.randomBytes(6).toString('hex');

  try {
    await telegram.setWebhook(token, telegramWebhookUrl(secret), secret);
  } catch (e) {
    console.error('خطای ثبت وب‌هوک تلگرام:', e.message);
    return res.status(400).json({ error: 'ثبت وب‌هوک در تلگرام ناموفق بود: ' + e.message });
  }

  const updated = setTelegramBot(req.shop.id, { token, username: me.username, secret, linkCode });
  res.json({
    shop: publicShop(updated),
    // لینک عمیق: فروشنده روی آن می‌زند، ربات خودش باز می‌شود و با /start کد، خودش را معرفی می‌کند
    link_url: me.username ? `https://t.me/${me.username}?start=${linkCode}` : null
  });
});

app.delete('/api/telegram/disconnect', requireAuth, async (req, res) => {
  const token = shopTelegramToken(req.shop);
  if (token) {
    // اگر حذف وب‌هوک هم خطا داد، باز هم اتصال را از سمت خودمان پاک می‌کنیم
    try { await telegram.deleteWebhook(token); }
    catch (e) { console.error('خطای حذف وب‌هوک تلگرام:', e.message); }
  }
  res.json({ shop: publicShop(clearTelegramBot(req.shop.id)) });
});

// --- وب‌هوک: تلگرام آپدیت‌ها را اینجا می‌فرستد ---
// این مسیر عمومی است (تلگرام توکن ورود ما را ندارد)، پس دو لایه محافظت دارد:
// ۱) secret غیرقابل‌حدس در مسیر  ۲) همان secret در هدر که تلگرام برمی‌گرداند و مقایسه می‌شود.
function telegramSecretMatches(headerValue, expected) {
  const a = Buffer.from(String(headerValue || ''));
  const b = Buffer.from(String(expected || ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.post('/telegram/webhook/:secret', telegramLimiter, async (req, res) => {
  // همیشه سریع ۲۰۰ می‌دهیم؛ وگرنه تلگرام همان آپدیت را دوباره و دوباره می‌فرستد
  res.sendStatus(200);

  const shop = getShopByTelegramSecret(req.params.secret);
  if (!shop) return;
  if (!telegramSecretMatches(req.get('X-Telegram-Bot-Api-Secret-Token'), shop.telegram_secret)) {
    console.error('وب‌هوک تلگرام با هدر امنیتی نامعتبر رد شد. فروشگاه:', shop.id);
    return;
  }

  try {
    await handleTelegramUpdate(shop, req.body || {});
  } catch (e) {
    console.error('خطای پردازش آپدیت تلگرام:', e?.message || e);
  }
});

async function handleTelegramUpdate(shop, update) {
  const token = shopTelegramToken(shop);
  if (!token) return;

  // پلن ممکن است بعد از اتصال به پلن رایگان برگشته باشد؛ در آن حالت کانال تلگرام
  // نباید همچنان کار کند، وگرنه قابلیت پولی بدون پرداخت ادامه پیدا می‌کرد.
  if (!shopSupportsTelegram(shop)) {
    const chatId = update.message?.chat?.id;
    if (chatId && String(chatId) !== String(shop.telegram_owner_chat_id)) {
      await telegram.sendMessage(token, chatId, 'این ربات فعلاً در دسترس نیست. لطفاً از راه‌های دیگر با ما تماس بگیرید.');
    }
    return;
  }

  // دکمه‌ی «برگرداندن به ربات» زیر پیام نوتیفیکیشن
  if (update.callback_query) {
    const cq = update.callback_query;
    const isOwner = String(cq.from?.id) === String(shop.telegram_owner_chat_id);

    // گفتگوی ویجت سایت
    const web = /^web_release:(\d+)$/.exec(cq.data || '');
    if (web && isOwner) {
      endAgentSession(shop.id, Number(web[1]));
      await telegram.answerCallbackQuery(token, cq.id, 'گفتگو به دستیار برگشت.');
      return;
    }

    const m = /^release:(.+)$/.exec(cq.data || '');
    if (m && isOwner) {
      endTelegramHandoff(shop.id, m[1]);
      await telegram.answerCallbackQuery(token, cq.id, 'گفتگو به دستیار برگشت.');
    } else {
      await telegram.answerCallbackQuery(token, cq.id, '');
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';

  // --- معرفی فروشنده با لینک عمیق /start <code> ---
  const startMatch = /^\/start(?:\s+(\S+))?$/.exec(text);
  if (startMatch && startMatch[1] && shop.telegram_link_code && startMatch[1] === shop.telegram_link_code) {
    setTelegramOwnerChat(shop.id, chatId);
    await telegram.sendMessage(token, chatId,
      '✅ شما به‌عنوان مدیر این ربات ثبت شدید.\n\n' +
      'از این به بعد هر وقت مشتری‌ای به کارشناس نیاز داشته باشد، همین‌جا به شما خبر می‌دهم. ' +
      'برای جواب دادن، کافی است روی همان پیام اعلان Reply بزنید؛ متن شما مستقیم برای مشتری فرستاده می‌شود.');
    return;
  }

  // --- پیام از طرف خود فروشنده ---
  if (shop.telegram_owner_chat_id && chatId === String(shop.telegram_owner_chat_id)) {
    await handleOwnerMessage(shop, token, msg, chatId, text);
    return;
  }

  // --- پیام مشتری ---
  if (!text) {
    await telegram.sendMessage(token, chatId, 'فعلاً فقط پیام متنی را می‌توانم بخوانم. لطفاً سوالتان را بنویسید.');
    return;
  }
  if (/^\/start\b/.test(text)) {
    await telegram.sendMessage(token, chatId,
      `سلام! 👋\nمن دستیار ${shop.shop_name || 'فروشگاه'} هستم. هر سوالی درباره‌ی محصولات، قیمت، موجودی یا سفارشتان دارید بپرسید.`);
    return;
  }

  const chat = getOrCreateTelegramChat(shop.id, chatId,
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || '');
  touchTelegramChat(shop.id, chatId);

  const customerMessage = text.slice(0, 2000);

  // اگر فروشنده گفتگو را در دست گرفته، دستیار ساکت می‌ماند و پیام فقط به فروشنده می‌رسد
  if (isTelegramHandoffActive(shop.id, chatId)) {
    await notifyOwner(shop, token, chatId, chat, customerMessage, 'پیام جدید (گفتگو دست شماست)');
    // این پیام منتظر جواب خودِ فروشنده است، پس گفتگو در تب «در حال انتظار» می‌ماند
    try { logExchange(shop.id, chat.session_id, 'telegram', customerMessage, '(در انتظار پاسخ شما)', [], true); }
    catch (e) { console.error('خطای ثبت گفتگوی تلگرام:', e.message); }
    return;
  }

  // سقف پاسخ ماهانه دقیقاً مثل ویجت وب اینجا هم اعمال می‌شود، وگرنه تلگرام یک راه فرار
  // از سقف پلن می‌شد و هزینه‌ی هوش مصنوعی بی‌سقف بالا می‌رفت.
  if (getMonthlyUsage(shop.id) >= getPlanLimits(shop).responses) {
    await telegram.sendMessage(token, chatId, 'ظرفیت پاسخ‌گویی این ماه تکمیل شده است. لطفاً بعداً دوباره تلاش کنید.');
    await notifyOwner(shop, token, chatId, chat, customerMessage, '⚠️ سقف پاسخ ماهانه پر شده و به این پیام جواب داده نشد');
    return;
  }

  let out;
  try {
    out = await runAssistant(shop, { message: customerMessage, history: [], page: null });
  } catch (e) {
    console.error('خطای دستیار در تلگرام:', e?.message || e);
    await telegram.sendMessage(token, chatId, 'الان نتوانستم جواب بدهم. لطفاً چند لحظه بعد دوباره بپرسید.');
    return;
  }

  await telegram.sendMessage(token, chatId,
    out.reply + telegram.formatProducts(out.products, out.searchLink, out.searchLabel));

  try { logExchange(shop.id, chat.session_id, 'telegram', customerMessage, out.reply, out.products, !!out.handoff); }
  catch (e) { console.error('خطای ثبت گفتگوی تلگرام:', e.message); }

  // فقط وقتی دستیار تشخیص داده کار به کارشناس انسانی رسیده، به فروشنده خبر می‌دهیم
  if (out.handoff) {
    await notifyOwner(shop, token, chatId, chat, customerMessage,
      '🔔 مشتری به کارشناس نیاز دارد' + (out.handoff.reason ? ` — ${out.handoff.reason}` : ''));
  }
}

// پیام فروشنده: یا Reply روی یک اعلان است (جواب به مشتری) یا یک دستور
async function handleOwnerMessage(shop, token, msg, chatId, text) {
  if (/^\/start\b/.test(text)) {
    await telegram.sendMessage(token, chatId, 'شما مدیر این ربات هستید. برای جواب دادن به مشتری، روی پیام اعلانش Reply بزنید.');
    return;
  }

  const repliedTo = msg.reply_to_message;
  if (!repliedTo) {
    await telegram.sendMessage(token, chatId,
      'برای اینکه بدانم این پیام برای کدام مشتری است، لطفاً روی پیام اعلان همان مشتری Reply بزنید.');
    return;
  }

  const link = getTelegramNotification(shop.id, repliedTo.message_id);
  if (!link) {
    await telegram.sendMessage(token, chatId, 'این پیام قدیمی است و مشتری‌اش را پیدا نکردم. روی اعلان جدیدتر Reply بزنید.');
    return;
  }
  if (!text) {
    await telegram.sendMessage(token, chatId, 'فعلاً فقط می‌توانم متن را برای مشتری بفرستم.');
    return;
  }

  // مشتریِ ویجت سایت: جواب در گفتگو ثبت می‌شود و ویجت مشتری آن را با poll تحویل می‌گیرد
  if (link.conversation_id) {
    const saved = addAgentMessage(shop.id, link.conversation_id, text.slice(0, 4000), AGENT_HANDOFF_MINUTES);
    if (!saved) {
      await telegram.sendMessage(token, chatId, 'این گفتگو دیگر در دسترس نیست (شاید حذف شده باشد).');
      return;
    }
    await telegram.sendMessage(token, chatId,
      `✅ برای مشتری در سایت فرستاده شد. دستیار تا ${AGENT_HANDOFF_MINUTES} دقیقه در این گفتگو ساکت می‌ماند.`, {
        reply_markup: { inline_keyboard: [[{ text: '↩️ برگرداندن به دستیار', callback_data: 'web_release:' + link.conversation_id }]] }
      });
    return;
  }

  await telegram.sendMessage(token, link.customer_chat_id, text.slice(0, 4000));
  // از این لحظه دستیار برای همین مشتری ساکت می‌شود تا گفتگو دست فروشنده بماند
  startTelegramHandoff(shop.id, link.customer_chat_id, TELEGRAM_HANDOFF_MINUTES);

  const chat = getOrCreateTelegramChat(shop.id, link.customer_chat_id, '');
  try {
    logExchange(shop.id, chat.session_id, 'telegram', '(پاسخ دستی فروشنده)', text.slice(0, 4000), []);
    // خودِ فروشنده جواب داده، پس این گفتگو دیگر منتظر رسیدگی نیست
    markSessionHandled(shop.id, chat.session_id);
  } catch (e) { console.error('خطای ثبت پاسخ دستی:', e.message); }

  await telegram.sendMessage(token, chatId, `✅ برای مشتری فرستاده شد. دستیار تا ${TELEGRAM_HANDOFF_MINUTES} دقیقه به این مشتری جواب نمی‌دهد.`, {
    reply_markup: { inline_keyboard: [[{ text: '↩️ برگرداندن به دستیار', callback_data: 'release:' + link.customer_chat_id }]] }
  });
}

// اعلان تلگرام برای گفتگوی ویجتِ سایت. برخلاف مشتری تلگرامی، اینجا مشتری روی سایت است و
// راهی برای رساندن پاسخِ تلگرام به او نداریم، پس نگاشت Reply ثبت نمی‌کنیم و فروشنده را
// صریحاً به پنل/تماس تلفنی ارجاع می‌دهیم.
async function notifyOwnerOfWebHandoff(shop, { message, pageUrl, reason, conversationId, title }) {
  if (!shop.telegram_owner_chat_id) return;
  // اگر پلن فروشگاه دیگر تلگرام ندارد (مثلاً به پلن رایگان برگشته)، وب‌هوک جواب‌هایش را
  // هم نمی‌پذیرد؛ پس اعلانی هم نمی‌فرستیم تا فروشنده پیامی نگیرد که نتواند جوابش را بدهد.
  if (!shopSupportsTelegram(shop)) return;
  const token = shopTelegramToken(shop);
  if (!token) return;

  const lines = [
    title || ('🔔 مشتری در سایت به کارشناس نیاز دارد' + (reason ? ` — ${reason}` : '')),
    '',
    `«${String(message).slice(0, 700)}»`
  ];
  if (pageUrl) lines.push('', `🔗 صفحه: ${pageUrl}`);
  lines.push('', conversationId
    ? '↩️ برای جواب دادن، روی همین پیام Reply بزنید؛ متن شما همان لحظه در ویجت سایت به مشتری نشان داده می‌شود.'
    : 'گفتگو در پنل، تب «در حال انتظار» است: https://api.beporsid.com/dashboard.html');

  try {
    const sent = await telegram.sendMessage(token, shop.telegram_owner_chat_id, lines.join('\n'),
      conversationId
        ? { reply_markup: { inline_keyboard: [[{ text: '↩️ برگرداندن به دستیار', callback_data: 'web_release:' + conversationId }]] } }
        : undefined);
    // نگاشت پیام اعلان به همین گفتگوی سایت، تا Reply فروشنده به مشتری درست برسد
    if (conversationId && sent && sent.message_id) {
      saveTelegramNotification(shop.id, sent.message_id, '', conversationId);
    }
  } catch (e) {
    console.error('خطای اعلان گفتگوی سایت به فروشنده:', e.message);
  }
}

// اعلان به فروشنده + ثبت نگاشت پیام، تا Reply او به مشتری درست برسد
async function notifyOwner(shop, token, customerChatId, chat, customerMessage, title) {
  if (!shop.telegram_owner_chat_id) return;
  const who = chat.customer_name ? `👤 ${chat.customer_name}` : '👤 مشتری';
  const body = `${title}\n\n${who}\n\n«${customerMessage}»\n\n↩️ برای جواب، روی همین پیام Reply بزنید.`;
  try {
    const sent = await telegram.sendMessage(token, shop.telegram_owner_chat_id, body, {
      reply_markup: { inline_keyboard: [[{ text: '↩️ برگرداندن به دستیار', callback_data: 'release:' + customerChatId }]] }
    });
    saveTelegramNotification(shop.id, sent.message_id, customerChatId);
  } catch (e) {
    // رایج‌ترین علت: فروشنده ربات خودش را Block کرده یا هنوز /start نزده
    console.error('خطای ارسال اعلان به فروشنده:', e.message);
  }
}

// ==================== موتور دستیار (مشترک بین ویجت وب و تلگرام) ====================

// همه‌ی کانال‌ها (ویجت سایت و ربات تلگرام) از همین یک تابع استفاده می‌کنند تا رفتار دستیار،
// ابزارها و سقف مصرف در هر دو جا دقیقاً یکی باشد و دو منطق موازی نگه نداریم.
async function runAssistant(shop, { message, history, page }) {
  const systemPrompt = buildSystemPrompt(shop, page, message);

  // تاریخچه از سمت کلاینت می‌آید، پس هم تعدادش و هم طول هر پیام محدود می‌شود
  const trimmedHistory = (Array.isArray(history) ? history : [])
    .slice(-10)
    .filter(h => h && typeof h.text === 'string')
    .map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.text.slice(0, 2000)
    }));

  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimmedHistory,
    { role: 'user', content: message }
  ];

  // withTools=false یعنی مدل حق فراخوانی ابزار ندارد و مجبور است جواب متنی بدهد؛
  // برای درخواست نهایی وقتی مدل در حلقه‌ی ابزار گیر کرده استفاده می‌شود.
  async function callGapGPT({ withTools = true } = {}) {
    const payload = {
      model: GAPGPT_MODEL,
      messages,
      temperature: 0.3,
      reasoning: { enabled: false }
    };
    if (withTools) payload.tools = tools;

    const r = await fetch(GAPGPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GAPGPT_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) {
      const err = new Error(data?.error?.message || 'خطای ناشناخته از GapGPT');
      err.status = r.status;
      throw err;
    }
    return data;
  }

  let data = await callGapGPT();
  let choice = data.choices[0];

  let lastProducts = [];
  let lastSearchLink = null;
  let lastSearchQuery = '';
  let lastTotalCount = 0;
  let handoff = null;
  let rounds = 0;
  // تا ۴ دور ابزار: جست‌وجوی اول + جست‌وجوی جایگزین (وقتی ناموجوده) + ارجاع به کارشناس
  while (choice.message.tool_calls && choice.message.tool_calls.length > 0 && rounds < 4) {
    rounds++;
    messages.push(choice.message);

    for (const toolCall of choice.message.tool_calls) {
      let result;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch (e) { args = {}; }

      if (toolCall.function.name === 'search_products') {
        result = await searchProducts(shop, args.query);
        if (result.items && result.items.length > 0) {
          lastProducts = result.items;
          lastSearchLink = result.searchLink;
          lastSearchQuery = result.searchQuery || '';
          lastTotalCount = result.total_count || result.items.length;
        }
      } else if (toolCall.function.name === 'track_order') {
        result = await trackOrder(shop, args.order_code);
      } else if (toolCall.function.name === 'search_knowledge') {
        const hits = knowledge.search(shop.id, String(args.query || ''), 5);
        result = hits.length
          ? { results: hits.map(h => ({ title: h.title, type: h.type, content: h.content.slice(0, 1200), source: h.source })) }
          : { results: [], message: 'چیزی در پایگاه دانش پیدا نشد. صادقانه بگو اطلاعاتش را نداری و به پشتیبانی ارجاع بده.' };
      } else if (toolCall.function.name === 'connect_to_agent') {
        if (shop.support_phone || shop.support_link) {
          handoff = {
            phone: shop.support_phone || null,
            link: shop.support_link || null,
            hours: shop.support_hours || null,
            reason: typeof args.reason === 'string' ? args.reason.slice(0, 200) : ''
          };
          result = { ok: true, message: 'کارت تماس کارشناس زیر پیام تو نمایش داده می‌شود. فقط یک جمله‌ی کوتاه بگو که موضوع را به کارشناس سپردی؛ شماره یا لینک را در متن تکرار نکن.', hours: shop.support_hours || null };
        } else {
          result = { ok: false, message: 'اطلاعات تماس کارشناس در پنل ثبت نشده. مشتری را به بخش «تماس با ما» سایت راهنمایی کن.' };
        }
      } else {
        result = { error: 'ابزار ناشناخته.' };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
    }

    data = await callGapGPT();
    choice = data.choices[0];
  }

  // مدل گاهی سقف دورهای ابزار را پر می‌کند بدون اینکه جواب متنی بدهد (یا content خالی
  // برمی‌گرداند). قبلاً در این حالت مشتری پیام بی‌فایده‌ی «نتوانستم پاسخ پیدا کنم» می‌گرفت —
  // در آزمایش‌ها حدود یک‌چهارم پاسخ‌ها. حالا یک بار دیگر بدون ابزار صدایش می‌زنیم تا مجبور
  // شود از روی همان اطلاعاتی که تا اینجا جمع کرده جواب بدهد.
  let replyText = choice.message.content;
  if (!replyText) {
    try {
      const finalData = await callGapGPT({ withTools: false });
      replyText = finalData.choices?.[0]?.message?.content || '';
    } catch (e) {
      console.error('خطای درخواست نهایی بدون ابزار:', e?.message || e);
    }
  }
  if (!replyText) {
    replyText = 'متاسفم، الان نتوانستم جواب دقیقی پیدا کنم. می‌شود سوالتان را کوتاه‌تر و ساده‌تر بپرسید؟';
  }

  const products = lastProducts.slice(0, 4);

  return {
    reply: replyText,
    products,
    searchLink: lastTotalCount > products.length ? lastSearchLink : null,
    searchLabel: lastSearchQuery ? `مشاهده همه‌ی ${lastSearchQuery}` : 'مشاهده همه محصولات',
    handoff
  };
}

// ==================== اندپوینت اصلی چت (ویجت وب) ====================

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { history, siteKey, sessionId, pageUrl, page } = req.body;

  if (!req.body.message || typeof req.body.message !== 'string') {
    return res.status(400).json({ error: 'فیلد message الزامی است.' });
  }
  if (!siteKey) {
    return res.status(400).json({ error: 'کلید سایت (siteKey) الزامی است.' });
  }
  // پیام مشتری سقف طول دارد؛ هر کاراکتر اضافه مستقیم هزینه‌ی توکن هوش مصنوعی است
  const message = req.body.message.slice(0, 2000);

  const shop = getShopBySiteKey(siteKey);
  if (!shop) {
    return res.status(404).json({ error: 'فروشگاهی با این کلید پیدا نشد.' });
  }

  const sid = (typeof sessionId === 'string' && /^[\w-]{6,64}$/.test(sessionId))
    ? sessionId
    : 'anon_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // اگر کارشناس انسانی همین حالا این گفتگو را در دست دارد، دستیار ساکت می‌ماند: پیام مشتری
  // فقط ثبت و به فروشنده اعلام می‌شود تا خودش جواب بدهد و مشتری دو جواب موازی نگیرد.
  if (isAgentActive(shop.id, sid)) {
    let convId = null;
    try {
      convId = logCustomerMessage(shop.id, sid, typeof pageUrl === 'string' ? pageUrl.slice(0, 500) : null, message.slice(0, 4000));
    } catch (e) {
      console.error('خطای ثبت پیام مشتری در حالت کارشناس:', e?.message || e);
    }
    res.json({
      reply: '',
      products: [],
      searchLink: null,
      searchLabel: '',
      handoff: null,
      agentMode: true,
      notice: 'پیام شما برای کارشناس فرستاده شد؛ به‌زودی همین‌جا جواب می‌دهد.'
    });
    notifyOwnerOfWebHandoff(shop, {
      message,
      pageUrl: typeof pageUrl === 'string' ? pageUrl.slice(0, 300) : null,
      reason: '',
      conversationId: convId,
      title: '💬 پیام جدید مشتری (گفتگو دست شماست)'
    }).catch(e => console.error('خطای اعلان تلگرام:', e?.message || e));
    return;
  }

  // سقف پاسخ ماهانه‌ی پلن فروشگاه. بدون این بررسی، سقفی که در تعرفه فروخته می‌شود هیچ‌جا
  // اعمال نمی‌شد و هرکسی با برداشتن siteKey از سورس سایت مشتری می‌توانست بی‌نهایت
  // درخواست بزند و هزینه‌ی هوش مصنوعی را بالا ببرد.
  const responseLimit = getPlanLimits(shop).responses;
  if (getMonthlyUsage(shop.id) >= responseLimit) {
    return res.status(429).json({ error: 'ظرفیت پاسخ‌گویی دستیار این فروشگاه برای این ماه تکمیل شده است.' });
  }

  try {
    const out = await runAssistant(shop, { message, history, page });

    // ثبت گفتگو برای نمایش در پنل فروشگاه. ویجت‌های قدیمی که sessionId نمی‌فرستن،
    // هر پیامشون یک گفتگوی جدا می‌شه. خطای ثبت نباید جواب مشتری رو خراب کنه.
    let conversationId = null;
    try {
      conversationId = logExchange(shop.id, sid, typeof pageUrl === 'string' ? pageUrl.slice(0, 500) : null,
        message.slice(0, 4000), out.reply.slice(0, 8000), out.products, !!out.handoff);
    } catch (logErr) {
      console.error('خطای ثبت گفتگو:', logErr?.message || logErr);
    }

    res.json(out);

    // اعلان تلگرام بعد از پاسخ دادن به مشتری فرستاده می‌شود تا سرعت چت پایین نیاید.
    // تا پیش از این، ارجاع به کارشناس در ویجت سایت هیچ اعلانی برای فروشنده نداشت و فقط
    // در تب «در حال انتظار» پنل دیده می‌شد.
    if (out.handoff) {
      notifyOwnerOfWebHandoff(shop, {
        message,
        pageUrl: typeof pageUrl === 'string' ? pageUrl.slice(0, 300) : null,
        reason: out.handoff.reason,
        conversationId
      }).catch(e => console.error('خطای اعلان تلگرام گفتگوی سایت:', e?.message || e));
    }
  } catch (err) {
    console.error('خطای چت:', err?.status || '', err?.message || err, err?.cause || '');

    if (err?.status === 429) {
      return res.status(429).json({
        error: 'در حال حاضر ترافیک بالاست، چند لحظه دیگر دوباره امتحان کنید.'
      });
    }
    res.status(500).json({ error: 'خطا در ارتباط با سرویس هوش مصنوعی.' });
  }
});

// ویجت مشتری هر چند ثانیه این را می‌پرسد تا پاسخ‌های کارشناس انسانی را تحویل بگیرد.
// نیازی به احراز هویت ندارد چون sessionId یک شناسه‌ی تصادفی ۹۶ بیتی است که فقط خود
// مرورگر مشتری دارد؛ ولی عمداً فقط پیام‌های نقش 'agent' برگردانده می‌شود، نه کل گفتگو.
app.get('/api/chat/agent-messages', apiLimiter, (req, res) => {
  const { siteKey, sessionId } = req.query;
  if (!siteKey || typeof sessionId !== 'string' || !/^[\w-]{6,64}$/.test(sessionId)) {
    return res.status(400).json({ error: 'پارامترهای نامعتبر.' });
  }
  const shop = getShopBySiteKey(siteKey);
  if (!shop) return res.status(404).json({ error: 'فروشگاهی با این کلید پیدا نشد.' });

  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  const { items, agentActive } = getAgentMessagesAfter(shop.id, sessionId, after);
  res.json({
    items: items.map(m => ({ id: m.id, text: m.content, created_at: m.created_at })),
    agentActive
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// جدول نگاشت اعلان‌های تلگرام فقط برای مسیریابی Reply لازم است؛ ردیف‌های قدیمی را روزی
// یک بار پاک می‌کنیم تا بی‌رویه بزرگ نشود.
setInterval(() => {
  try { cleanupTelegramNotifications(); }
  catch (e) { console.error('خطای پاک‌سازی اعلان‌های تلگرام:', e.message); }
}, 24 * 60 * 60 * 1000).unref();

app.listen(PORT, HOST, () => {
  console.log(`سرور چت‌بات روی ${HOST}:${PORT} در حال اجراست.`);
});
