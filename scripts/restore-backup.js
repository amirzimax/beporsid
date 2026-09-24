// بازکردن بکاپ رمزنگاری‌شده‌ای که هر شب به تلگرام مدیر فرستاده می‌شود.
//
//   BACKUP_PASSPHRASE='رمز بکاپ' node scripts/restore-backup.js beporsid-backup-....db.gz.enc [chatbot-restored.db]
//
// روی سرور اگر BACKUP_PASSPHRASE در .env باشد، گذاشتنش در خط فرمان لازم نیست.
// خروجی یک فایل SQLite معمولی است؛ برای بازگردانی: pm2 stop chatbot، جایگزینی chatbot.db
// (و پاک کردن chatbot.db-wal و chatbot.db-shm قدیمی)، سپس pm2 start chatbot.
const fs = require('fs');
const path = require('path');
const { decryptBackup } = require('./backup-crypto');

try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (e) { /* روی سیستم شخصی dotenv لازم نیست */ }

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('استفاده: node scripts/restore-backup.js <فایل .enc> [فایل خروجی .db]');
  process.exit(1);
}
const passphrase = process.env.BACKUP_PASSPHRASE;
if (!passphrase) {
  console.error('رمز بکاپ را با BACKUP_PASSPHRASE بدهید.');
  process.exit(1);
}

try {
  const out = output || input.replace(/\.db\.gz\.enc$/, '') + '-restored.db';
  if (fs.existsSync(out)) throw new Error(`فایل ${out} از قبل وجود دارد؛ نام دیگری بدهید.`);
  fs.writeFileSync(out, decryptBackup(fs.readFileSync(input), passphrase), { mode: 0o600 });
  console.log('بکاپ باز شد:', out);
} catch (e) {
  console.error('خطا:', e.message);
  process.exit(1);
}
