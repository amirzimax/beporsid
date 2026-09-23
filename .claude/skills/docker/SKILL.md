---
name: docker
description: Build, run, debug and optimize the Docker image for this Node/Express + better-sqlite3 chatbot server. Use when the user says "dockerize", "Dockerfile", "build the image", "run in docker", "container won't start", ".dockerignore", or asks about image size, native module build failures, or SQLite inside a container.
---

# Docker for Beporsid (shop-chatbot-mvp)

## Project facts that shape the image

- Runtime: Node 18+ (uses native `fetch`). Target **Node 20 LTS**.
- Entry: `node server.js` (`npm start`). Listens on `process.env.PORT || 3000`.
- Health check already exists: `GET /health` → `{"status":"ok"}`.
- **Native module:** `better-sqlite3` needs a prebuilt binary or a C++ toolchain
  (`python3 make g++`). Use a multi-stage build so the toolchain never lands in the
  final image.
- **SQLite file:** `db.js` opens `path.join(__dirname, 'chatbot.db')` with WAL mode,
  so it writes `chatbot.db`, `chatbot.db-wal`, `chatbot.db-shm` **next to the code**.
  Never bind-mount a single `chatbot.db` file — WAL needs the whole directory.
  Preferred fix: make the path configurable
  (`process.env.DB_PATH || path.join(__dirname, 'chatbot.db')`) and mount a
  volume at `/data`. If the user declines the code change, mount the volume over
  a directory and `WORKDIR` there instead.
- Startup **exits with code 1** if `GAPGPT_API_KEY` is missing (server.js:45-48).
  A container that dies immediately almost always means this env var is unset.
- Uploads use `multer.memoryStorage()` — no upload directory to persist.
- Serves static files from repo root (`widget.js`, `dashboard.html`, `index.html`,
  `public/`) — these must be copied into the image.

## Workflow

1. Check what exists: `Dockerfile`, `.dockerignore`, `.env.example`. Create what is
   missing using the templates below; edit rather than overwrite what exists.
2. Build: `docker build -t beporsid:local .`
3. Run:
   ```
   docker run --rm -p 3000:3000 --env-file .env -v beporsid_data:/data beporsid:local
   ```
4. Verify: `curl http://localhost:3000/health` and open `http://localhost:3000/dashboard.html`.
5. Report image size (`docker images beporsid:local`) and any warnings.

## Dockerfile template

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/chatbot.db
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
```

Why these choices:
- `bookworm-slim` (glibc) over `alpine`: `better-sqlite3` prebuilt binaries are
  most reliable on glibc; alpine sometimes forces a from-source compile.
- `npm ci --omit=dev` with the lockfile → reproducible installs.
- Run as `node` user, not root.
- No `npm start` in CMD — `node server.js` directly so SIGTERM reaches the process.

## .dockerignore template

```
node_modules
npm-debug.log
.env
.env.*
!.env.example
chatbot.db
chatbot.db-wal
chatbot.db-shm
test.json
test-widget.html
.git
.claude
*.md
```

Never let a real `.env` or the local `chatbot.db` (contains hashed passwords and
encrypted Shopfa credentials) get baked into an image.

## .env.example template (create if missing — README refers to it)

```
PORT=3000
GAPGPT_API_KEY=your_gapgpt_api_key_here
GAPGPT_MODEL=gemini-2.5-flash-lite
JWT_SECRET=change-me-long-random-string
ENCRYPTION_SECRET=change-me-different-long-random-string
DB_PATH=/data/chatbot.db
```

`JWT_SECRET` and `ENCRYPTION_SECRET` both default to `'change-this-secret'` in code.
Changing `ENCRYPTION_SECRET` after data exists makes stored Shopfa passwords
undecryptable — warn the user before rotating it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Container exits immediately, log shows `GAPGPT_API_KEY تنظیم نشده` | Pass `--env-file .env` or `-e GAPGPT_API_KEY=...` |
| `Error: Could not locate the bindings file` / `invalid ELF header` | `node_modules` copied from Windows host. Ensure `.dockerignore` excludes `node_modules`; rebuild with `--no-cache`. |
| `gyp ERR!` during build | Toolchain missing in deps stage; keep `python3 make g++` line. |
| `SQLITE_READONLY` / `unable to open database file` | Volume dir not writable by `node` user → `chown node:node /data`; or `DB_PATH` points to a non-existent dir. |
| Data lost after `docker rm` | Not using a named volume; use `-v beporsid_data:/data`. |
| Windows host: `docker build` slow | Add `.dockerignore`; context includes `chatbot.db-wal` etc. otherwise. |

## Handy commands

```
docker build -t beporsid:local .
docker run --rm -it -p 3000:3000 --env-file .env -v beporsid_data:/data beporsid:local
docker logs -f <container>
docker exec -it <container> sh
docker run --rm -v beporsid_data:/data -v "${PWD}:/backup" alpine tar czf /backup/beporsid-db-backup.tgz -C /data .
```

For multi-service setups (reverse proxy, TLS) use the `docker-compose` skill.
For tagging/releasing images to a registry and deploying, use `production-release`.
