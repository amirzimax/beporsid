// محصولات دستی فروشگاه (فرم تکی یا فایل CSV/Excel). فقط وقتی استفاده می‌شن که فروشگاه به
// شاپفا یا ووکامرس وصل نباشه؛ در اون حالت search_products از همین جدول می‌خونه.
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    external_id TEXT,
    sku TEXT,
    name TEXT NOT NULL,
    short_desc TEXT DEFAULT '',
    brand TEXT DEFAULT '',
    price REAL,
    final_price REAL,
    description TEXT DEFAULT '',
    stock_status TEXT DEFAULT 'instock',   -- instock | outofstock
    stock_qty INTEGER,
    link TEXT,
    image TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_products_sku ON products(shop_id, sku);
  CREATE INDEX IF NOT EXISTS idx_products_ext ON products(shop_id, external_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
    name, brand, sku, short_desc,
    product_id UNINDEXED, shop_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`);

const LIMITS = { name: 500, description: 3000, maxProducts: 20000, importRows: 20000 };

function normalizeFa(s) {
  return String(s || '')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[‌‏‎]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = normalizeFa(String(v)).replace(/[,،\s]/g, '').replace(/تومان|ریال/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeStock(v, qty) {
  const s = normalizeFa(String(v || '')).toLowerCase();
  if (/ناموجود|اتمام|outofstock|out_of_stock|out of stock|^0$|false|no|نه/.test(s)) return 'outofstock';
  if (s === '' && qty !== null && qty !== undefined) return qty > 0 ? 'instock' : 'outofstock';
  return 'instock';
}

function clean(p) {
  const qty = toNumber(p.stock_qty);
  return {
    external_id: p.external_id ? String(p.external_id).trim().slice(0, 100) : null,
    sku: p.sku ? String(p.sku).trim().slice(0, 100) : null,
    name: String(p.name || '').trim().slice(0, LIMITS.name),
    short_desc: String(p.short_desc || '').trim().slice(0, 500),
    brand: String(p.brand || '').trim().slice(0, 100),
    price: toNumber(p.price),
    final_price: toNumber(p.final_price),
    description: String(p.description || '').trim().slice(0, LIMITS.description),
    stock_status: normalizeStock(p.stock_status, qty),
    stock_qty: qty === null ? null : Math.max(0, Math.round(qty)),
    link: p.link ? String(p.link).trim().slice(0, 500) : null,
    image: p.image ? String(p.image).trim().slice(0, 500) : null
  };
}

function indexProduct(id, shopId, p) {
  db.prepare('DELETE FROM products_fts WHERE product_id = ?').run(id);
  db.prepare('INSERT INTO products_fts (name, brand, sku, short_desc, product_id, shop_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(normalizeFa(p.name), normalizeFa(p.brand), normalizeFa(p.sku || ''), normalizeFa(p.short_desc), id, shopId);
}

const upsertTx = db.transaction((shopId, raw) => {
  const p = clean(raw);
  if (!p.name) return { skipped: true };
  // اگه SKU یا شناسه‌ی خارجی تکراری باشه، همون ردیف به‌روز می‌شه (برای آپلود دوباره‌ی فایل)
  let existing = null;
  if (p.sku) existing = db.prepare('SELECT id FROM products WHERE shop_id = ? AND sku = ?').get(shopId, p.sku);
  if (!existing && p.external_id) existing = db.prepare('SELECT id FROM products WHERE shop_id = ? AND external_id = ?').get(shopId, p.external_id);
  if (existing) {
    db.prepare(`UPDATE products SET external_id=?, sku=?, name=?, short_desc=?, brand=?, price=?, final_price=?, description=?, stock_status=?, stock_qty=?, link=?, image=?, updated_at=datetime('now') WHERE id=?`)
      .run(p.external_id, p.sku, p.name, p.short_desc, p.brand, p.price, p.final_price, p.description, p.stock_status, p.stock_qty, p.link, p.image, existing.id);
    indexProduct(existing.id, shopId, p);
    return { id: existing.id, updated: true };
  }
  const info = db.prepare(`INSERT INTO products (shop_id, external_id, sku, name, short_desc, brand, price, final_price, description, stock_status, stock_qty, link, image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(shopId, p.external_id, p.sku, p.name, p.short_desc, p.brand, p.price, p.final_price, p.description, p.stock_status, p.stock_qty, p.link, p.image);
  indexProduct(info.lastInsertRowid, shopId, p);
  return { id: info.lastInsertRowid, created: true };
});

function addProduct(shopId, raw) { return upsertTx(shopId, raw); }

const importTx = db.transaction((shopId, rows, maxTotal) => {
  let created = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    if (countProducts(shopId) >= maxTotal) { skipped++; continue; }
    const res = upsertTx(shopId, r);
    if (res.skipped) skipped++; else if (res.updated) updated++; else created++;
  }
  return { created, updated, skipped };
});
// maxTotal اختیاریه و سقف پلن فروشگاهه؛ اگه داده نشه، سقف کلی سیستم (LIMITS.maxProducts) استفاده می‌شه
function importProducts(shopId, rows, maxTotal) { return importTx(shopId, rows.slice(0, LIMITS.importRows), maxTotal ?? LIMITS.maxProducts); }

const updateTx = db.transaction((shopId, id, raw) => {
  const row = db.prepare('SELECT id FROM products WHERE id = ? AND shop_id = ?').get(id, shopId);
  if (!row) return null;
  const p = clean(raw);
  if (!p.name) return null;
  db.prepare(`UPDATE products SET sku=?, name=?, short_desc=?, brand=?, price=?, final_price=?, description=?, stock_status=?, stock_qty=?, link=?, image=?, updated_at=datetime('now') WHERE id=?`)
    .run(p.sku, p.name, p.short_desc, p.brand, p.price, p.final_price, p.description, p.stock_status, p.stock_qty, p.link, p.image, id);
  indexProduct(id, shopId, p);
  return getProduct(shopId, id);
});
function updateProduct(shopId, id, raw) { return updateTx(shopId, id, raw); }

const deleteTx = db.transaction((shopId, id) => {
  const row = db.prepare('SELECT id FROM products WHERE id = ? AND shop_id = ?').get(id, shopId);
  if (!row) return false;
  db.prepare('DELETE FROM products_fts WHERE product_id = ?').run(id);
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  return true;
});
function deleteProduct(shopId, id) { return deleteTx(shopId, id); }

const clearTx = db.transaction((shopId) => {
  db.prepare('DELETE FROM products_fts WHERE shop_id = ?').run(shopId);
  return db.prepare('DELETE FROM products WHERE shop_id = ?').run(shopId).changes;
});
function clearProducts(shopId) { return clearTx(shopId); }

function getProduct(shopId, id) {
  return db.prepare('SELECT * FROM products WHERE id = ? AND shop_id = ?').get(id, shopId) || null;
}
function countProducts(shopId) {
  return db.prepare('SELECT COUNT(*) AS n FROM products WHERE shop_id = ?').get(shopId).n;
}
function listProducts(shopId, { q = '', limit = 50, offset = 0 } = {}) {
  let total = countProducts(shopId);
  let items;
  if (q.trim()) {
    const like = `%${normalizeFa(q)}%`;
    total = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE shop_id = ? AND (name LIKE ? OR sku LIKE ? OR brand LIKE ?)`).get(shopId, like, like, like).n;
    items = db.prepare(`SELECT * FROM products WHERE shop_id = ? AND (name LIKE ? OR sku LIKE ? OR brand LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(shopId, like, like, like, limit, offset);
  } else {
    items = db.prepare('SELECT * FROM products WHERE shop_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(shopId, limit, offset);
  }
  return { items, total };
}

// جست‌وجو برای چت‌بات: نامزدها از FTS، بعد رتبه‌بندی دقیق‌تر توسط server.js انجام می‌شه
function searchCandidates(shopId, query, limit = 40) {
  const tokens = normalizeFa(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2);
  if (!tokens.length) return [];
  const q = [...new Set(tokens)].slice(0, 10).map(t => `"${t.replace(/"/g, '')}"*`).join(' OR ');
  try {
    return db.prepare(`
      SELECT p.* FROM products_fts f JOIN products p ON p.id = f.product_id
      WHERE products_fts MATCH ? AND f.shop_id = ?
      ORDER BY bm25(products_fts) LIMIT ?
    `).all(q, shopId, limit);
  } catch (e) { return []; }
}

// فایل نمونه برای دانلود
const SAMPLE_CSV = '﻿' + [
  'شناسه,SKU,نام محصول,توضیح کوتاه,نام برند,قیمت,قیمت نهایی,توضیحات,وضعیت موجودی,تعداد موجودی,لینک خرید,لینک تصویر',
  '101,CASE-A56-BLK,قاب سیلیکونی Galaxy A56 مشکی,قاب نرم با محافظ لنز,Samsung,450000,409000,"جنس سیلیکون، ضدضربه، مناسب A56 (2025)",موجود,12,https://mystore.com/product/case-a56,https://mystore.com/img/case-a56.jpg',
  '102,GLASS-A56,گلس تمام‌صفحه Galaxy A56,شیشه 9H,Samsung,185000,185000,نصب آسان با کیت تمیزکننده,ناموجود,0,https://mystore.com/product/glass-a56,'
].join('\n');

// نگاشت سرستون‌های فایل (فارسی یا انگلیسی) به فیلدهای جدول
const HEADER_MAP = [
  ['external_id', /^(شناسه|آیدی|id|product_id)$/i],
  ['sku', /^(sku|کد محصول|کد کالا|کد)$/i],
  ['name', /^(نام محصول|نام|عنوان|name|title|product_name)$/i],
  ['short_desc', /^(توضیح کوتاه|خلاصه|short_description|short_desc|excerpt)$/i],
  ['brand', /^(نام برند|برند|brand)$/i],
  ['price', /^(قیمت|قیمت اصلی|price|regular_price)$/i],
  ['final_price', /^(قیمت نهایی|قیمت با تخفیف|قیمت فروش|final_price|sale_price)$/i],
  ['description', /^(توضیحات|توضیح|جزئیات|description|details)$/i],
  ['stock_status', /^(وضعیت موجودی|موجودی|وضعیت|stock_status|in_stock|availability)$/i],
  ['stock_qty', /^(تعداد موجودی|تعداد|stock_quantity|quantity|qty|stock)$/i],
  ['link', /^(لینک خرید|لینک|آدرس|url|link|permalink)$/i],
  ['image', /^(لینک تصویر|تصویر|عکس|image|image_url|thumbnail)$/i]
];
function mapHeader(h) {
  const n = normalizeFa(h).toLowerCase();
  for (const [field, re] of HEADER_MAP) if (re.test(n)) return field;
  return null;
}

// تبدیل بافر CSV/Excel به آرایه‌ی ردیف‌های نگاشت‌شده
function parseProductFile(filename, buffer) {
  const XLSX = require('xlsx');
  const isCsv = /\.csv$/i.test(filename) || /\.txt$/i.test(filename);
  const wb = isCsv
    ? XLSX.read(buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true })
    : XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (rows.length < 2) return { rows: [], unknownHeaders: [], mapped: [] };
  const headers = rows[0].map(h => String(h || '').trim());
  const fields = headers.map(mapHeader);
  const unknownHeaders = headers.filter((h, i) => h && !fields[i]);
  if (!fields.includes('name')) throw new Error('ستون «نام محصول» در فایل پیدا نشد.');
  const out = [];
  for (const r of rows.slice(1)) {
    const obj = {};
    fields.forEach((f, i) => { if (f && r[i] !== undefined && r[i] !== '') obj[f] = r[i]; });
    if (obj.name) out.push(obj);
  }
  return { rows: out, unknownHeaders, mapped: fields.filter(Boolean) };
}

module.exports = {
  LIMITS, SAMPLE_CSV,
  addProduct, importProducts, updateProduct, deleteProduct, clearProducts,
  getProduct, listProducts, countProducts, searchCandidates, parseProductFile
};
