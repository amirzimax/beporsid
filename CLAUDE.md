# CLAUDE.md

راهنمای کامل پروژه در [AGENTS.md](AGENTS.md) است — **اول آن را بخوان**؛ این فایل فقط نکات مخصوص Claude Code را اضافه می‌کند.

## خلاصه‌ی یک‌خطی
بپرسید: ویجت چت‌بات فروش فارسی، چند‌مستأجری، Node/Express + SQLite، متصل به API شاپفا و مدل زبانی از طریق GapGPT. بدون فریم‌ورک، بدون build، بدون تست.

## دستورات پرکاربرد
- اجرا: `npm start` (نیاز به `.env` با `GAPGPT_API_KEY`)
- بررسی نحوی: `node --check server.js; node --check db.js`
- سلامت: `curl http://localhost:3000/health`

## اسکیل‌های پروژه
در `.claude/skills/`:
- `docker` — ساخت Dockerfile و `.dockerignore`
- `docker-compose` — compose برای dev و prod (Caddy جلوی اپ)
- `production-release` — چک‌لیست انتشار، بکاپ SQLite، smoke test، rollback

وقتی کاربر از deploy، release یا Docker حرف می‌زند، از همین اسکیل‌ها استفاده کن.

## قواعد سخت
- کامنت و پیام خطا فارسی؛ نام‌گذاری انگلیسی.
- به `chatbot.db*` و `.env` دست نزن و آن‌ها را در خروجی چاپ نکن.
- تغییر schema = سه جا در `db.js` (CREATE TABLE، `migrations`، `toPublicShop`/update).
- پرامپت سیستمی (`buildSystemPrompt`) را بدون تأیید کاربر عوض نکن.
- روی فایل‌های منسوخ (`test-widget.html`, `public/admin.html`, `shop-data.json`) چیزی نساز.
- شل این محیط PowerShell 5.1 است؛ `&&` کار نمی‌کند.
- **هرگز فایل‌های این پروژه را با `Get-Content` بخوان و دوباره بنویس.** فایل‌ها UTF-8 بدون BOM
  هستند و `Get-Content` در PowerShell 5.1 آن‌ها را با کدپیج ANSI می‌خواند؛ نوشتن دوباره‌اش
  همه‌ی متن‌های فارسی را دوبار-انکود و خراب می‌کند (یک بار `server.js` را همین‌طور خراب کرد و
  پیام‌ها در ویجت به شکل `Ù…Ø´Ø§Ù‡Ø¯Ù‡` نمایش داده شدند). برای ویرایش از ابزار Edit استفاده کن؛
  اگر ناچار به PowerShell شدی، حتماً `[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)`
  و `WriteAllText` با `UTF8Encoding($false)`.
