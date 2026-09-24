// رمزنگاری فایل بکاپ پیش از خروج از سرور. بکاپ شماره‌ی موبایل کاربران و متن گفتگوهای
// مشتری‌هایشان را دارد و نباید خام روی سرویس دیگری (تلگرام) برود.
//
// قالب فایل: MAGIC | salt(16) | iv(12) | tag(16) | AES-256-GCM(gzip(db))
// کلید از BACKUP_PASSPHRASE با scrypt ساخته می‌شود؛ بدون این رمز، فایل قابل بازکردن نیست.
const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = Buffer.from('BPSDBK1');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
}

function encryptBackup(raw, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(raw, { level: 9 })), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function decryptBackup(file, passphrase) {
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('این فایل بکاپ رمزنگاری‌شده‌ی بپرسید نیست.');
  let o = MAGIC.length;
  const salt = file.subarray(o, o += 16);
  const iv = file.subarray(o, o += 12);
  const tag = file.subarray(o, o += 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  let gz;
  try { gz = Buffer.concat([decipher.update(file.subarray(o)), decipher.final()]); }
  catch (e) { throw new Error('رمز بکاپ اشتباه است یا فایل خراب شده.'); }
  return zlib.gunzipSync(gz);
}

module.exports = { encryptBackup, decryptBackup };
