// ==================== بخش مارکتینگ (برنامه‌ی سئو) ====================
// چک‌لیست برنامه‌ی سئو در پنل مدیر. دو نوع کار دارد:
//   owner = admin  → کاری که خود مدیر انجام می‌دهد (ثبت در سرچ کنسول، پیام به سایت‌ها...)؛ فقط تیک «انجام شد»
//   owner = claude → کاری که Claude Code انجام می‌دهد (مقاله، صفحه‌ی فرود، اسکیما...). مدیر «تأیید»
//                    می‌کند و Claude در جلسه‌ی بعدی کارهای تأییدشده را از /api/agent/marketing می‌خواند،
//                    انجام می‌دهد و با لینک نتیجه «انجام شد» می‌زند.
//
// وضعیت‌ها: todo → approved → in_progress → done  (یا skipped)

const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS marketing_tasks (
    id TEXT PRIMARY KEY,
    phase INTEGER NOT NULL,
    week INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT 'admin',
    kind TEXT NOT NULL DEFAULT 'task',
    status TEXT NOT NULL DEFAULT 'todo',
    note TEXT,
    result_url TEXT,
    report TEXT,
    custom INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT,
    done_at TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS marketing_settings (key TEXT PRIMARY KEY, value TEXT);
`);

// برنامه‌ی سئو برای «چت بات هوش مصنوعی فروش». week = هفته‌ی هدف از شروع برنامه.
const PLAN = [
  // فاز ۱: پایه
  ['p1-h1', 1, 1, 'claude', 'page', 'بهینه‌سازی H1 و بخش اول صفحه‌ی اصلی',
    'H1 فعلی («مشتری سوال دارد؟») کلمه‌ی هدف را ندارد. متن جدید طوری نوشته می‌شود که «چت بات هوش مصنوعی فروش» را طبیعی داشته باشد و پیام فعلی حفظ شود. متن پیشنهادی قبل از انتشار در گفتگو برای تأیید نهایی نشان داده می‌شود.'],
  ['p1-schema', 1, 1, 'claude', 'task', 'اسکیمای SoftwareApplication و Organization',
    'اسکیمای نرم‌افزار همراه قیمت پلن‌ها و اسکیمای سازمان به صفحه‌ی اصلی اضافه می‌شود تا گوگل بداند بپرسید چه محصولی است.'],
  ['p1-gsc', 1, 1, 'admin', 'task', 'ثبت سایت در Google Search Console',
    'به search.google.com/search-console بروید، دامنه‌ی beporsid.com را اضافه کنید (روش DNS با رکورد TXT) و در بخش Sitemaps آدرس https://beporsid.com/sitemap.xml را ثبت کنید. بعد از چند روز، عدد نمایش و جایگاه کلمات از همین‌جا خوانده می‌شود.'],
  ['p1-sitemap', 1, 2, 'claude', 'task', 'به‌روزرسانی خودکار نقشه‌ی سایت',
    'هر صفحه یا مقاله‌ی جدید خودکار به sitemap.xml اضافه شود تا چیزی از قلم نیفتد.'],

  // فاز ۲: صفحه‌های فروش و محتوا
  ['a-best', 2, 1, 'claude', 'article', 'مقاله: بهترین چت بات‌های هوش مصنوعی فارسی ۱۴۰۵',
    'مقایسه‌ی منصفانه‌ی بپرسید با ۵ رقیب اصلی (گپیفای، موری، پارس‌چت، AYAI، ایلاچت). پرکلیک‌ترین نوع صفحه برای کلمه‌ی هدف.'],
  ['p2-woo', 2, 2, 'claude', 'page', 'صفحه‌ی فرود: چت بات ووکامرس',
    'صفحه‌ی /woocommerce-chatbot با مراحل اتصال، اسکرین‌شات و سؤال‌های متداول ووکامرس.'],
  ['a-woo-install', 2, 3, 'claude', 'article', 'مقاله: نصب چت بات روی ووکامرس در ۵ دقیقه',
    'راهنمای قدم‌به‌قدم؛ به صفحه‌ی فرود ووکامرس لینک می‌دهد.'],
  ['p2-shopfa', 2, 4, 'claude', 'page', 'صفحه‌ی فرود: چت بات شاپفا',
    'صفحه‌ی /shopfa-chatbot با مراحل اتصال و سؤال‌های متداول شاپفا.'],
  ['a-shopfa', 2, 5, 'claude', 'article', 'مقاله: چت بات برای فروشگاه شاپفا',
    'راه‌اندازی و نکته‌های استفاده در شاپفا.'],
  ['p2-portal', 2, 6, 'claude', 'page', 'صفحه‌ی فرود: چت بات سایت‌های پرتال',
    'صفحه‌ی /portal-chatbot برای فروشگاه‌های ساخته‌شده با پرتال.'],
  ['a-cost', 2, 7, 'claude', 'article', 'مقاله: هزینه‌ی چت بات هوش مصنوعی چقدر است؟',
    'مقایسه‌ی هزینه‌ی چت بات با پشتیبان انسانی و توضیح پلن‌ها.'],
  ['a-7q', 2, 9, 'claude', 'article', 'مقاله: ۷ سؤال پرتکرار مشتری که چت بات جواب می‌دهد',
    'کلمه‌ی هدف: پاسخ خودکار به مشتری.'],
  ['a-human', 2, 11, 'claude', 'article', 'مقاله: چت بات یا پشتیبان انسانی؟',
    'کلمه‌ی هدف: پشتیبانی ۲۴ ساعته سایت.'],

  // فاز ۳: لینک و اعتبار
  ['p3-outreach', 3, 8, 'admin', 'task', 'پیام به سایت‌های «بهترین چت بات‌ها»',
    'به نویسنده‌های مقاله‌های مقایسه‌ای (میهن‌شاپ، آیولرن و مشابه) پیام بدهید و بخواهید بپرسید را به فهرستشان اضافه کنند. اگر خواستید، متن پیام را Claude برایتان می‌نویسد.'],
  ['p3-directories', 3, 9, 'admin', 'task', 'ثبت در فهرست‌های استارتاپی و ابزارهای ایرانی',
    'ثبت بپرسید در دایرکتوری‌های استارتاپ و ابزارهای کسب‌وکار ایرانی، با لینک به سایت.'],
  ['p3-wp-build', 3, 10, 'claude', 'task', 'ساخت افزونه‌ی وردپرس بپرسید',
    'افزونه‌ای که ویجت را با وارد کردن کلید سایت نصب می‌کند. مؤثرترین حرکت این برنامه: هم لینک معتبر، هم کانال جذب مشتری.'],
  ['p3-wp-publish', 3, 11, 'admin', 'task', 'انتشار افزونه در wordpress.org، ژاکت و راست‌چین',
    'انتشار با حساب کاربری خودتان در این مخزن‌ها (Claude فایل‌ها و متن معرفی را آماده می‌کند).'],
  ['p3-guest', 3, 10, 'admin', 'task', 'مقاله‌ی مهمان در بلاگ شاپفا و سایت‌های آموزشی',
    'هماهنگی برای انتشار یک مقاله‌ی آموزشی با لینک به بپرسید. متن مقاله را Claude می‌نویسد.'],
  ['p3-aparat', 3, 12, 'admin', 'task', 'ویدیوی آموزش نصب در آپارات',
    'یک ویدیوی کوتاه نصب ویجت، با لینک سایت در توضیحات.'],

  // فاز ۴: تثبیت
  ['p4-case', 4, 26, 'claude', 'article', 'مطالعه‌ی موردی با عدد واقعی',
    'با اجازه‌ی یک فروشگاه مشتری، نتیجه‌ی واقعی (تعداد سؤال‌ها و پاسخ‌ها) منتشر می‌شود.'],
  ['p4-vs', 4, 28, 'claude', 'page', 'صفحه‌های «بپرسید در برابر رقبا»',
    'صفحه‌های مقایسه‌ی مستقیم با رقبای اصلی.'],
  ['p4-refresh', 4, 36, 'claude', 'article', 'به‌روزرسانی مقاله‌ی «بهترین چت بات‌ها»',
    'به‌روزرسانی فصلی مقایسه تا تازه بماند.']
];

{
  const ins = db.prepare(`INSERT OR IGNORE INTO marketing_tasks (id, phase, week, owner, kind, title, description) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const t of PLAN) ins.run(...t);
  // تاریخ شروع برنامه یک بار ثبت می‌شود؛ موعد هر کار = شروع + (هفته - ۱)
  db.prepare(`INSERT OR IGNORE INTO marketing_settings (key, value) VALUES ('start', date('now'))`).run();
}

const STATUSES = ['todo', 'approved', 'in_progress', 'done', 'skipped'];

function startDate() {
  return db.prepare(`SELECT value FROM marketing_settings WHERE key = 'start'`).get().value;
}

function listTasks() {
  const start = startDate();
  const rows = db.prepare(`SELECT * FROM marketing_tasks ORDER BY week, phase, rowid`).all();
  return {
    start,
    tasks: rows.map(t => Object.assign(t, {
      due: new Date(Date.parse(start + 'T00:00:00Z') + (t.week - 1) * 7 * 86400000).toISOString().slice(0, 10)
    }))
  };
}

function getTask(id) {
  return db.prepare('SELECT * FROM marketing_tasks WHERE id = ?').get(id) || null;
}

// تغییرات مجاز از طرف مدیر در پنل
function adminUpdate(id, { action, note }) {
  const t = getTask(id);
  if (!t) return { error: 'کار پیدا نشد.' };
  const set = (status, extra = '') =>
    db.prepare(`UPDATE marketing_tasks SET status = ?, updated_at = datetime('now') ${extra} WHERE id = ?`).run(status, id);

  if (typeof note === 'string') {
    db.prepare(`UPDATE marketing_tasks SET note = ?, updated_at = datetime('now') WHERE id = ?`).run(note.trim().slice(0, 1000) || null, id);
  }
  if (action === 'approve') {
    if (t.owner !== 'claude' || t.status !== 'todo') return { error: 'فقط کارهای Claude که هنوز شروع نشده‌اند تأییدشدنی‌اند.' };
    set('approved', `, approved_at = datetime('now')`);
  } else if (action === 'unapprove') {
    if (t.status !== 'approved') return { error: 'این کار در صف اجرا نیست.' };
    set('todo', ', approved_at = NULL');
  } else if (action === 'done') {
    if (t.owner !== 'admin') return { error: 'کارهای Claude را خود Claude بعد از انجام، تمام‌شده علامت می‌زند.' };
    set('done', `, done_at = datetime('now')`);
  } else if (action === 'undone') {
    set('todo', ', done_at = NULL, approved_at = NULL');
  } else if (action === 'skip') {
    set('skipped');
  } else if (action && action !== 'note') {
    return { error: 'عملیات نامعتبر.' };
  }
  return { task: getTask(id) };
}

function addCustomTask({ title, description, owner, week }) {
  const id = 'c-' + Date.now().toString(36);
  db.prepare(`INSERT INTO marketing_tasks (id, phase, week, owner, kind, title, description, custom) VALUES (?, 0, ?, ?, 'task', ?, ?, 1)`)
    .run(id, Math.max(1, Math.min(52, Number(week) || 1)), owner === 'claude' ? 'claude' : 'admin',
      String(title).trim().slice(0, 200), String(description || '').trim().slice(0, 2000));
  return getTask(id);
}

// ---------- سمت Claude ----------
function agentQueue() {
  return db.prepare(`SELECT id, title, description, kind, note, status, approved_at FROM marketing_tasks
    WHERE owner = 'claude' AND status IN ('approved', 'in_progress') ORDER BY approved_at`).all();
}

function agentUpdate(id, { status, result_url, report }) {
  const t = getTask(id);
  if (!t || t.owner !== 'claude') return { error: 'کار پیدا نشد.' };
  if (!['in_progress', 'done'].includes(status)) return { error: 'وضعیت نامعتبر.' };
  if (!['approved', 'in_progress'].includes(t.status)) return { error: 'این کار تأیید نشده است.' };
  db.prepare(`UPDATE marketing_tasks SET status = ?, result_url = COALESCE(?, result_url), report = COALESCE(?, report),
      done_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE done_at END, updated_at = datetime('now') WHERE id = ?`)
    .run(status, result_url ? String(result_url).slice(0, 500) : null, report ? String(report).slice(0, 2000) : null, status, id);
  return { task: getTask(id) };
}

module.exports = { STATUSES, listTasks, getTask, adminUpdate, addCustomTask, agentQueue, agentUpdate };
