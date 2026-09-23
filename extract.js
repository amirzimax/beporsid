// استخراج متن از فایل‌های آپلودی پایگاه دانش (txt / docx / xlsx / pdf).
// خروجی همیشه متن ساده‌ست تا بره توی ایندکس؛ جدول‌های اکسل به‌صورت «ستون: مقدار | ...» در هر ردیف
// نوشته می‌شن که هم برای مدل خوانا باشه هم جست‌وجوپذیر.
const path = require('path');

const MAX_CHARS = 400000;

function cleanText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}

async function extractDocx(buffer) {
  const mammoth = require('mammoth');
  const r = await mammoth.extractRawText({ buffer });
  return cleanText(r.value);
}

function extractXlsx(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    if (!rows.length) continue;
    const header = rows[0].map(h => String(h || '').trim());
    const hasHeader = header.some(Boolean) && rows.length > 1;
    parts.push(`### ${name}`);
    const body = hasHeader ? rows.slice(1) : rows;
    for (const row of body) {
      const cells = row.map(c => String(c ?? '').trim());
      if (!cells.some(Boolean)) continue;
      parts.push(hasHeader
        ? cells.map((c, i) => c ? `${header[i] || 'ستون' + (i + 1)}: ${c}` : '').filter(Boolean).join(' | ')
        : cells.filter(Boolean).join(' | '));
    }
    parts.push('');
  }
  return cleanText(parts.join('\n'));
}

async function extractPdf(buffer) {
  const pdfParse = require('pdf-parse');
  const r = await pdfParse(buffer);
  return cleanText(r.text);
}

const SUPPORTED = ['.txt', '.docx', '.xlsx', '.xls', '.pdf', '.csv'];

async function extractText(filename, buffer) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.txt' || ext === '.csv') return cleanText(buffer.toString('utf8'));
  if (ext === '.docx') return extractDocx(buffer);
  if (ext === '.xlsx' || ext === '.xls') return extractXlsx(buffer);
  if (ext === '.pdf') return extractPdf(buffer);
  throw new Error('فرمت فایل پشتیبانی نمی‌شود.');
}

module.exports = { extractText, SUPPORTED, MAX_CHARS };
