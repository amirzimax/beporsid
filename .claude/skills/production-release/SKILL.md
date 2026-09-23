---
name: production-release
description: Run a production release of the Beporsid chatbot server — pre-flight checks, security hardening review, version bump + tag, Docker image build/push, deploy via compose on the server, smoke test, backup and rollback. Use when the user says "release", "deploy to production", "ship it", "go live", "bump version", "tag a release", "rollback", "hotfix", or "production checklist".
---

# Production Release — Beporsid

A release is: **check → harden → version → build image → backup → deploy → smoke test → (rollback if needed)**.
Do the steps in order; stop and report at the first failure. Never skip the backup.

Prerequisites from other skills: a `Dockerfile` (`docker` skill) and compose files
(`docker-compose` skill). If missing, create them first.

## 0. Ask only what you cannot infer

Before the first release, establish and remember (write to `.claude/release.md`
in the repo if the user agrees):
- Server access: `ssh user@host`, deploy path (default `/opt/beporsid`).
- Registry (e.g. `ghcr.io/<owner>/beporsid`, Docker Hub, or none → build on server).
- Public `DOMAIN`.
Subsequent releases reuse these — do not re-ask.

## 1. Pre-flight (local)

- [ ] Working tree is clean and on the release branch (if the project is in git;
      it currently is **not** — offer `git init` + a `.gitignore` that excludes
      `.env`, `node_modules`, `chatbot.db*`).
- [ ] `npm ci` succeeds; `node --check server.js && node --check db.js` pass.
- [ ] Start the app locally with a test `.env` and hit `/health` → 200.
- [ ] `.env.example` lists every `process.env.*` the code reads:
      `grep -o "process.env.[A-Z_]*" server.js db.js | sort -u`.
- [ ] `.dockerignore` excludes `.env`, `node_modules`, `chatbot.db*`.

## 2. Security hardening review (this codebase's known gaps)

Report each item as PASS / FIXED / OPEN. Fix the cheap ones; ask before larger changes.

| Check | Where | Why it matters in prod |
|---|---|---|
| `JWT_SECRET` and `ENCRYPTION_SECRET` are set, long (≥32 random bytes), and **different** | `.env` on server | Both default to `'change-this-secret'` (server.js:38, db.js:55). Default = anyone can forge admin tokens / decrypt Shopfa passwords. |
| App refuses to start in production with default secrets | server.js | Add: `if (process.env.NODE_ENV==='production' && (JWT_SECRET==='change-this-secret' || !process.env.ENCRYPTION_SECRET)) { console.error(...); process.exit(1); }` |
| `GAPGPT_API_KEY` present | `.env` | App exits otherwise. |
| CORS | server.js:23 `app.use(cors())` | `/widget.js` and the chat endpoint must stay open (widget is embedded on customer sites). Dashboard/auth/admin routes should be same-origin — consider a restricted CORS on `/api/auth*` and admin routes. |
| Rate limiting on chat + login | server.js | GapGPT costs money per call; login is brute-forceable. Suggest `express-rate-limit`. |
| `app.set('trust proxy', 1)` | server.js | Behind Caddy, so `req.ip` and rate limits see real client IPs. |
| Body size limit | `express.json({ limit: '100kb' })` | Default 100kb is fine; just make it explicit. |
| Secrets never logged | grep `console.log` for `password`, `token`, `API_KEY` | |
| `public/admin.html` | public/ | Confirm it is protected by an auth check server-side, not only hidden. |
| DB file outside image, on a volume | Dockerfile / compose | Otherwise every redeploy wipes customers. |

Generate secrets with: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

## 3. Version

- Bump `package.json` `version` (semver: patch for fixes, minor for features).
  `npm version patch|minor --no-git-tag-version` if not using git, otherwise
  `npm version patch` which also tags `vX.Y.Z`.
- Append to `CHANGELOG.md` (create if missing): date, version, bullets of user-facing
  changes. Keep it short.
- Image tags: `beporsid:X.Y.Z` **and** `beporsid:latest`. Never deploy only `latest` —
  the exact tag is what rollback needs.

## 4. Build & publish image

Option A — registry (preferred when there is one):
```
docker build -t REGISTRY/beporsid:X.Y.Z -t REGISTRY/beporsid:latest .
docker push REGISTRY/beporsid:X.Y.Z
docker push REGISTRY/beporsid:latest
```
In `docker-compose.yml` on the server, `image: REGISTRY/beporsid:${APP_VERSION:-latest}`
and remove `build:`; set `APP_VERSION=X.Y.Z` in the server `.env`.

Option B — build on server (no registry): sync the source (`git pull` or
`rsync -av --exclude node_modules --exclude .env --exclude 'chatbot.db*' ./ user@host:/opt/beporsid/`)
and let compose build with `--build`.

Windows host note: `better-sqlite3` binaries in the image are built inside Docker
(Linux); the local Windows `node_modules` is irrelevant and must be `.dockerignore`d.

## 5. Backup (mandatory, on the server, before deploy)

```
cd /opt/beporsid
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app   # brief downtime is acceptable for a clean SQLite copy
docker run --rm -v beporsid_beporsid_data:/data -v /opt/beporsid/backups:/backup alpine \
  tar czf /backup/chatbot-$(date +%Y%m%d-%H%M%S)-pre-X.Y.Z.tgz -C /data .
```
(Volume name is `<project>_beporsid_data`; verify with `docker volume ls`.)
Keep at least the last 7 backups. If zero-downtime is required, use the sqlite3
`.backup` command against the live DB instead of stopping the app.

## 6. Deploy

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull   # registry option
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```
`db.js` runs `CREATE TABLE IF NOT EXISTS` + additive `ALTER TABLE` migrations on
boot, so schema upgrades are automatic and forward-only. Any new column must be
added to the `migrations` map in db.js — check this when a release touches the schema.

## 7. Smoke test (from outside the server)

```
curl -fsS https://DOMAIN/health                       # {"status":"ok"}
curl -fsSI https://DOMAIN/widget.js | head -1         # 200, content-type javascript
curl -fsSI https://DOMAIN/dashboard.html | head -1    # 200
curl -sI http://DOMAIN/ | head -1                     # 301/308 → https
```
Then: log in to the dashboard with a test shop, send one chat message through the
widget (`test-widget.html` pointed at the prod domain), confirm a GapGPT reply.
Watch `docker compose logs -f app` for 2–3 minutes for errors.

## 8. Rollback

```
APP_VERSION=<previous tag> docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```
If the schema changed in a way the old code cannot read (rare — migrations are
additive), restore the pre-release backup:
```
docker compose ... stop app
docker run --rm -v beporsid_beporsid_data:/data -v /opt/beporsid/backups:/backup alpine \
  sh -c 'rm -f /data/chatbot.db* && tar xzf /backup/<file>.tgz -C /data'
docker compose ... up -d
```
Always tell the user which data (messages/settings saved since the backup) is lost by a restore.

## 9. Release report

Finish with a short summary: version, image tag/digest, what changed, security items
still OPEN, backup filename, smoke-test results, and the exact rollback command.

## Hotfix path

Same flow, but: patch bump only, skip the changelog detail beyond one line, still
back up, still smoke test. Never `docker cp` a file into a running container as the
"fix" — it disappears on the next `up`.
