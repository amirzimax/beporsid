// پایگاه دانش هر فروشگاه: سوال‌وجواب، متن‌های بلند، فایل‌ها و صفحات وب.
// محتوا تکه‌تکه (chunk) و در FTS5 ایندکس می‌شه تا برای هر پیام مشتری فقط تکه‌های مرتبط
// به مدل داده بشه، نه کل دانش فروشگاه (که توی پرامپت جا نمی‌شه).
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    type TEXT NOT NULL,              -- qa | text | file | url
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    meta_json TEXT,                  -- اطلاعات اضافه: نام فایل، آدرس صفحه، ...
    status TEXT NOT NULL DEFAULT 'ready',   -- ready | processing | error
    error TEXT,
    size_chars INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_shop ON knowledge_items(shop_id, type, id DESC);

  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    shop_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    content TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_item ON knowledge_chunks(item_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    content,
    chunk_id UNINDEXED,
    item_id UNINDEXED,
    shop_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`);

// حدود هر نوع محتوا (طبق نیازمندی‌ها)
const LIMITS = {
  qa: { question: 100, answer: 500, maxItems: 1000 },
  text: { title: 50, content: 5000 },
  file: { maxFiles: 50, maxBytes: 10 * 1024 * 1024, maxChars: 400000 },
  url: { maxPages: 20, maxChars: 300000 },
  chunk: 900
};

// --- نرمال‌سازی متن فارسی برای ایندکس و جست‌وجو (باید هر دو طرف یکسان باشه) ---
function normalizeFa(s) {
  return String(s || '')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/ۀ/g, 'ه')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[‌‏‎ً-ٟ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(('از به در که را با این آن و است برای تا هم یا من شما چه چی چطور چگونه آیا میشه می شه هست هستم هستید دارید داره دارم داری دارین کنید کنم کنه کرد کردم بود باشه باشد باید نه بله سلام لطفا لطفاً خب خوب یه یک یکی رو ی ها های و اگه اگر ولی اما چون وقتی کجا کی چند چقدر چیه چیست بگو بگید بده بدید میخوام می خوام میخواستم بعد پس چجوری چطوری چطور چقدره چیه اینو همین اون میتونم میشه').split(' '));

// عبارت FTS5 از روی پیام مشتری: هر کلمه‌ی معنی‌دار یک term، با OR کنار هم تا هر تطابقی بیاد؛
// کلمات ۴ حرفی به بالا با prefix تا «قاب‌ها» و «قاب» هم به هم برسن. bm25 بعداً بهترین‌ها رو جلو می‌آره.
// پسوندهای محاوره‌ای فارسی. جست‌وجوی prefix فقط یک طرفه است: «ارسالش*» متنی را که «ارسال»
// دارد پیدا نمی‌کند، پس ریشه‌ی بدون پسوند هم جداگانه جست‌وجو می‌شود. ترتیب از بلند به کوتاه.
const FA_SUFFIXES = ['هایشان', 'هاشون', 'هایش', 'هاتون', 'هاش', 'های', 'ها', 'شون', 'تون', 'مون', 'شان', 'تان', 'مان', 'یش', 'اش', 'ش', 'ی'];
function stripFaSuffix(t) {
  if (!/[؀-ۿ]/.test(t)) return t;
  for (const s of FA_SUFFIXES) {
    if (t.endsWith(s) && t.length - s.length >= 3) return t.slice(0, -s.length);
  }
  return t;
}

function buildFtsQuery(text) {
  const tokens = normalizeFa(text).toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
  const uniq = [...new Set(tokens)].slice(0, 12);
  if (!uniq.length) return null;
  const terms = new Set();
  for (const t of uniq) {
    const safe = t.replace(/"/g, '');
    terms.add(safe.length >= 4 ? `"${safe}"*` : `"${safe}"`);
    const stem = stripFaSuffix(safe);
    if (stem !== safe) terms.add(`"${stem}"*`);
  }
  return [...terms].join(' OR ');
}

// --- تکه‌کردن متن: بر اساس پاراگراف، هر تکه حداکثر ~۹۰۰ کاراکتر ---
function chunkText(text, max = LIMITS.chunk) {
  const paras = String(text || '').replace(/\r/g, '').split(/\n{1,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (let p of paras) {
    // پاراگراف خیلی بلند رو با جمله‌ها می‌شکنیم
    if (p.length > max * 1.4) {
      const sentences = p.split(/(?<=[.!?؟۔])\s+/);
      for (const s of sentences) {
        if ((cur + ' ' + s).length > max) push();
        cur += (cur ? ' ' : '') + s;
      }
      continue;
    }
    if ((cur + '\n' + p).length > max) push();
    cur += (cur ? '\n' : '') + p;
  }
  push();
  return chunks;
}

// --- نوشتن ---
const insertItemTx = db.transaction((shopId, type, title, content, meta, status) => {
  const info = db.prepare(`
    INSERT INTO knowledge_items (shop_id, type, title, content, meta_json, status, size_chars)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(shopId, type, title, content, meta ? JSON.stringify(meta) : null, status || 'ready', content.length);
  const id = info.lastInsertRowid;
  if ((status || 'ready') === 'ready') indexItem(id, shopId, type, title, content);
  return id;
});

function indexItem(itemId, shopId, type, title, content) {
  db.prepare('DELETE FROM knowledge_chunks WHERE item_id = ?').run(itemId);
  db.prepare('DELETE FROM knowledge_fts WHERE item_id = ?').run(itemId);
  // برای سوال‌وجواب، سوال و جواب با هم یک تکه‌ان تا با پرسیدن سوال، جوابش پیدا بشه
  const chunks = type === 'qa'
    ? [`پرسش: ${title}\nپاسخ: ${content}`]
    : chunkText(title ? `${title}\n${content}` : content);
  const insChunk = db.prepare('INSERT INTO knowledge_chunks (item_id, shop_id, seq, content) VALUES (?, ?, ?, ?)');
  const insFts = db.prepare('INSERT INTO knowledge_fts (content, chunk_id, item_id, shop_id) VALUES (?, ?, ?, ?)');
  chunks.forEach((c, i) => {
    const r = insChunk.run(itemId, shopId, i, c);
    insFts.run(normalizeFa(c), r.lastInsertRowid, itemId, shopId);
  });
  return chunks.length;
}

function addItem(shopId, type, title, content, meta, status) {
  return getItem(shopId, insertItemTx(shopId, type, title, content, meta, status));
}

const updateItemTx = db.transaction((shopId, id, title, content) => {
  const item = db.prepare('SELECT * FROM knowledge_items WHERE id = ? AND shop_id = ?').get(id, shopId);
  if (!item) return null;
  db.prepare(`UPDATE knowledge_items SET title = ?, content = ?, size_chars = ?, status = 'ready', error = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(title, content, content.length, id);
  indexItem(id, shopId, item.type, title, content);
  return id;
});
function updateItem(shopId, id, title, content) {
  const r = updateItemTx(shopId, id, title, content);
  return r ? getItem(shopId, id) : null;
}

// وقتی پردازش پس‌زمینه (فایل/صفحه‌ی وب) تموم می‌شه
const finishProcessingTx = db.transaction((id, shopId, content, meta, error) => {
  const item = db.prepare('SELECT * FROM knowledge_items WHERE id = ? AND shop_id = ?').get(id, shopId);
  if (!item) return;
  if (error) {
    db.prepare(`UPDATE knowledge_items SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?`).run(String(error).slice(0, 500), id);
    return;
  }
  const merged = Object.assign({}, item.meta_json ? JSON.parse(item.meta_json) : {}, meta || {});
  db.prepare(`UPDATE knowledge_items SET content = ?, size_chars = ?, meta_json = ?, status = 'ready', error = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(content, content.length, JSON.stringify(merged), id);
  indexItem(id, shopId, item.type, item.title, content);
});

const deleteItemTx = db.transaction((shopId, id) => {
  const item = db.prepare('SELECT id FROM knowledge_items WHERE id = ? AND shop_id = ?').get(id, shopId);
  if (!item) return false;
  db.prepare('DELETE FROM knowledge_fts WHERE item_id = ?').run(id);
  db.prepare('DELETE FROM knowledge_chunks WHERE item_id = ?').run(id);
  db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(id);
  return true;
});

// --- خواندن ---
function toPublicItem(row) {
  if (!row) return null;
  return {
    id: row.id, type: row.type, title: row.title,
    content: row.content, meta: row.meta_json ? JSON.parse(row.meta_json) : {},
    status: row.status, error: row.error, size_chars: row.size_chars,
    created_at: row.created_at, updated_at: row.updated_at
  };
}
function getItem(shopId, id) {
  return toPublicItem(db.prepare('SELECT * FROM knowledge_items WHERE id = ? AND shop_id = ?').get(id, shopId));
}
function listItems(shopId, type) {
  const rows = type
    ? db.prepare('SELECT * FROM knowledge_items WHERE shop_id = ? AND type = ? ORDER BY id DESC').all(shopId, type)
    : db.prepare('SELECT * FROM knowledge_items WHERE shop_id = ? ORDER BY id DESC').all(shopId);
  // برای فهرست، محتوای کامل فایل‌های بزرگ رو نمی‌فرستیم
  return rows.map(r => {
    const it = toPublicItem(r);
    if (it.type !== 'qa' && it.type !== 'text') it.content = it.content.slice(0, 300);
    return it;
  });
}
function countItems(shopId, type) {
  return db.prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE shop_id = ? AND type = ?').get(shopId, type).n;
}
function getStats(shopId) {
  const rows = db.prepare('SELECT type, COUNT(*) AS n, COALESCE(SUM(size_chars), 0) AS chars FROM knowledge_items WHERE shop_id = ? GROUP BY type').all(shopId);
  const out = { qa: 0, text: 0, file: 0, url: 0, chars: 0 };
  for (const r of rows) { out[r.type] = r.n; out.chars += r.chars; }
  return out;
}

// --- جست‌وجو: تکه‌های مرتبط با پیام مشتری ---
function search(shopId, query, limit = 5) {
  const q = buildFtsQuery(query);
  if (!q) return [];
  let rows;
  try {
    rows = db.prepare(`
      SELECT f.chunk_id, f.item_id, bm25(knowledge_fts) AS score, c.content, i.type, i.title, i.meta_json
      FROM knowledge_fts f
      JOIN knowledge_chunks c ON c.id = f.chunk_id
      JOIN knowledge_items i ON i.id = f.item_id
      WHERE knowledge_fts MATCH ? AND f.shop_id = ? AND i.status = 'ready'
      ORDER BY score
      LIMIT ?
    `).all(q, shopId, limit * 3);
  } catch (e) {
    // عبارت FTS نامعتبر (کاراکترهای خاص) - جست‌وجو رو خالی برمی‌گردونیم نه خطا
    return [];
  }
  // حداکثر ۲ تکه از هر آیتم تا یک فایل بلند همه‌ی جا رو نگیره
  const perItem = new Map();
  const out = [];
  for (const r of rows) {
    const n = perItem.get(r.item_id) || 0;
    if (n >= 2) continue;
    perItem.set(r.item_id, n + 1);
    const meta = r.meta_json ? JSON.parse(r.meta_json) : {};
    out.push({ type: r.type, title: r.title, content: r.content, source: meta.url || meta.filename || null, score: r.score });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  LIMITS, normalizeFa, chunkText,
  addItem, updateItem, deleteItem: (shopId, id) => deleteItemTx(shopId, id),
  finishProcessing: (id, shopId, content, meta, error) => finishProcessingTx(id, shopId, content, meta, error),
  getItem, listItems, countItems, getStats, search
};
