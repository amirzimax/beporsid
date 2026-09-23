const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, 'chatbot.db'));
db.pragma('journal_mode = WAL');

// جدول اصلی فروشگاه‌ها (هر ردیف یعنی یک مشتری از اپلیکیشن ما)
db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    site_key TEXT UNIQUE NOT NULL,

    shop_name TEXT DEFAULT 'فروشگاه من',
    shipping_policy TEXT DEFAULT '',
    returns_policy TEXT DEFAULT '',
    warranty_policy TEXT DEFAULT '',
    theme_color TEXT DEFAULT '#2563eb',

    shopfa_site_domain TEXT,
    shopfa_username TEXT,
    shopfa_password_enc TEXT,

    woo_site_domain TEXT,
    woo_consumer_key TEXT,
    woo_consumer_secret_enc TEXT,

    extra_info TEXT DEFAULT '',

    widget_side TEXT DEFAULT 'left',
    desktop_bottom INTEGER DEFAULT 20,
    desktop_side_offset INTEGER DEFAULT 20,
    mobile_bottom INTEGER DEFAULT 20,
    mobile_side_offset INTEGER DEFAULT 14,

    support_phone TEXT DEFAULT '',
    support_link TEXT DEFAULT '',
    support_hours TEXT DEFAULT '',

    phone TEXT,
    phone_verified_at TEXT,
    owner_first_name TEXT DEFAULT '',
    owner_last_name TEXT DEFAULT '',
    owner_name TEXT DEFAULT '',

    telegram_bot_token_enc TEXT,
    telegram_bot_username TEXT,
    telegram_secret TEXT,
    telegram_owner_chat_id TEXT,
    telegram_link_code TEXT,

    plan TEXT DEFAULT 'trial',
    plan_expires_at TEXT,

    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// مهاجرت ساده: ستون‌هایی که در نسخه‌های بعدی اضافه شدن رو به دیتابیس موجود اضافه می‌کنیم
const existingColumns = db.prepare("PRAGMA table_info(shops)").all().map(c => c.name);
const migrations = {
  extra_info: "ALTER TABLE shops ADD COLUMN extra_info TEXT DEFAULT ''",
  widget_side: "ALTER TABLE shops ADD COLUMN widget_side TEXT DEFAULT 'left'",
  desktop_bottom: "ALTER TABLE shops ADD COLUMN desktop_bottom INTEGER DEFAULT 20",
  desktop_side_offset: "ALTER TABLE shops ADD COLUMN desktop_side_offset INTEGER DEFAULT 20",
  mobile_bottom: "ALTER TABLE shops ADD COLUMN mobile_bottom INTEGER DEFAULT 20",
  mobile_side_offset: "ALTER TABLE shops ADD COLUMN mobile_side_offset INTEGER DEFAULT 14",
  support_phone: "ALTER TABLE shops ADD COLUMN support_phone TEXT DEFAULT ''",
  support_link: "ALTER TABLE shops ADD COLUMN support_link TEXT DEFAULT ''",
  support_hours: "ALTER TABLE shops ADD COLUMN support_hours TEXT DEFAULT ''",
  phone: "ALTER TABLE shops ADD COLUMN phone TEXT",
  phone_verified_at: "ALTER TABLE shops ADD COLUMN phone_verified_at TEXT",
  owner_first_name: "ALTER TABLE shops ADD COLUMN owner_first_name TEXT DEFAULT ''",
  owner_last_name: "ALTER TABLE shops ADD COLUMN owner_last_name TEXT DEFAULT ''",
  owner_name: "ALTER TABLE shops ADD COLUMN owner_name TEXT DEFAULT ''",
  woo_site_domain: "ALTER TABLE shops ADD COLUMN woo_site_domain TEXT",
  woo_consumer_key: "ALTER TABLE shops ADD COLUMN woo_consumer_key TEXT",
  woo_consumer_secret_enc: "ALTER TABLE shops ADD COLUMN woo_consumer_secret_enc TEXT",
  plan: "ALTER TABLE shops ADD COLUMN plan TEXT DEFAULT 'trial'",
  plan_expires_at: "ALTER TABLE shops ADD COLUMN plan_expires_at TEXT",
  telegram_bot_token_enc: "ALTER TABLE shops ADD COLUMN telegram_bot_token_enc TEXT",
  telegram_bot_username: "ALTER TABLE shops ADD COLUMN telegram_bot_username TEXT",
  telegram_secret: "ALTER TABLE shops ADD COLUMN telegram_secret TEXT",
  telegram_owner_chat_id: "ALTER TABLE shops ADD COLUMN telegram_owner_chat_id TEXT",
  telegram_link_code: "ALTER TABLE shops ADD COLUMN telegram_link_code TEXT"
};
for (const [col, sql] of Object.entries(migrations)) {
  if (!existingColumns.includes(col)) db.exec(sql);
}
// فیلد نام و نام خانوادگی قبلاً دو ستون جدا بود؛ یک‌بار برای حساب‌های قدیمی که owner_name خالیه
// ولی owner_first_name/owner_last_name پر بوده، مقدارشون رو توی owner_name ادغام می‌کنیم
if (!existingColumns.includes('owner_name')) {
  db.exec(`
    UPDATE shops SET owner_name = TRIM(COALESCE(owner_first_name, '') || ' ' || COALESCE(owner_last_name, ''))
    WHERE (owner_name IS NULL OR owner_name = '')
      AND (COALESCE(owner_first_name, '') != '' OR COALESCE(owner_last_name, '') != '')
  `);
}

// ایندکس یکتا روی phone برای جلوگیری از دو حساب با یک شماره؛ چون phone می‌تونه NULL باشه
// (حساب‌های قدیمی بدون شماره) و SQLite چند NULL رو در ایندکس یکتا تکراری حساب نمی‌کنه، مشکلی نیست
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_phone ON shops(phone)`);

// کدهای یک‌بارمصرف ورود با پیامک (کاوه‌نگار). کد هش‌شده ذخیره می‌شه تا حتی با دسترسی به
// دیتابیس هم قابل‌استفاده نباشه.
db.exec(`
  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    consumed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, created_at DESC);
`);

// گفتگوهای مشتری‌های هر فروشگاه: یک ردیف برای هر جلسه‌ی چت ویجت، و پیام‌هاش در جدول جدا
// تا صاحب فروشگاه بتونه در پنل ببینه خریدارها چی پرسیدن و دستیار چی جواب داده
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    page_url TEXT,
    message_count INTEGER DEFAULT 0,
    preview TEXT DEFAULT '',
    needs_agent INTEGER DEFAULT 0,
    handled_at TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    last_message_at TEXT DEFAULT (datetime('now')),
    UNIQUE(shop_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_shop ON conversations(shop_id, last_message_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    products_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
`);
// مهاجرت جدول گفتگوها برای دیتابیس‌هایی که از قبل ساخته شده‌اند
{
  const convColumns = db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
  if (!convColumns.includes('needs_agent')) db.exec('ALTER TABLE conversations ADD COLUMN needs_agent INTEGER DEFAULT 0');
  if (!convColumns.includes('handled_at')) db.exec('ALTER TABLE conversations ADD COLUMN handled_at TEXT');
  // تا این زمان، کارشناس گفتگو را در دست دارد و دستیار هوش مصنوعی در این مکالمه ساکت می‌ماند
  if (!convColumns.includes('agent_until')) db.exec('ALTER TABLE conversations ADD COLUMN agent_until TEXT');
}

// گفتگوهای تلگرام: هر ردیف یعنی یک مشتری که با ربات تلگرامِ یک فروشگاه حرف می‌زند.
// handoff_until تعیین می‌کند ربات تا چه زمانی ساکت بماند (وقتی فروشنده خودش جواب داده).
db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    customer_name TEXT DEFAULT '',
    handoff_until TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_message_at TEXT DEFAULT (datetime('now')),
    UNIQUE(shop_id, chat_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tgchats_shop ON telegram_chats(shop_id, last_message_at DESC);
`);

// نگاشت «پیام نوتیفیکیشنی که به فروشنده فرستادیم» به «مشتریِ مربوط به آن».
// وقتی فروشنده روی آن پیام Reply بزند، از اینجا می‌فهمیم جوابش برای کدام مشتری است.
// مشتری می‌تواند در تلگرام باشد (customer_chat_id) یا در ویجت سایت (conversation_id).
db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    owner_message_id TEXT NOT NULL,
    customer_chat_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(shop_id, owner_message_id)
  );
`);
{
  const notifColumns = db.prepare('PRAGMA table_info(telegram_notifications)').all().map(c => c.name);
  // برای مشتری‌های ویجت سایت، customer_chat_id خالی ('') می‌ماند و این ستون پر می‌شود
  if (!notifColumns.includes('conversation_id')) {
    db.exec('ALTER TABLE telegram_notifications ADD COLUMN conversation_id INTEGER');
  }
}

// تیکت‌های پشتیبانی: هر تیکت یک گفتگوی جدا بین صاحب فروشگاه و مدیر سامانه است.
// status: open (منتظر پاسخ ما) | answered (پاسخ دادیم) | closed (بسته شده)
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    last_reply_by TEXT NOT NULL DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_shop ON tickets(shop_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS ticket_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_msgs ON ticket_messages(ticket_id, id);
`);

// پرداخت‌های اشتراک (زرین‌پال). هر ردیف یعنی یک تلاش برای خرید/تمدید پلن؛ status از pending
// شروع می‌شه و بعد از بازگشت از درگاه و تأیید واقعی نزد زرین‌پال، به paid یا failed می‌ره.
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    cycle TEXT NOT NULL DEFAULT 'monthly',
    amount INTEGER NOT NULL,
    authority TEXT,
    ref_id TEXT,
    card_pan TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_payments_shop ON payments(shop_id, id DESC);
`);
{
  const paymentsColumns = db.prepare("PRAGMA table_info(payments)").all().map(c => c.name);
  if (!paymentsColumns.includes('cycle')) db.exec("ALTER TABLE payments ADD COLUMN cycle TEXT NOT NULL DEFAULT 'monthly'");
}

// --- رمزنگاری رمزعبور شاپفای مشتری قبل از ذخیره در دیتابیس ---
// از رمزعبور خود کاربر پنل (که هش می‌شه) کاملاً جداست؛ این AES-256-GCM برای
// رمزنگاریِ قابل‌بازگشتِ اطلاعات ورودی API شاپفاست، چون خودمون بعداً لازمش داریم.
// اگر این کلید تنظیم نشده باشد نباید با مقدار پیش‌فرض ادامه بدهیم: رمز شاپفا و کلید ووکامرسِ
// همه‌ی مشتری‌ها با همین کلید رمز می‌شوند و مقدار پیش‌فرض یعنی هرکسی با یک کپی از دیتابیس
// می‌تواند همه‌شان را باز کند.
if (!process.env.ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET.length < 32) {
  console.error('خطا: ENCRYPTION_SECRET تنظیم نشده یا کوتاه‌تر از ۳۲ کاراکتر است. یک مقدار تصادفی بلند در .env بگذار.');
  process.exit(1);
}
const ENCRYPTION_KEY = crypto.createHash('sha256').update(process.env.ENCRYPTION_SECRET).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(data) {
  const buf = Buffer.from(data, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function generateSiteKey() {
  return 'sk_' + crypto.randomBytes(20).toString('hex');
}

// --- توابع کار با جدول shops ---

function getShopById(id) {
  return db.prepare('SELECT * FROM shops WHERE id = ?').get(id);
}

function getShopBySiteKey(siteKey) {
  return db.prepare('SELECT * FROM shops WHERE site_key = ?').get(siteKey);
}

function updateShopSettings(id, { shop_name, shipping_policy, returns_policy, warranty_policy, theme_color, widget_side, desktop_bottom, desktop_side_offset, mobile_bottom, mobile_side_offset, support_phone, support_link, support_hours }) {
  db.prepare(`
    UPDATE shops SET
      shop_name = COALESCE(?, shop_name),
      shipping_policy = COALESCE(?, shipping_policy),
      returns_policy = COALESCE(?, returns_policy),
      warranty_policy = COALESCE(?, warranty_policy),
      theme_color = COALESCE(?, theme_color),
      widget_side = COALESCE(?, widget_side),
      desktop_bottom = COALESCE(?, desktop_bottom),
      desktop_side_offset = COALESCE(?, desktop_side_offset),
      mobile_bottom = COALESCE(?, mobile_bottom),
      mobile_side_offset = COALESCE(?, mobile_side_offset),
      support_phone = COALESCE(?, support_phone),
      support_link = COALESCE(?, support_link),
      support_hours = COALESCE(?, support_hours)
    WHERE id = ?
  `).run(
    shop_name ?? null,
    shipping_policy ?? null,
    returns_policy ?? null,
    warranty_policy ?? null,
    theme_color ?? null,
    widget_side ?? null,
    Number.isFinite(Number(desktop_bottom)) && desktop_bottom !== undefined && desktop_bottom !== null ? Number(desktop_bottom) : null,
    Number.isFinite(Number(desktop_side_offset)) && desktop_side_offset !== undefined && desktop_side_offset !== null ? Number(desktop_side_offset) : null,
    Number.isFinite(Number(mobile_bottom)) && mobile_bottom !== undefined && mobile_bottom !== null ? Number(mobile_bottom) : null,
    Number.isFinite(Number(mobile_side_offset)) && mobile_side_offset !== undefined && mobile_side_offset !== null ? Number(mobile_side_offset) : null,
    support_phone ?? null,
    support_link ?? null,
    support_hours ?? null,
    id
  );
  return getShopById(id);
}

function updateShopfaCredentials(id, { shopfa_site_domain, shopfa_username, shopfa_password }) {
  const encPassword = shopfa_password ? encrypt(shopfa_password) : null;
  db.prepare(`
    UPDATE shops SET
      shopfa_site_domain = COALESCE(?, shopfa_site_domain),
      shopfa_username = COALESCE(?, shopfa_username),
      shopfa_password_enc = COALESCE(?, shopfa_password_enc)
    WHERE id = ?
  `).run(
    shopfa_site_domain ?? null,
    shopfa_username ?? null,
    encPassword,
    id
  );
  return getShopById(id);
}

function updateWooCredentials(id, { woo_site_domain, woo_consumer_key, woo_consumer_secret }) {
  const encSecret = woo_consumer_secret ? encrypt(woo_consumer_secret) : null;
  db.prepare(`
    UPDATE shops SET
      woo_site_domain = COALESCE(?, woo_site_domain),
      woo_consumer_key = COALESCE(?, woo_consumer_key),
      woo_consumer_secret_enc = COALESCE(?, woo_consumer_secret_enc)
    WHERE id = ?
  `).run(
    woo_site_domain ?? null,
    woo_consumer_key ?? null,
    encSecret,
    id
  );
  return getShopById(id);
}

function updateExtraInfo(id, text) {
  db.prepare('UPDATE shops SET extra_info = ? WHERE id = ?').run(text ?? '', id);
  return getShopById(id);
}

// --- توابع ورود با کد پیامکی (OTP) ---

function getShopByPhone(phone) {
  return db.prepare('SELECT * FROM shops WHERE phone = ?').get(phone);
}

// حساب جدیدی فقط با شماره موبایل می‌سازه (بدون ایمیل/رمزعبور واقعی). چون ستون‌های
// email و password_hash در جدول NOT NULL هستن، یک ایمیل و رمز تصادفی و غیرقابل‌حدس
// می‌سازیم که فقط برای رعایت این محدودیته و هیچ‌جا نمایش داده نمی‌شه؛ ورود این حساب
// فقط از طریق همین شماره و کد پیامکی ممکنه.
function createShopWithPhone(phone, name) {
  const placeholderEmail = `phone-${phone}@otp.beporsid.local`;
  const randomPasswordHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
  const siteKey = generateSiteKey();
  const info = db.prepare(`
    INSERT INTO shops (email, password_hash, site_key, phone, phone_verified_at, owner_name)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
  `).run(placeholderEmail, randomPasswordHash, siteKey, phone, name || '');
  return getShopById(info.lastInsertRowid);
}

function createOtpCode(phone, codeHash, expiresAt) {
  const info = db.prepare(`
    INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES (?, ?, ?)
  `).run(phone, codeHash, expiresAt);
  return info.lastInsertRowid;
}

// آخرین درخواست کد برای این شماره (صرف‌نظر از مصرف‌شده یا منقضی بودن) - برای فاصله‌ی زمانی بین درخواست‌ها
function getLastOtpRequest(phone) {
  return db.prepare('SELECT * FROM otp_codes WHERE phone = ? ORDER BY id DESC LIMIT 1').get(phone);
}

// آخرین کد فعال (مصرف‌نشده و منقضی‌نشده) این شماره - برای بررسی صحت کد وارد‌شده
function getActiveOtpCode(phone) {
  return db.prepare(`
    SELECT * FROM otp_codes
    WHERE phone = ? AND consumed = 0 AND expires_at > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).get(phone);
}

function countRecentOtpRequests(phone, sinceMinutes) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at >= datetime('now', ?)
  `).get(phone, `-${sinceMinutes} minutes`).n;
}

function incrementOtpAttempts(id) {
  db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
}

function consumeOtpCode(id) {
  db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(id);
}

// پاک‌سازی کدهای قدیمی (یک روز به بالا) تا جدول بی‌رویه بزرگ نشه
function cleanupOldOtpCodes() {
  db.prepare(`DELETE FROM otp_codes WHERE created_at < datetime('now', '-1 day')`).run();
}

// --- توابع کار با گفتگوها ---

// یک جفت پیام (سوال مشتری + جواب دستیار) رو در گفتگوی مربوط به این جلسه ثبت می‌کنه.
// اگه گفتگویی با این session_id برای این فروشگاه نباشه، می‌سازه.
// needsAgent یعنی دستیار در همین پیام مشتری را به کارشناس ارجاع داده؛ آن گفتگو تا وقتی
// صاحب فروشگاه رسیدگی نکند در تب «در حال انتظار» می‌ماند.
const logExchange = db.transaction((shopId, sessionId, pageUrl, userText, botText, products, needsAgent) => {
  db.prepare(`
    INSERT INTO conversations (shop_id, session_id, page_url, preview)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(shop_id, session_id) DO NOTHING
  `).run(shopId, sessionId, pageUrl || null, userText.slice(0, 120));

  const conv = db.prepare('SELECT id FROM conversations WHERE shop_id = ? AND session_id = ?').get(shopId, sessionId);
  const insertMsg = db.prepare('INSERT INTO messages (conversation_id, role, content, products_json) VALUES (?, ?, ?, ?)');
  insertMsg.run(conv.id, 'user', userText, null);
  insertMsg.run(conv.id, 'assistant', botText, products && products.length ? JSON.stringify(products) : null);

  db.prepare(`
    UPDATE conversations SET
      message_count = message_count + 2,
      last_message_at = datetime('now')
    WHERE id = ?
  `).run(conv.id);

  // اگر دوباره نیاز به کارشناس پیش آمد، گفتگو حتی اگر قبلاً رسیدگی شده بود دوباره باز می‌شود
  if (needsAgent) {
    db.prepare('UPDATE conversations SET needs_agent = 1, handled_at = NULL WHERE id = ?').run(conv.id);
  }
  return conv.id;
});

// ثبت پیام تنهای مشتری (بدون جواب دستیار) - وقتی کارشناس گفتگو را در دست دارد و
// دستیار ساکت است، پیام مشتری باید ثبت شود تا کارشناس آن را در پنل و تلگرام ببیند.
const logCustomerMessage = db.transaction((shopId, sessionId, pageUrl, userText) => {
  db.prepare(`
    INSERT INTO conversations (shop_id, session_id, page_url, preview)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(shop_id, session_id) DO NOTHING
  `).run(shopId, sessionId, pageUrl || null, userText.slice(0, 120));

  const conv = db.prepare('SELECT id FROM conversations WHERE shop_id = ? AND session_id = ?').get(shopId, sessionId);
  db.prepare('INSERT INTO messages (conversation_id, role, content, products_json) VALUES (?, ?, ?, NULL)')
    .run(conv.id, 'user', userText);
  // پیام تازه‌ی مشتری یعنی گفتگو دوباره منتظر جواب کارشناس است
  db.prepare(`
    UPDATE conversations SET message_count = message_count + 1, last_message_at = datetime('now'),
      needs_agent = 1, handled_at = NULL
    WHERE id = ?
  `).run(conv.id);
  return conv.id;
});

// پاسخ کارشناس انسانی به مشتریِ ویجت سایت. نقش 'agent' عمداً از 'assistant' جداست تا
// در سقف پاسخ ماهانه‌ی پلن (که فقط پاسخ‌های هوش مصنوعی را می‌شمارد) حساب نشود.
const addAgentMessage = db.transaction((shopId, conversationId, text, minutes) => {
  const conv = db.prepare('SELECT id, session_id FROM conversations WHERE id = ? AND shop_id = ?')
    .get(conversationId, shopId);
  if (!conv) return null;

  const info = db.prepare('INSERT INTO messages (conversation_id, role, content, products_json) VALUES (?, ?, ?, NULL)')
    .run(conv.id, 'agent', text);
  db.prepare(`
    UPDATE conversations SET message_count = message_count + 1, last_message_at = datetime('now'),
      handled_at = datetime('now'), agent_until = datetime('now', ?)
    WHERE id = ?
  `).run(`+${Math.max(1, Math.min(1440, minutes || 30))} minutes`, conv.id);

  return db.prepare('SELECT id, role, content, created_at FROM messages WHERE id = ?').get(info.lastInsertRowid);
});

// آیا کارشناس همین حالا این گفتگوی سایت را در دست دارد؟ (دستیار باید ساکت بماند)
function isAgentActive(shopId, sessionId) {
  const row = db.prepare(`
    SELECT 1 AS active FROM conversations
    WHERE shop_id = ? AND session_id = ? AND agent_until IS NOT NULL AND agent_until > datetime('now')
  `).get(shopId, sessionId);
  return !!row;
}

// برگرداندن گفتگو به دستیار، قبل از تمام شدن مهلت
function endAgentSession(shopId, conversationId) {
  const r = db.prepare('UPDATE conversations SET agent_until = NULL WHERE id = ? AND shop_id = ?')
    .run(conversationId, shopId);
  return r.changes > 0;
}

// پیام‌های تازه‌ی کارشناس برای ویجت مشتری (widget هر چند ثانیه این را می‌پرسد)
function getAgentMessagesAfter(shopId, sessionId, afterId) {
  const conv = db.prepare('SELECT id, agent_until FROM conversations WHERE shop_id = ? AND session_id = ?')
    .get(shopId, sessionId);
  if (!conv) return { items: [], agentActive: false };
  const items = db.prepare(`
    SELECT id, content, created_at FROM messages
    WHERE conversation_id = ? AND role = 'agent' AND id > ?
    ORDER BY id LIMIT 20
  `).all(conv.id, Number(afterId) || 0);
  const agentActive = !!db.prepare(`
    SELECT 1 AS a FROM conversations WHERE id = ? AND agent_until IS NOT NULL AND agent_until > datetime('now')
  `).get(conv.id);
  return { items, agentActive };
}

function getConversationBySession(shopId, sessionId) {
  return db.prepare('SELECT * FROM conversations WHERE shop_id = ? AND session_id = ?').get(shopId, sessionId) || null;
}

// «رسیدگی کردم» - چه با دکمه‌ی پنل، چه وقتی فروشنده در تلگرام جواب مشتری را داده
function markConversationHandled(shopId, conversationId) {
  const r = db.prepare(`UPDATE conversations SET handled_at = datetime('now') WHERE id = ? AND shop_id = ?`)
    .run(conversationId, shopId);
  return r.changes > 0;
}

function markSessionHandled(shopId, sessionId) {
  db.prepare(`UPDATE conversations SET handled_at = datetime('now') WHERE shop_id = ? AND session_id = ?`)
    .run(shopId, sessionId);
}

function reopenConversation(shopId, conversationId) {
  const r = db.prepare('UPDATE conversations SET handled_at = NULL WHERE id = ? AND shop_id = ?')
    .run(conversationId, shopId);
  return r.changes > 0;
}

// تعداد گفتگوهایی که منتظر رسیدگی‌اند - برای نشان روی تب
function countPendingConversations(shopId) {
  return db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE shop_id = ? AND needs_agent = 1 AND handled_at IS NULL')
    .get(shopId).n;
}

// filter='pending' فقط گفتگوهایی که دستیار به کارشناس ارجاع داده و هنوز رسیدگی نشده‌اند.
// حالت پیش‌فرض همه‌ی گفتگوهاست تا چیزی از دید صاحب فروشگاه پنهان نماند.
function listConversations(shopId, { q = '', limit = 30, offset = 0, filter = '' } = {}) {
  const like = `%${q.trim()}%`;
  const clauses = ['c.shop_id = ?'];
  const params = [shopId];
  if (q.trim()) {
    clauses.push('EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?)');
    params.push(like);
  }
  if (filter === 'pending') clauses.push('c.needs_agent = 1 AND c.handled_at IS NULL');
  const where = clauses.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE ${where}`).get(...params).n;
  const items = db.prepare(`
    SELECT c.id, c.session_id, c.page_url, c.message_count, c.preview, c.started_at, c.last_message_at,
           c.needs_agent, c.handled_at
    FROM conversations c
    WHERE ${where}
    ORDER BY c.last_message_at DESC, c.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { items, total, pending: countPendingConversations(shopId) };
}

function getConversation(shopId, conversationId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND shop_id = ?').get(conversationId, shopId);
  if (!conv) return null;
  const messages = db.prepare('SELECT id, role, content, products_json, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.id)
    .map(m => ({ ...m, products: m.products_json ? JSON.parse(m.products_json) : null, products_json: undefined }));
  return { ...conv, messages };
}

function deleteConversation(shopId, conversationId) {
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND shop_id = ?').get(conversationId, shopId);
  if (!conv) return false;
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
  return true;
}

function getShopStats(shopId) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS conversations,
      COALESCE(SUM(message_count), 0) AS messages,
      SUM(CASE WHEN date(last_message_at) = date('now') THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN last_message_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS week
    FROM conversations WHERE shop_id = ?
  `).get(shopId);
  return { conversations: row.conversations || 0, messages: row.messages || 0, today: row.today || 0, week: row.week || 0 };
}

// --- توابع کار با پرداخت و اشتراک ---

function createPayment(shopId, plan, amount, cycle) {
  const info = db.prepare('INSERT INTO payments (shop_id, plan, amount, cycle) VALUES (?, ?, ?, ?)').run(shopId, plan, amount, cycle || 'monthly');
  return info.lastInsertRowid;
}
function setPaymentAuthority(id, authority) {
  db.prepare('UPDATE payments SET authority = ? WHERE id = ?').run(authority, id);
}
function getPaymentById(id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}
function markPaymentPaid(id, refId, cardPan) {
  // زرین‌پال ref_id رو به‌صورت عدد برمی‌گردونه؛ صریحاً به رشته تبدیلش می‌کنیم چون وگرنه
  // SQLite ممکنه به‌خاطر affinity ستون TEXT، یه عدد صحیح رو به شکل "123.0" ذخیره کنه
  db.prepare(`UPDATE payments SET status = 'paid', ref_id = ?, card_pan = ?, paid_at = datetime('now') WHERE id = ?`).run(String(refId), cardPan || null, id);
}
function markPaymentFailed(id) {
  db.prepare(`UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'`).run(id);
}
function listPayments(shopId, limit = 30) {
  return db.prepare('SELECT * FROM payments WHERE shop_id = ? ORDER BY id DESC LIMIT ?').all(shopId, limit);
}

// تمدید/فعال‌سازی پلن: اگه اشتراک فعلی هنوز منقضی نشده، روزهای جدید به انتهاش اضافه می‌شه
// (نه از امروز) تا خریدهای زودهنگام هدر نره؛ وگرنه از همین لحظه شروع می‌شه.
function extendShopPlan(shopId, plan, days) {
  const shop = getShopById(shopId);
  const now = new Date();
  const currentExpiry = shop.plan_expires_at ? new Date(shop.plan_expires_at.replace(' ', 'T') + 'Z') : null;
  const base = (currentExpiry && currentExpiry > now) ? currentExpiry : now;
  const next = new Date(base.getTime() + days * 86400 * 1000);
  const nextStr = next.toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('UPDATE shops SET plan = ?, plan_expires_at = ? WHERE id = ?').run(plan, nextStr, shopId);
  return getShopById(shopId);
}

// تعداد پاسخ‌های دستیار از اول ماه میلادی جاری - همون واحدی که در تعرفه به مشتری فروخته می‌شه
// (نه تعداد گفتگو، چون یک گفتگو می‌تونه چند پاسخ داشته باشه)
function getMonthlyUsage(shopId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.shop_id = ? AND m.role = 'assistant' AND m.created_at >= datetime('now', 'start of month')
  `).get(shopId);
  return row.n || 0;
}

// فعال‌سازی پلن رایگان «آغازین» - بدون پرداخت، بدون انقضا (تا وقتی کاربر ارتقا نده فعال می‌مونه)
function activateFreePlan(shopId) {
  db.prepare(`UPDATE shops SET plan = 'starter', plan_expires_at = NULL WHERE id = ?`).run(shopId);
  return getShopById(shopId);
}

// --- توابع تیکت پشتیبانی ---

// ساخت تیکت و اولین پیامش با هم انجام می‌شود تا تیکت بدون متن ثبت نشود
const createTicketTx = db.transaction((shopId, subject, body) => {
  const info = db.prepare('INSERT INTO tickets (shop_id, subject) VALUES (?, ?)').run(shopId, subject);
  db.prepare("INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, 'user', ?)").run(info.lastInsertRowid, body);
  return info.lastInsertRowid;
});
function createTicket(shopId, subject, body) {
  return getTicket(shopId, createTicketTx(shopId, subject, body));
}

// سقف ساخت تیکت در بازه‌ی زمانی، برای جلوگیری از پر کردن جدول با تیکت‌های بی‌مورد
function countRecentTickets(shopId, sinceMinutes) {
  return db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE shop_id = ? AND created_at >= datetime('now', ?)`)
    .get(shopId, `-${sinceMinutes} minutes`).n;
}

function listTickets(shopId) {
  return db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
    FROM tickets t WHERE t.shop_id = ? ORDER BY t.updated_at DESC LIMIT 100
  `).all(shopId);
}

// همیشه با shop_id محدود می‌شود تا کسی تیکت فروشگاه دیگری را نبیند
function getTicket(shopId, id) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ? AND shop_id = ?').get(id, shopId);
  if (!t) return null;
  t.messages = db.prepare('SELECT id, sender, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id').all(t.id);
  return t;
}

// پاسخ کاربر تیکت را دوباره باز می‌کند، پاسخ مدیر آن را «پاسخ‌داده‌شده» می‌کند
const addTicketMessageTx = db.transaction((ticketId, sender, body) => {
  db.prepare('INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, ?, ?)').run(ticketId, sender, body);
  db.prepare(`UPDATE tickets SET status = ?, last_reply_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(sender === 'admin' ? 'answered' : 'open', sender, ticketId);
});

function replyToTicket(shopId, id, body) {
  const t = db.prepare('SELECT id FROM tickets WHERE id = ? AND shop_id = ?').get(id, shopId);
  if (!t) return null;
  addTicketMessageTx(id, 'user', body);
  return getTicket(shopId, id);
}

function setTicketStatus(shopId, id, status) {
  const r = db.prepare(`UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ? AND shop_id = ?`)
    .run(status, id, shopId);
  return r.changes ? getTicket(shopId, id) : null;
}

// --- تیکت از دید مدیر سامانه (بدون محدودیت فروشگاه) ---
function adminListTickets({ status = '', limit = 50, offset = 0 } = {}) {
  const where = status ? 'WHERE t.status = ?' : '';
  const params = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${where}`).get(...params).n;
  const items = db.prepare(`
    SELECT t.*, s.shop_name, s.owner_name, s.phone, s.plan,
      (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
    FROM tickets t LEFT JOIN shops s ON s.id = t.shop_id
    ${where} ORDER BY t.updated_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { items, total };
}

function adminGetTicket(id) {
  const t = db.prepare(`
    SELECT t.*, s.shop_name, s.owner_name, s.phone, s.plan
    FROM tickets t LEFT JOIN shops s ON s.id = t.shop_id WHERE t.id = ?
  `).get(id);
  if (!t) return null;
  t.messages = db.prepare('SELECT id, sender, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id').all(t.id);
  return t;
}

function adminReplyToTicket(id, body) {
  const t = db.prepare('SELECT id FROM tickets WHERE id = ?').get(id);
  if (!t) return null;
  addTicketMessageTx(id, 'admin', body);
  return adminGetTicket(id);
}

function adminSetTicketStatus(id, status) {
  const r = db.prepare(`UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  return r.changes ? adminGetTicket(id) : null;
}

// تعداد تیکت‌های منتظر پاسخ - برای نشان دادن روی منوی مدیریت
function countOpenTickets() {
  return db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'").get().n;
}

// --- توابع اتصال تلگرام ---

// توکن ربات مثل رمز شاپفا رمزنگاری‌شده ذخیره می‌شود: هرکس توکن را داشته باشد کنترل کامل
// ربات مشتری را دارد، پس هیچ‌جا خام نگه‌داری یا برگردانده نمی‌شود.
function setTelegramBot(shopId, { token, username, secret, linkCode }) {
  db.prepare(`
    UPDATE shops SET
      telegram_bot_token_enc = ?, telegram_bot_username = ?, telegram_secret = ?,
      telegram_link_code = ?, telegram_owner_chat_id = NULL
    WHERE id = ?
  `).run(encrypt(token), username || null, secret, linkCode, shopId);
  return getShopById(shopId);
}

function clearTelegramBot(shopId) {
  db.prepare(`
    UPDATE shops SET
      telegram_bot_token_enc = NULL, telegram_bot_username = NULL, telegram_secret = NULL,
      telegram_owner_chat_id = NULL, telegram_link_code = NULL
    WHERE id = ?
  `).run(shopId);
  db.prepare('DELETE FROM telegram_chats WHERE shop_id = ?').run(shopId);
  db.prepare('DELETE FROM telegram_notifications WHERE shop_id = ?').run(shopId);
  return getShopById(shopId);
}

function getShopByTelegramSecret(secret) {
  if (!secret) return null;
  return db.prepare('SELECT * FROM shops WHERE telegram_secret = ?').get(secret) || null;
}

// کد اتصال بعد از استفاده عوض می‌شود تا یک‌بارمصرف باشد: اگر کسی کد قبلی را جایی ببیند
// (مثلاً در اسکرین‌شات پنل) نتواند خودش را به‌جای مدیر ربات جا بزند.
function setTelegramOwnerChat(shopId, chatId) {
  db.prepare('UPDATE shops SET telegram_owner_chat_id = ?, telegram_link_code = ? WHERE id = ?')
    .run(String(chatId), crypto.randomBytes(6).toString('hex'), shopId);
  return getShopById(shopId);
}

// گفتگوی تلگرامی این مشتری را پیدا یا ایجاد می‌کند. session_id همان کلیدی است که در جدول
// conversations استفاده می‌شود تا گفتگوهای تلگرام هم در صندوق پنل دیده شوند.
function getOrCreateTelegramChat(shopId, chatId, customerName) {
  const key = String(chatId);
  let row = db.prepare('SELECT * FROM telegram_chats WHERE shop_id = ? AND chat_id = ?').get(shopId, key);
  if (!row) {
    db.prepare(`
      INSERT INTO telegram_chats (shop_id, chat_id, session_id, customer_name)
      VALUES (?, ?, ?, ?)
    `).run(shopId, key, 'tg_' + key, String(customerName || '').slice(0, 80));
    row = db.prepare('SELECT * FROM telegram_chats WHERE shop_id = ? AND chat_id = ?').get(shopId, key);
  }
  return row;
}

function touchTelegramChat(shopId, chatId) {
  db.prepare(`UPDATE telegram_chats SET last_message_at = datetime('now') WHERE shop_id = ? AND chat_id = ?`)
    .run(shopId, String(chatId));
}

// بعد از جواب دستی فروشنده، ربات این‌قدر دقیقه برای همین مشتری ساکت می‌ماند
function startTelegramHandoff(shopId, chatId, minutes) {
  db.prepare(`UPDATE telegram_chats SET handoff_until = datetime('now', ?) WHERE shop_id = ? AND chat_id = ?`)
    .run(`+${Math.max(1, Math.min(1440, minutes))} minutes`, shopId, String(chatId));
}

function endTelegramHandoff(shopId, chatId) {
  db.prepare('UPDATE telegram_chats SET handoff_until = NULL WHERE shop_id = ? AND chat_id = ?')
    .run(shopId, String(chatId));
}

function isTelegramHandoffActive(shopId, chatId) {
  const row = db.prepare(`
    SELECT 1 AS active FROM telegram_chats
    WHERE shop_id = ? AND chat_id = ? AND handoff_until IS NOT NULL AND handoff_until > datetime('now')
  `).get(shopId, String(chatId));
  return !!row;
}

// customerChatId برای مشتری تلگرامی، conversationId برای مشتریِ ویجت سایت. یکی از این دو پر است.
function saveTelegramNotification(shopId, ownerMessageId, customerChatId, conversationId) {
  db.prepare(`
    INSERT INTO telegram_notifications (shop_id, owner_message_id, customer_chat_id, conversation_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(shop_id, owner_message_id) DO UPDATE SET
      customer_chat_id = excluded.customer_chat_id,
      conversation_id = excluded.conversation_id
  `).run(shopId, String(ownerMessageId), String(customerChatId || ''), conversationId || null);
}

function getTelegramNotification(shopId, ownerMessageId) {
  return db.prepare('SELECT * FROM telegram_notifications WHERE shop_id = ? AND owner_message_id = ?')
    .get(shopId, String(ownerMessageId)) || null;
}

// جدول نوتیفیکیشن‌ها فقط برای مسیریابی جواب‌هاست؛ ردیف‌های قدیمی لازم نیستند
function cleanupTelegramNotifications() {
  db.prepare(`DELETE FROM telegram_notifications WHERE created_at < datetime('now', '-7 days')`).run();
}

// ==================== داده‌های پنل مدیر کل سیستم ====================
// این بخش نمای کل پلتفرم رو برای مدیر می‌سازه. قاعده‌ی ثابتش اینه: هیچ‌کدوم از این توابع
// نباید رمز یا کلید رمزنگاری‌شده برگردونن. به‌جای حذف فیلدهای حساس (که با اضافه شدن یک ستون
// جدید راحت فراموش می‌شه)، عمداً فقط فیلدهای مجاز صریحاً نوشته شدن.
function adminShopView(s) {
  if (!s) return null;
  return {
    id: s.id,
    shop_name: s.shop_name,
    owner_name: s.owner_name || '',
    phone: s.phone || '',
    plan: s.plan || 'trial',
    plan_expires_at: s.plan_expires_at || null,
    created_at: s.created_at,
    site_key: s.site_key,
    // نام‌کاربری شاپفا و کلید عمومی ووکامرس برای عیب‌یابی پشتیبانی لازم‌اند و خودِ صاحب
    // فروشگاه هم در پنلش می‌بیندشان؛ ولی رمز و کلید خصوصی هرگز اینجا نمی‌آیند.
    shopfa_site_domain: s.shopfa_site_domain || null,
    shopfa_username: s.shopfa_username || null,
    shopfa_connected: !!(s.shopfa_site_domain && s.shopfa_username && s.shopfa_password_enc),
    woo_site_domain: s.woo_site_domain || null,
    woo_consumer_key: s.woo_consumer_key || null,
    woo_connected: !!(s.woo_site_domain && s.woo_consumer_key && s.woo_consumer_secret_enc),
    support_phone: s.support_phone || '',
    support_link: s.support_link || '',
    support_hours: s.support_hours || ''
  };
}

function getAdminOverview() {
  const shops = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS week,
      SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS month
    FROM shops
  `).get();

  const connected = db.prepare(`
    SELECT
      SUM(CASE WHEN shopfa_site_domain IS NOT NULL AND shopfa_password_enc IS NOT NULL THEN 1 ELSE 0 END) AS shopfa,
      SUM(CASE WHEN woo_site_domain IS NOT NULL AND woo_consumer_secret_enc IS NOT NULL THEN 1 ELSE 0 END) AS woo
    FROM shops
  `).get();

  const plans = db.prepare('SELECT plan, COUNT(*) AS n FROM shops GROUP BY plan').all();

  const activity = db.prepare(`
    SELECT
      COUNT(*) AS conversations,
      COALESCE(SUM(message_count), 0) AS messages,
      SUM(CASE WHEN last_message_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS conversations_week
    FROM conversations
  `).get();

  // «فروشگاه فعال» یعنی در ۳۰ روز گذشته دست‌کم یک گفتگو داشته - معیار واقعی استفاده، نه فقط ثبت‌نام
  const active = db.prepare(`
    SELECT COUNT(DISTINCT shop_id) AS n FROM conversations WHERE last_message_at >= datetime('now', '-30 days')
  `).get();

  const responses = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE role = 'assistant' AND created_at >= datetime('now', 'start of month')
  `).get();

  const revenue = db.prepare(`
    SELECT
      COALESCE(SUM(amount), 0) AS total,
      COALESCE(SUM(CASE WHEN paid_at >= datetime('now', 'start of month') THEN amount ELSE 0 END), 0) AS this_month,
      COUNT(*) AS paid_count
    FROM payments WHERE status = 'paid'
  `).get();

  const pending = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'").get();

  return {
    shops: { total: shops.total || 0, today: shops.today || 0, week: shops.week || 0, month: shops.month || 0, active_30d: active.n || 0 },
    connected: { shopfa: connected.shopfa || 0, woo: connected.woo || 0 },
    plans: plans.reduce((acc, r) => { acc[r.plan || 'trial'] = r.n; return acc; }, {}),
    activity: {
      conversations: activity.conversations || 0,
      messages: activity.messages || 0,
      conversations_week: activity.conversations_week || 0,
      responses_this_month: responses.n || 0
    },
    revenue: { total: revenue.total || 0, this_month: revenue.this_month || 0, paid_count: revenue.paid_count || 0, pending_count: pending.n || 0 }
  };
}

function listAllShops({ q = '', limit = 50, offset = 0 } = {}) {
  const term = String(q || '').trim();
  const like = `%${term}%`;
  const where = term ? 'WHERE (s.shop_name LIKE ? OR s.owner_name LIKE ? OR s.phone LIKE ?)' : '';
  const params = term ? [like, like, like] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM shops s ${where}`).get(...params).n;
  const items = db.prepare(`
    SELECT s.id, s.shop_name, s.owner_name, s.phone, s.plan, s.plan_expires_at, s.created_at,
      (s.shopfa_site_domain IS NOT NULL AND s.shopfa_password_enc IS NOT NULL) AS shopfa_connected,
      (s.woo_site_domain IS NOT NULL AND s.woo_consumer_secret_enc IS NOT NULL) AS woo_connected,
      (SELECT COUNT(*) FROM conversations c WHERE c.shop_id = s.id) AS conversations,
      (SELECT MAX(c.last_message_at) FROM conversations c WHERE c.shop_id = s.id) AS last_activity,
      (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.shop_id = s.id AND m.role = 'assistant' AND m.created_at >= datetime('now', 'start of month')) AS responses_this_month,
      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id) AS products,
      (SELECT COUNT(*) FROM knowledge_items k WHERE k.shop_id = s.id) AS knowledge_items,
      (SELECT COALESCE(SUM(pay.amount), 0) FROM payments pay WHERE pay.shop_id = s.id AND pay.status = 'paid') AS revenue
    FROM shops s ${where}
    ORDER BY s.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { items, total };
}

function getShopAdminDetail(shopId) {
  const row = db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId);
  if (!row) return null;
  const conversations = db.prepare(`
    SELECT id, session_id, page_url, message_count, preview, started_at, last_message_at
    FROM conversations WHERE shop_id = ? ORDER BY last_message_at DESC LIMIT 15
  `).all(shopId);
  return {
    shop: adminShopView(row),
    stats: getShopStats(shopId),
    responses_this_month: getMonthlyUsage(shopId),
    counts: {
      products: db.prepare('SELECT COUNT(*) AS n FROM products WHERE shop_id = ?').get(shopId).n,
      knowledge: db.prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE shop_id = ?').get(shopId).n
    },
    payments: db.prepare('SELECT * FROM payments WHERE shop_id = ? ORDER BY id DESC LIMIT 20').all(shopId),
    conversations
  };
}

function listAllPayments({ status = '', limit = 50, offset = 0 } = {}) {
  const where = status ? 'WHERE p.status = ?' : '';
  const params = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM payments p ${where}`).get(...params).n;
  const items = db.prepare(`
    SELECT p.id, p.shop_id, p.plan, p.cycle, p.amount, p.status, p.ref_id, p.card_pan, p.created_at, p.paid_at,
           s.shop_name, s.owner_name, s.phone
    FROM payments p LEFT JOIN shops s ON s.id = p.shop_id
    ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { items, total };
}

// جست‌وجوی گفتگو در همه‌ی فروشگاه‌ها (برای پشتیبانی: «مشتری فلان فروشگاه چی پرسیده بود؟»)
function adminSearchConversations({ q = '', limit = 30, offset = 0 } = {}) {
  const term = String(q || '').trim();
  const like = `%${term}%`;
  const where = term
    ? `WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?)
         OR s.shop_name LIKE ?`
    : '';
  const params = term ? [like, like] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM conversations c LEFT JOIN shops s ON s.id = c.shop_id ${where}`).get(...params).n;
  const items = db.prepare(`
    SELECT c.id, c.shop_id, c.session_id, c.page_url, c.message_count, c.preview, c.started_at, c.last_message_at,
           s.shop_name
    FROM conversations c LEFT JOIN shops s ON s.id = c.shop_id
    ${where} ORDER BY c.last_message_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { items, total };
}

// خواندن یک گفتگو بدون محدودیت فروشگاه - فقط از مسیرهای ادمین صدا زده می‌شود
function getConversationAsAdmin(conversationId) {
  const conv = db.prepare(`
    SELECT c.*, s.shop_name FROM conversations c LEFT JOIN shops s ON s.id = c.shop_id WHERE c.id = ?
  `).get(conversationId);
  if (!conv) return null;
  const messages = db.prepare('SELECT id, role, content, products_json, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.id)
    .map(m => ({ ...m, products: m.products_json ? JSON.parse(m.products_json) : null, products_json: undefined }));
  return { ...conv, messages };
}

// نسخه‌ای از رکورد فروشگاه که برای فرانت‌اند امن باشه بفرستیم (بدون رمزهای حساس)
function toPublicShop(shop) {
  if (!shop) return null;
  return {
    id: shop.id,
    email: shop.email,
    site_key: shop.site_key,
    shop_name: shop.shop_name,
    shipping_policy: shop.shipping_policy,
    returns_policy: shop.returns_policy,
    warranty_policy: shop.warranty_policy,
    theme_color: shop.theme_color,
    extra_info: shop.extra_info || '',
    widget_side: shop.widget_side || 'left',
    desktop_bottom: shop.desktop_bottom ?? 20,
    desktop_side_offset: shop.desktop_side_offset ?? 20,
    mobile_bottom: shop.mobile_bottom ?? 20,
    mobile_side_offset: shop.mobile_side_offset ?? 14,
    support_phone: shop.support_phone || '',
    support_link: shop.support_link || '',
    support_hours: shop.support_hours || '',
    phone: shop.phone || '',
    phone_verified: !!shop.phone_verified_at,
    owner_name: shop.owner_name || '',
    plan: shop.plan || 'trial',
    plan_expires_at: shop.plan_expires_at || null,
    shopfa_site_domain: shop.shopfa_site_domain,
    shopfa_username: shop.shopfa_username,
    shopfa_connected: !!(shop.shopfa_site_domain && shop.shopfa_username && shop.shopfa_password_enc),
    woo_site_domain: shop.woo_site_domain,
    woo_consumer_key: shop.woo_consumer_key,
    woo_connected: !!(shop.woo_site_domain && shop.woo_consumer_key && shop.woo_consumer_secret_enc),
    // فقط وضعیت و نام کاربری ربات به فرانت می‌رود؛ توکن ربات هیچ‌وقت از سرور خارج نمی‌شود
    telegram_connected: !!shop.telegram_bot_token_enc,
    telegram_bot_username: shop.telegram_bot_username || null,
    telegram_owner_linked: !!shop.telegram_owner_chat_id,
    telegram_link_code: shop.telegram_link_code || null
  };
}

module.exports = {
  db,
  encrypt,
  decrypt,
  getShopById,
  getShopBySiteKey,
  updateShopSettings,
  updateShopfaCredentials,
  updateWooCredentials,
  updateExtraInfo,
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
  adminShopView,
  getAdminOverview,
  listAllShops,
  getShopAdminDetail,
  listAllPayments,
  adminSearchConversations,
  getConversationAsAdmin,
  getShopByPhone,
  createShopWithPhone,
  createOtpCode,
  getLastOtpRequest,
  getActiveOtpCode,
  countRecentOtpRequests,
  incrementOtpAttempts,
  consumeOtpCode,
  cleanupOldOtpCodes,
  toPublicShop
};
