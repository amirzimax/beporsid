# AGENTS.md — راهنمای ایجنت‌های هوش مصنوعی برای پروژه‌ی بپرسید

این فایل برای ایجنت‌های کدنویس (Claude Code، Codex، Cursor، Copilot و…) نوشته شده تا قبل از هر تغییری، ساختار و قواعد پروژه را بدانند. **قبل از تغییر کد، این فایل را کامل بخوان.**

## پروژه چیست؟

**بپرسید (Beporsid)** یک سرویس SaaS چند‌مستأجری (multi-tenant) است: یک دستیار فروش هوش مصنوعی فارسی‌زبان که به‌صورت ویجت چت روی سایت فروشگاه‌های اینترنتی (فعلاً فقط فروشگاه‌های ساخته‌شده با **شاپفا**) نصب می‌شود. ویجت به API شاپفای همان فروشگاه وصل می‌شود، محصولات و موجودی واقعی را جست‌وجو می‌کند و وضعیت سفارش را پیگیری می‌کند.

مدل زبانی از طریق **GapGPT** (واسط ایرانی با فرمت سازگار با OpenAI Chat Completions) صدا زده می‌شود؛ مدل پیش‌فرض `gemini-2.5-flash-lite` است. اتصال مستقیم به Gemini/OpenAI وجود ندارد — README قدیمی که از کلید Gemini می‌گوید منسوخ است.

## پشته‌ی فنی

| بخش | فناوری |
|---|---|
| Runtime | Node.js ≥ 18 (به `fetch` داخلی نیاز دارد)، CommonJS |
| وب‌سرور | Express 4 |
| دیتابیس | SQLite با `better-sqlite3` (فایل `chatbot.db`، حالت WAL) |
| احراز هویت | JWT (`jsonwebtoken`)، هش رمز با `bcryptjs` |
| رمزنگاری | AES-256-GCM در `db.js` برای رمز شاپفای مشتری |
| آپلود | `multer` (memoryStorage، حداکثر ۱ مگابایت، فقط `.txt`) |
| فرانت‌اند | HTML/CSS/JS خالص، بدون فریم‌ورک، بدون مرحله‌ی build، فونت Vazirmatn |

هیچ تست، لینتر، TypeScript، bundler یا CI وجود ندارد. **فریم‌ورک یا ابزار build اضافه نکن** مگر این‌که کاربر صریحاً بخواهد.

## دستورات

```bash
npm install          # نصب وابستگی‌ها (better-sqlite3 باینری native می‌سازد)
npm start            # node server.js  → پورت 3000
npm run dev          # node --watch server.js
node --check server.js; node --check db.js   # حداقل بررسی نحوی — قبل از اعلام اتمام کار اجرا کن
```

سرور بدون `GAPGPT_API_KEY` در `.env` **بالا نمی‌آید** (`process.exit(1)`). متغیرهای محیطی کامل در `.env.example` هستند.

بررسی سلامت: `GET /health` → `{"status":"ok"}`.

## نقشه‌ی فایل‌ها

```
server.js          تمام روت‌های Express، منطق چت، اتصال به شاپفا و GapGPT، تعریف ابزارها (tools) و پرامپت سیستمی
db.js              اتصال SQLite، schema جدول shops، مهاجرت‌ها، رمزنگاری، توابع CRUD، toPublicShop()
widget.js          اسکریپت ویجت که روی سایت مشتری embed می‌شود (Shadow DOM، بدون وابستگی)
dashboard.html     پنل مشتری: ثبت‌نام/ورود، تنظیمات فروشگاه، اتصال شاپفا، آپلود اطلاعات تکمیلی، تولید کد embed
index.html         لندینگ‌پیج بازاریابی بپرسید (استاتیک، سرو نمی‌شود — دستی باز می‌شود)
test-widget.html   صفحه‌ی تست قدیمی؛ منسوخ (siteKey نمی‌فرستد و API_URL آن خراب است)
public/admin.html  پنل ادمین نسل اول (آپلود اکسل + رمز ادمین)؛ منسوخ — server.js آن را سرو نمی‌کند و endpointهایش وجود ندارند
shop-data.json     کاتالوگ نمونه‌ی نسل اول؛ دیگر توسط کد خوانده نمی‌شود
test.json          فایل تست دستی؛ بی‌اهمیت
chatbot.db*        دیتابیس واقعی + فایل‌های WAL/SHM — هرگز commit یا حذف نکن
.claude/skills/    اسکیل‌های docker، docker-compose و production-release
```

فایل‌های «منسوخ» را بدون تأیید کاربر حذف نکن، ولی روی آن‌ها هم چیزی نساز.

## معماری در یک نگاه

### جریان یک پیام چت
1. ویجت روی سایت مشتری `POST /api/chat` می‌زند با `{ message, history, siteKey }`.
2. سرور با `siteKey` فروشگاه را از SQLite می‌خواند (`getShopBySiteKey`).
3. `buildSystemPrompt(shop)` پرامپت سیستمی مخصوص همان فروشگاه را می‌سازد (نام، قوانین ارسال/مرجوعی/گارانتی، `extra_info`).
4. درخواست با `tools` به GapGPT می‌رود. حلقه‌ی tool-calling حداکثر **۳ دور** اجرا می‌شود:
   - `search_products(query)` → `searchShopfaProducts()` → `POST {domain}/api/shop/product/list`
   - `track_order(order_code)` → `trackShopfaOrder()` → `POST {domain}/api/shop/orders`
5. پاسخ: `{ reply, products (حداکثر ۴), searchLink, searchLabel }`. ویجت متن را نشان می‌دهد و کارت محصولات را جداگانه رندر می‌کند.

### احراز هویت شاپفا
- هر فروشگاه نام‌کاربری/رمز شاپفای خودش را دارد؛ رمز با AES-GCM در ستون `shopfa_password_enc` ذخیره می‌شود.
- `shopfaSignin()` کلید خصوصی (`private_key`) می‌گیرد و در `shopfaKeyCache` (یک `Map` در حافظه) نگه می‌دارد. با 401، کش پاک و **یک بار** retry می‌شود (`isRetry`). این الگو را در هر فراخوانی جدید شاپفا حفظ کن.
- لینک هر محصول قبل از نمایش با `verifyLinkExists()` (HEAD + timeout ۳٫۵ ثانیه) چک می‌شود؛ **فقط 404 لینک را حذف می‌کند**، خطای شبکه = لینک معتبر فرض می‌شود. این تصمیم عمدی است، تغییرش نده.

### پنل مشتری و توکن
- ورود و ثبت‌نام فقط با شماره موبایل و کد یک‌بارمصرف پیامکی (کاوه‌نگار) است؛ ورود با ایمیل/رمزعبور حذف شده.
- `POST /auth/otp/request` کد را پیامک می‌کند، `POST /auth/otp/verify` کد را چک می‌کند و اگر شماره حساب نداشت با `owner_name` (نام و نام‌خانوادگی یک‌جا) حساب جدید می‌سازد → JWT ۳۰ روزه با `{ shopId }`.
- روت‌های `/api/me`, `/api/settings`, `/api/shopfa-credentials`, `/api/upload-extra-info`, `DELETE /api/extra-info` پشت `requireAuth` هستند (هدر `Authorization: Bearer <token>`).
- توکن سمت کلاینت در `localStorage` با کلید `beporsid_token` است.
- هرچه به فرانت برمی‌گردد باید از `toPublicShop()` عبور کند — هرگز `password_hash` یا `shopfa_password_enc` را خام برنگردان.

### ویجت (widget.js)
- تنظیمات از `window.ChatbotWidgetConfig` خوانده می‌شود: `apiUrl`, `siteKey`, `color`, `side`, `desktopBottom`, `desktopSideOffset`, `mobileBottom`, `mobileSideOffset`, `fontFamily`, `fontFace`. **کد embed در `dashboard.html` تولید می‌شود** — اگر کلیدی به ویجت اضافه کردی، تولیدکننده‌ی embed در dashboard و ستون متناظر در `db.js` و `/api/settings` را هم به‌روز کن.
- کل UI داخل Shadow DOM است تا CSS سایت میزبان نشت نکند. `z-index: 2147483000`.
- وضعیت گفت‌وگو در `localStorage` با کلید `beporsidChatbotState:<siteKey>` ذخیره می‌شود.
- گارد `window.__shopChatbotWidgetLoaded` مانع لود دوباره می‌شود.
- **بدون وابستگی خارجی بماند**؛ روی سایت غریبه اجرا می‌شود.

## قواعد تغییر schema (مهم)

`db.js` روی هر بوت `CREATE TABLE IF NOT EXISTS` و سپس مهاجرت‌های افزایشی را اجرا می‌کند. برای اضافه‌کردن ستون جدید به `shops`، **همیشه هر سه جا** را تغییر بده:
1. بلوک `CREATE TABLE` (برای نصب تازه)
2. آبجکت `migrations` (برای دیتابیس‌های موجود — `ALTER TABLE ... ADD COLUMN`)
3. `toPublicShop()` و تابع update مربوطه (`updateShopSettings` با الگوی `COALESCE(?, col)`)

مهاجرت‌ها فقط افزایشی‌اند؛ ستون حذف یا تغییر نوع نده.

## قراردادهای کدنویسی

- **زبان کامنت‌ها و پیام‌های کاربر: فارسی.** نام متغیرها، توابع و کلیدهای JSON: انگلیسی. همین سبک را ادامه بده.
- پیام‌های خطای API به‌صورت `{ error: '...' }` فارسی و قابل‌نمایش به کاربر نهایی.
- CommonJS (`require`/`module.exports`)؛ ES Modules نکن.
- تک‌فایل و ساده. کارکرد جدید را به `server.js` یا `db.js` اضافه کن مگر واقعاً به ماژول جدا نیاز باشد. abstraction زودهنگام نساز.
- `fetch` داخلی Node؛ `axios` و امثالش اضافه نکن.
- پرامپت سیستمی در `buildSystemPrompt()` با دقت تنظیم شده (رفتار tool-calling، نحوه‌ی نمایش لینک‌ها، حریم خصوصی سفارش). قبل از تغییر آن با کاربر مشورت کن و منطق «فقط لینک واقعی ابزار، هرگز لینک ساختگی» را نشکن.
- هر HTML جدید: `lang="fa" dir="rtl"`، فونت Vazirmatn.

## امنیت و حریم خصوصی

- `JWT_SECRET` و `ENCRYPTION_SECRET` پیش‌فرض `'change-this-secret'` دارند — فقط برای توسعه. در production باید هر دو تنظیم و متفاوت باشند. تغییر `ENCRYPTION_SECRET` روی دیتابیس موجود، همه‌ی رمزهای شاپفای ذخیره‌شده را غیرقابل‌بازیابی می‌کند — هشدار بده.
- `trackShopfaOrder()` **عمداً** فقط وضعیت سفارش، کد رهگیری پستی، تعداد اقلام و مبلغ را برمی‌گرداند. نام، آدرس، کد پستی و موبایل مشتری نباید به مدل داده شود. این را گسترش نده.
- کلید GapGPT فقط در بک‌اند است؛ هرگز به ویجت یا HTML نشت نکند.
- `cors()` باز است چون ویجت از دامنه‌های مختلف می‌آید؛ اگر محدودش می‌کنی، `/api/chat` و `/widget.js` باید باز بمانند.
- Rate limiting وجود ندارد (روی چت و لاگین). اگر اضافه شد، `express-rate-limit` و `app.set('trust proxy', 1)`.
- هرگز `.env`، `chatbot.db*`، رمز یا توکن را در لاگ، commit یا خروجی چاپ نکن.

## نکات شناخته‌شده / بدهی فنی

- `test-widget.html`: مقدار `API_URL` یک رشته‌ی خراب است و `siteKey` نمی‌فرستد — برای تست، از کد embed خودِ dashboard روی یک صفحه‌ی ساده استفاده کن.
- `public/admin.html` به endpointهای `/api/admin/*` اشاره می‌کند که وجود ندارند.
- `README.md` نیمه‌منسوخ است (Gemini مستقیم، `shop-data.json`).
- پروژه در git نیست. اگر `git init` کردی، `.gitignore` موجود را نگه دار.
- برای استقرار، اسکیل‌های `.claude/skills/` (docker، docker-compose، production-release) را دنبال کن؛ Dockerfile هنوز ساخته نشده.

## چک‌لیست قبل از اعلام «تمام شد»

- [ ] `node --check server.js` و `node --check db.js` بدون خطا
- [ ] سرور با یک `.env` تستی بالا می‌آید و `/health` جواب می‌دهد
- [ ] اگر schema عوض شده: هر سه جای گفته‌شده به‌روز شده
- [ ] اگر ویجت/تنظیمات عوض شده: dashboard، db.js و `/api/settings` هماهنگ‌اند
- [ ] هیچ داده‌ی حساسی به `toPublicShop()` یا پاسخ چت اضافه نشده
- [ ] متغیر محیطی جدید به `.env.example` اضافه شده
