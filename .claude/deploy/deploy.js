// Deploy Beporsid to the production server over SSH (key auth: ~/.ssh/id_ed25519).
//   node .claude/deploy/deploy.js          -> sync changed files, npm install if needed, pm2 restart
//   node .claude/deploy/deploy.js --dry    -> only show what would change
const { Client } = require('ssh2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOST = '156.236.31.181';
const REMOTE_APP = '/root/chatbot';        // pm2 "chatbot" -> api.beporsid.com
const REMOTE_STATIC = '/var/www/beporsid';   // nginx static -> beporsid.com
const PM2_NAME = 'chatbot';
const ROOT = path.resolve(__dirname, '..', '..');
const DRY = process.argv.includes('--dry');

// Files that make up the app. DB files, .env and node_modules are never touched.
const FILES = [
  'server.js', 'db.js', 'knowledge.js', 'extract.js', 'products.js', 'scraper.js', 'billing.js', 'safeurl.js', 'telegram.js', 'crm.js', 'alerts.js', 'widget.js', 'prompt.txt', 'index.html', 'dashboard.html',
  'package.json', 'package-lock.json', 'shop-data.json', 'test-widget.html', 'README.md',
  ...fs.readdirSync(path.join(ROOT, 'public')).map(f => 'public/' + f),
  ...fs.readdirSync(path.join(ROOT, 'scripts')).map(f => 'scripts/' + f),
];
// همه‌ی فایل‌های زیر blog/ را هم (تودرتو) به‌صورت خودکار به لیست استاتیک اضافه می‌کنیم
function walk(dir, base = dir) {
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out = out.concat(walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
const blogDir = path.join(ROOT, 'blog');
// فایل‌های استاتیکی که مستقیم روی ریشه‌ی beporsid.com (nginx) سرو می‌شن، نه اپ Node
const STATIC_FILES = [
  'index.html', 'pay.html', 'robots.txt', 'sitemap.xml', 'og.jpg', 'enamad.png',
  // آیکون سایت: گوگل آیکون data: را نمی‌پذیرد و باید فایل واقعی و قابل‌خزش باشد
  'favicon.ico', 'favicon.svg', 'favicon-48.png', 'favicon-96.png', 'favicon-192.png', 'apple-touch-icon.png',
  ...(fs.existsSync(blogDir) ? walk(blogDir).map(f => 'blog/' + f) : [])
];

const md5 = p => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const sh = (c, cmd) => new Promise((res, rej) => c.exec(cmd, (e, s) => {
  if (e) return rej(e);
  let out = '';
  s.on('data', d => out += d).stderr.on('data', d => out += d);
  s.on('close', code => res({ code, out }));
}));
const put = (sftp, src, dst) => new Promise((res, rej) => sftp.fastPut(src, dst, e => e ? rej(e) : res()));

(async () => {
  const c = new Client();
  await new Promise((res, rej) => c.on('ready', res).on('error', rej).connect({
    host: HOST, port: 22, username: 'root',
    privateKey: fs.readFileSync(path.join(os.homedir(), '.ssh', 'id_ed25519')), readyTimeout: 20000,
  }));

  const staticList = STATIC_FILES.map(f => `${REMOTE_STATIC}/${f}`);
  const { out } = await sh(c, `cd ${REMOTE_APP} && md5sum ${FILES.join(' ')} 2>/dev/null; md5sum ${staticList.join(' ')} 2>/dev/null`);
  const remote = {};
  for (const l of out.split('\n')) { const m = l.match(/^([0-9a-f]{32})\s+(.+)$/); if (m) remote[m[2].trim()] = m[1]; }

  const changed = FILES.filter(f => remote[f] !== md5(path.join(ROOT, f)));
  const staticChanged = STATIC_FILES.filter(f => remote[`${REMOTE_STATIC}/${f}`] !== md5(path.join(ROOT, f)));

  console.log(changed.length ? `Changed: ${changed.join(', ')}` : 'App files: nothing changed.');
  console.log(staticChanged.length ? `beporsid.com static: will update ${staticChanged.join(', ')}` : 'beporsid.com static: up to date');
  if (DRY || (!changed.length && !staticChanged.length)) { c.end(); return; }

  const sftp = await new Promise((res, rej) => c.sftp((e, s) => e ? rej(e) : res(s)));
  await sh(c, `mkdir -p ${REMOTE_APP}/scripts ${REMOTE_APP}/public`);
  for (const f of changed) {
    await put(sftp, path.join(ROOT, f), `${REMOTE_APP}/${f}`);
    console.log('  uploaded', f);
  }
  const staticDirs = [...new Set(staticChanged.map(f => path.posix.dirname(f)).filter(d => d !== '.'))];
  if (staticDirs.length) await sh(c, `mkdir -p ${staticDirs.map(d => `${REMOTE_STATIC}/${d}`).join(' ')}`);
  for (const f of staticChanged) {
    await put(sftp, path.join(ROOT, f), `${REMOTE_STATIC}/${f}`);
    console.log('  uploaded', f, '-> beporsid.com');
  }

  const needsInstall = changed.some(f => f === 'package.json' || f === 'package-lock.json');
  const needsRestart = changed.some(f => !f.endsWith('.html') && f !== 'README.md');
  let cmd = `cd ${REMOTE_APP}`;
  if (needsInstall) cmd += ' && npm ci --omit=dev';
  if (needsRestart) cmd += ` && pm2 restart ${PM2_NAME} --update-env && sleep 2 && pm2 ls`;
  cmd += ` && curl -s -o /dev/null -w 'api.beporsid.com -> %{http_code}\\n' https://api.beporsid.com/ && curl -s -o /dev/null -w 'beporsid.com -> %{http_code}\\n' https://beporsid.com/`;
  const r = await sh(c, cmd);
  console.log(r.out.trim());
  c.end();
  process.exitCode = r.code || 0;
})().catch(e => { console.error('Deploy failed:', e.message); process.exit(1); });
