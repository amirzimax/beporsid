// بکاپ روزانه‌ی دیتابیس SQLite با API رسمی better-sqlite3 (امن حتی وقتی سرور در حال نوشتنه).
// اجرا با cron روی سرور:  0 3 * * *  cd /root/chatbot && node scripts/backup.js >> /root/backups/backup.log 2>&1
// فایل‌های قدیمی‌تر از KEEP_DAYS حذف می‌شن.
//
// نسخه‌ی بیرون از سرور: اگر BACKUP_PASSPHRASE در .env باشد، بکاپ فشرده و رمزنگاری می‌شود و
// با ربات تلگرام مدیر فرستاده می‌شود (بازکردن: scripts/restore-backup.js). اگر سرور از دست برود،
// آخرین بکاپ‌ها در تلگرام مدیر هست. بدون رمز، فقط خلاصه‌ی روز فرستاده می‌شود.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const fs = require('fs');
const { encryptBackup } = require('./backup-crypto');

const DB_PATH = path.join(__dirname, '..', 'chatbot.db');
const OUT_DIR = process.env.BACKUP_DIR || '/root/backups';
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 7);
const PASSPHRASE = process.env.BACKUP_PASSPHRASE || '';

const fa = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);

async function sendOffsite(target, size) {
  const alerts = require('../alerts');
  const { dailySummary } = require('../db');
  const s = dailySummary();
  const today = new Date().toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long' });
  const summary = `۲۴ ساعت گذشته: ${fa(s.signups)} ثبت‌نام · ${fa(s.paid.n)} پرداخت موفق` +
    (s.paid.n ? ` (${alerts.toman(s.paid.sum)})` : '') + ` · ${fa(s.conversations)} گفتگو\nکل فروشگاه‌ها: ${fa(s.shops)}`;

  if (PASSPHRASE.length < 12) {
    await alerts.notifyAdmins(`📦 بکاپ شبانه روی سرور گرفته شد — ${today}\n${summary}\n\n` +
      '⚠️ نسخه‌ی بیرون از سرور فرستاده نشد: BACKUP_PASSPHRASE (دست‌کم ۱۲ نویسه) در .env تنظیم نشده است.');
    return;
  }
  const enc = encryptBackup(fs.readFileSync(target), PASSPHRASE);
  const name = `beporsid-backup-${path.basename(target, '.db').replace(/^chatbot-/, '')}.db.gz.enc`;
  await alerts.sendAdminDocument(enc, name,
    `📦 بکاپ شبانه‌ی بپرسید — ${today}\n${summary}\n\n` +
    `حجم: ${(size / 1024).toFixed(0)} KB → ${(enc.length / 1024).toFixed(0)} KB (رمزنگاری‌شده)\n` +
    'بازکردن: node scripts/restore-backup.js <فایل>');
  console.log(`[${new Date().toISOString()}] نسخه‌ی رمزنگاری‌شده به تلگرام مدیر فرستاده شد (${(enc.length / 1024).toFixed(0)} KB)`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(OUT_DIR, `chatbot-${stamp}.db`);

  const db = new Database(DB_PATH, { readonly: true });
  await db.backup(target);
  db.close();
  const size = fs.statSync(target).size;
  console.log(`[${new Date().toISOString()}] بکاپ گرفته شد: ${target} (${(size / 1024).toFixed(0)} KB)`);

  // بکاپ اطلاعات کاربران را دارد؛ فقط root بتواند بخواندش
  const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!/^chatbot-.*\.db$/.test(f)) continue;
    const p = path.join(OUT_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); console.log('حذف بکاپ قدیمی:', f); }
    else fs.chmodSync(p, 0o600);
  }

  try {
    await sendOffsite(target, size);
  } catch (e) {
    // بکاپ محلی گرفته شده؛ خطای ارسال نباید آن را ناموفق نشان دهد
    console.error('خطای ارسال بکاپ به تلگرام:', e.message);
  }
})()
  .then(() => process.exit(0))
  .catch(e => { console.error('خطای بکاپ:', e.message); process.exit(1); });
