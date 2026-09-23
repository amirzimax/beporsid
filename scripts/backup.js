// بکاپ روزانه‌ی دیتابیس SQLite با API رسمی better-sqlite3 (امن حتی وقتی سرور در حال نوشتنه).
// اجرا با cron روی سرور:  0 3 * * *  cd /root/chatbot && node scripts/backup.js >> /root/backups/backup.log 2>&1
// فایل‌های قدیمی‌تر از KEEP_DAYS حذف می‌شن.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'chatbot.db');
const OUT_DIR = process.env.BACKUP_DIR || '/root/backups';
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 7);

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(OUT_DIR, `chatbot-${stamp}.db`);

  const db = new Database(DB_PATH, { readonly: true });
  await db.backup(target);
  db.close();
  const size = fs.statSync(target).size;
  console.log(`[${new Date().toISOString()}] بکاپ گرفته شد: ${target} (${(size / 1024).toFixed(0)} KB)`);

  const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!/^chatbot-.*\.db$/.test(f)) continue;
    const p = path.join(OUT_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); console.log('حذف بکاپ قدیمی:', f); }
  }
})().catch(e => { console.error('خطای بکاپ:', e.message); process.exit(1); });
