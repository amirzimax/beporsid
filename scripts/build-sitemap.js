// ساخت خودکار sitemap.xml سایت اصلی (beporsid.com) از روی خود صفحه‌ها.
//   node scripts/build-sitemap.js
// اسکریپت استقرار (.claude/deploy/deploy.js) قبل از هر انتشار همین را اجرا می‌کند، پس هر مقاله یا
// صفحه‌ی فرود تازه خودکار وارد نقشه‌ی سایت می‌شود.
//
// صفحه = هر index.html در ریشه‌ی پروژه یا پوشه‌های آن که canonical آن به beporsid.com اشاره
// می‌کند و noindex ندارد. تاریخ آخرین تغییر از article:modified_time صفحه، وگرنه از آخرین
// کامیت گیت، وگرنه از زمان تغییر فایل خوانده می‌شود.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://beporsid.com/';
// پوشه‌هایی که صفحه‌ی سایت اصلی نیستند
const SKIP = new Set(['node_modules', 'public', 'scripts', 'brand', 'backups', '.git', '.claude', '.vscode']);

function findPages(dir = ROOT, depth = 0) {
  let out = [];
  const index = path.join(dir, 'index.html');
  if (fs.existsSync(index)) out.push(index);
  if (depth >= 3) return out;
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out = out.concat(findPages(full, depth + 1));
  }
  return out;
}

function lastmod(file, html) {
  const m = html.match(/article:modified_time"\s+content="(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  try {
    // فایلی که تغییر کامیت‌نشده دارد، تاریخ آخرین کامیتش قدیمی است
    const dirty = execFileSync('git', ['status', '--porcelain', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim();
    const d = dirty ? '' : execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (d) return d;
  } catch (e) { /* بدون گیت */ }
  return fs.statSync(file).mtime.toISOString().slice(0, 10);
}

function sitePages() {
  const pages = [];
  for (const file of findPages()) {
    const html = fs.readFileSync(file, 'utf8');
    const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
    if (!canonical || !canonical.startsWith(SITE)) continue;
    if (/<meta name="robots" content="[^"]*noindex/i.test(html)) continue;
    const rel = path.relative(ROOT, path.dirname(file)).split(path.sep).join('/');
    const depth = rel ? rel.split('/').length : 0;
    // ریشه ۱، صفحه‌های فرود و فهرست بلاگ (یک سطح) ۰.۸ تا ۰.۹، مقاله‌ها ۰.۷
    const priority = !rel ? '1.0' : rel === 'blog' ? '0.8' : depth === 1 ? '0.9' : '0.7';
    const changefreq = !rel || rel === 'blog' ? 'weekly' : 'monthly';
    pages.push({ loc: canonical, dir: rel, lastmod: lastmod(file, html), priority, changefreq });
  }
  return pages.sort((a, b) => b.priority - a.priority || a.loc.localeCompare(b.loc));
}

function buildSitemap() {
  const pages = sitePages();
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    pages.map(p => `  <url>\n    <loc>${p.loc}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`).join('\n') +
    '\n</urlset>\n';
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml);
  return pages;
}

module.exports = { sitePages, buildSitemap };

if (require.main === module) {
  const pages = buildSitemap();
  console.log(`sitemap.xml: ${pages.length} صفحه`);
  for (const p of pages) console.log(' ', p.priority, p.lastmod, p.loc);
}
