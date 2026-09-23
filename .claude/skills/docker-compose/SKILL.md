---
name: docker-compose
description: Write and operate docker-compose files for this project — local dev stack, production stack with Caddy reverse proxy + automatic HTTPS, named volumes for the SQLite database, env handling, and compose troubleshooting. Use when the user says "compose", "docker compose up", "add a reverse proxy", "run it with nginx/caddy/traefik", "multiple containers", "dev vs prod compose", or "the services can't reach each other".
---

# Docker Compose for Beporsid

Depends on the image defined by the `docker` skill (read it first if no `Dockerfile`
exists yet). Compose adds: env management, a persistent volume for `/data`,
restart policy, and an HTTPS reverse proxy in front of the Node app.

## Architecture

```
internet ──443──▶ caddy (TLS, HTTP→HTTPS) ──3000──▶ app (node server.js) ──▶ /data volume (SQLite)
                                                    └──▶ api.gapgpt.app (outbound)
```

Only `caddy` publishes ports. `app` stays on the internal network. The widget is
loaded cross-origin from customers' shops (`/widget.js`, CORS is open), so the
public URL must be stable and HTTPS.

## Files to create

### `docker-compose.yml` (base — shared by dev and prod)

```yaml
services:
  app:
    build: .
    image: beporsid:latest
    restart: unless-stopped
    env_file: .env
    environment:
      NODE_ENV: production
      PORT: 3000
      DB_PATH: /data/chatbot.db
    volumes:
      - beporsid_data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  beporsid_data:
```

### `docker-compose.override.yml` (dev — picked up automatically by `docker compose up`)

```yaml
services:
  app:
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: development
    volumes:
      - ./server.js:/app/server.js:ro
      - ./db.js:/app/db.js:ro
      - ./widget.js:/app/widget.js:ro
      - ./dashboard.html:/app/dashboard.html:ro
      - ./index.html:/app/index.html:ro
      - ./public:/app/public:ro
      - ./shop-data.json:/app/shop-data.json:ro
    command: ["node", "--watch", "server.js"]
```

Individual file mounts (not the whole repo) so the host's Windows `node_modules`
never shadows the Linux one inside the image.

### `docker-compose.prod.yml` (prod — adds Caddy)

```yaml
services:
  app:
    expose:
      - "3000"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      DOMAIN: ${DOMAIN:?set DOMAIN in .env}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      app:
        condition: service_healthy

volumes:
  caddy_data:
  caddy_config:
```

### `Caddyfile`

```
{$DOMAIN} {
    encode zstd gzip
    reverse_proxy app:3000
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        -Server
    }
}
```

Caddy obtains and renews Let's Encrypt certs automatically; DNS for `DOMAIN` must
point at the server before first `up`. Add `DOMAIN=chat.example.com` to `.env`.

If the user prefers nginx or traefik, keep the same topology (proxy publishes
80/443, app only `expose`) and swap the service.

## Commands

| Task | Command |
|---|---|
| Dev up (hot reload) | `docker compose up --build` |
| Prod up | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` |
| Prod logs | `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f app` |
| Redeploy after code change | same prod `up -d --build`; compose recreates only `app` |
| Stop, keep data | `docker compose down` |
| Stop AND delete DB | `docker compose down -v` — **ask the user first** |
| Backup DB | `docker compose exec app sh -c 'sqlite3 /data/chatbot.db ".backup /data/backup.db"'` — or use the tar approach in the `docker` skill (sqlite3 CLI is not in the slim image) |
| Validate config | `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` |

Suggest adding to `package.json` scripts if the user wants shortcuts:
`"compose:dev": "docker compose up --build"`,
`"compose:prod": "docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build"`.

## Rules

- `.env` is loaded by compose via `env_file`; it is **not** copied into the image.
  Never commit it. Keep `.env.example` current when adding variables.
- Use `${VAR:?message}` for variables that must exist (`DOMAIN`, and consider
  `GAPGPT_API_KEY`, `JWT_SECRET`, `ENCRYPTION_SECRET`).
- One writer for SQLite: never scale `app` above 1 replica
  (`deploy.replicas` / `--scale`) while the DB is SQLite.
- Before `down -v`, `rm -v`, or changing `ENCRYPTION_SECRET`, confirm with the user
  — both destroy or invalidate customer data.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Caddy: `connection refused` to `app:3000` | `app` not healthy yet or crashed (check env); `depends_on ... service_healthy` handles ordering, so look at `logs app`. |
| Caddy cert errors | Port 80/443 not reachable from the internet, or DNS not pointing at host yet. Use `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` in the global block while testing to avoid rate limits. |
| Dev override applied in prod | You ran `docker compose up` without `-f` flags; the override file is auto-loaded. Always pass both `-f` files in prod. |
| `env file .env not found` | Copy `.env.example` → `.env` on the server. |
| Changes not reflected in dev | File is not in the override mount list; add it. |
| Widget blocked on customer site | Site loads `http://` script from an `https://` page, or `DOMAIN` mismatch — the embed snippet must use the HTTPS domain. |

For building/tagging the image and shipping it to a server or registry, use the
`production-release` skill.
