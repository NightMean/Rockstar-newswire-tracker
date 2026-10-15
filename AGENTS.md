# AGENTS.md

## Project

A containerized Node.js service that monitors Rockstar Games Newswire announcements, parses articles, hosts a local RSS feed, and sends Discord webhook notifications.


## Commands

```bash
npm install            # install deps
npm start              # run tracker (loads config/config.yaml, starts RSS server + polling)
npm test               # run unit tests (node:test, no extra deps; test/ dir)
npm run lint           # ESLint (flat config, eslint.config.js)
docker-compose up -d   # run containerized (recommended; mounts ./config as volume)
```

Tests use Node's built-in `node --test` runner. Pure modules (`src/utils.js`, `mapArticleSummary`) are tested directly; the poller's decision logic (seen-filtering, delivery ordering, hash refresh, tick guards) is tested via fake store/notifier/api collaborators — pass `autoStart: false` in options when constructing a poller in tests. Behavioral changes still need a live smoke test too (see "Live smoke testing").

## Architecture

Node.js service that scrapes the Rockstar Games Newswire and fans it out to Discord webhooks and/or a self-hosted RSS feed. Single npm package, one file per responsibility:

- **`index.js`** — composition root only. Loads `config/config.yaml` (js-yaml), applies `DISCORD_WEBHOOK_URL` env override, validates config (webhook URL shape, refreshInterval > 0, dateFormat, checkLimit bounds), creates `feeds/` at startup, wires one `NewswirePoller` per genre, serves feeds over HTTP (paths sanitized via `sanitizeFeedFilename`).
- **`src/poller.js`** — `NewswirePoller` class (one per genre): refresh loop, tick overlap guard + error boundary, unseen-article detection, delivery ordering. Store/notifier/api are injected via constructor; the rotating hash is instance state.
- **`src/newswireApi.js`** — genre registry (`genres` map = canonical list), GraphQL client (`NewswireApi.fetchList/fetchArticle`), Puppeteer token fetcher with bot-wall evasion and bounded retries (`acquireHashWithRetries`), pure `mapArticleSummary` mapper.
- **`src/articleStore.js`** — seen-articles DB: load once at startup (`whenLoaded`), `has`, atomic `markSeen`.
- **`src/discordNotifier.js`** — webhook delivery with 3× retry; returns boolean success.
- **`src/feedGenerator.js`** — merged/separate RSS file generation from per-genre item collections.
- **`src/utils.js`** — dependency-free pure helpers (`escapeHtml`, `formatDate`, `parseContent`, `sanitizeFeedFilename`, `isValidDiscordWebhookUrl`, `DEFAULT_DISCORD_AVATAR_URL`).
- **`src/logger.js`** — minimal leveled logger (`LOG_LEVEL` env, default info); all logging goes through it.

Dependency direction is strictly downward: index → poller → api/store/notifier; everything may use utils/logger; nothing imports index.js.

### Data flow
1. Each `newswire` instance's `main()` awaits the shared article DB load, then awaits `getHashToken()`.
2. Polling loop (`setInterval`, `refreshInterval` ms): calls `updateRSS()` → fires `onRSSUpdate(items)` callback back into `index.js`, and `getNewArticles()` → `sendArticle()` per new article.
3. `index.js` accumulates each genre's items in `allArticles[genre]` and rewrites feed files on every `onRSSUpdate`.

### Rockstar API access (the fragile part)
- The Newswire is served by a persisted-query GraphQL endpoint at `https://graph.rockstargames.com?`. Requests need a `sha256Hash` (`newsHash`) that Rockstar rotates.
- **Bot wall (since ~mid-2026):** the Newswire serves an empty app shell to CDP-automated Chrome — no `NewswireList` request is ever issued, headless or headful. The fix in `fetchHashToken()` hides `navigator.webdriver` via `page.evaluateOnNewDocument`. Verified sufficient; no stealth plugin needed.
- `getHashToken()` launches **headless Puppeteer**, loads the Newswire page, intercepts the `NewswireList` request, and extracts the hash from its `extensions` query param, with bounded retries and a system-Chrome fallback launch.
- The token fetch is a **singleton promise** (`tokenPromise`) — all genre instances share one browser launch. On `PersistedQueryNotFound`, code re-fetches the hash and retries.
- `getArticle()` uses a **separate hardcoded** `sha256Hash` (`NewswirePost` operation) for full article bodies — this one is a constant in source, distinct from the rotating list hash.

### Live smoke testing
To verify changes end-to-end without posting to Discord: temporarily set `enableDiscord: false` in config.yaml, run with `PORT=<free port>` (3000 may be occupied by a running instance), wait ~30s for token fetch + first poll, check `/feed.xml`, then restore config.yaml. Unit tests do NOT exercise the runtime wiring (they import src/utils.js directly) — an import bug like the missing parseContent re-export only surfaces on a real run.

### Genre registry
`genres` map at the top of `src/newswireApi.js` maps genre name → Rockstar `tagId` (`latest` = null). This is the canonical list. `config/config.yaml` `genres:` list must use these exact keys. When adding a genre, update the map, the `config.yaml` commented list, and the README genre list together.

### RSS
- Merged mode (`mergeFeeds: true`, default): single `feeds/feed.xml`, all genres sorted by date desc. Served at `/`, `/rss`, `/feed.xml`.
- Separate mode: `feeds/feed-<genre>.xml` (underscores → hyphens in URL). `/` serves an HTML index.
- Feed HTML content is built in `parseContent()`, a recursive traversal of Rockstar's Tina CMS content tree (`post.tina.payload.content`) that handles `EventInfo`/`FeaturedEventInfo`, `Grid`, `HTMLElement`, `Embed` (rewrites iframe src/dimensions) node templates.
- The `feed` npm package is loaded via **dynamic `import('feed')`** (ESM-only) inside async functions — do not convert to a top-level `require`.

### Persistence
Seen-article IDs are stored in `config/newswire_articles.json` (`{ articleId: url }`) via `addArticle()` (atomic temp-file + rename). Loaded once at startup into module-scoped `articles`. This file and `feeds/` are gitignored (runtime data). Articles are persisted as seen **only after** their Discord delivery succeeds (sendArticle retries 3×; failed articles stay unseen and retry next refresh).

### Concurrency
Each genre's interval tick is guarded by `isRefreshing` so slow ticks never overlap, and wrapped in try/catch/finally — no rejection can escape as an unhandled rejection. All HTTP requests attach `timeout` handlers that destroy the socket — no promise can hang forever. Token acquisition retries up to 3× with backoff; a genre whose startup ultimately fails is logged loudly and skipped without killing other genres.

### CI
`.github/workflows/ci.yml` runs `npm ci` + `npm test` on push/PR to master (Tier-1 only; `PUPPETEER_SKIP_DOWNLOAD=true` since tests never launch a browser). Container has a `HEALTHCHECK` hitting `/healthz`.

## Gotchas
- `newsHash` and `articles` are **module-scoped globals** shared across all genre instances — intentional (single token, single DB). Don't make them per-instance.
- Config `refreshInterval` and `checkLimit` are in `config.yaml` in minutes / count; `index.js` converts minutes → ms before passing to the class.
- Docker sets `PUPPETEER_SKIP_DOWNLOAD=true` and `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable` — the container uses system Chrome, not the bundled Chromium, and runs as the `node` user.
- `parseContent()` intentionally does NOT escape `HTMLElement` node content: those carry ready-made embed markup (YouTube iframes). Text we interpolate ourselves is escaped via `escapeHtml`.

## Repository policy

The repository is permanently private. The owner authorized tracking this AGENTS.md.
The owner authorizes automatic pushes of verified changes to origin/main while GitHub confirms this repository is private. Check visibility before pushing; do not automatically push if it is public or visibility cannot be confirmed.
