# @okie/server

Local paste-a-repo scan process used by `pnpm dev` (Vite proxies `/api` and `/scan` here).

**This is not a deployable public API.** Hosted scan (`POST /api/scans`) requires a GitHub OAuth session (or a loopback test-double). Job list/status and `/scan/*` objects are still unauthenticated so public `/r/<owner>/<repo>` views have no login wall. If a gateway or Anthropic key is set in the process, enrichment is attempted for whoever can POST a scan.

## Published defaults

- Listen bind is loopback (`127.0.0.1:4180`). Override with `OKIE_SERVER_HOST` / `OKIE_SERVER_PORT` only when LAN access is intentional.
- `GET /healthz` (and `GET /`) reports `{ service, ok, public: false, bind, enrich }`. It does not return `scanRoot`, filesystem paths, LLM keys, OAuth secrets, or tokens.
- Hosted scan requires GitHub identity. `GET /api/auth/github` starts OAuth (`state` CSRF cookie; `redirect_uri` from `OKIE_PUBLIC_ORIGIN`, never the Host header). Callback tokens stay in the in-memory session — never in URLs, logs, or `/healthz`. GitHub reads use HTTPS Bearer for OAuth, or HTTPS-only for the loopback test-double. Never operator `gh`, never `GITHUB_TOKEN` / `GH_TOKEN`.
- Loopback without OAuth client credentials enables `GET /api/auth/github/test-login` so local QA can sign in without live GitHub App secrets. That path is off when the bind is not loopback.
- Public atlas *views* are the web app's `/r/<owner>/<repo>` URLs (CLA-30). They have no login wall. `/r/THISS/okie` is the dogfood share URL (published scan, bundled self-scan, or the golden demo). Docs sites embed those views via the web origin's `GET /oembed?url=` (JSON iframe payload); crawlers read Open Graph tags from the same share URL. This scan process does not serve oEmbed or OG images.

Do not expose this process on a public interface, a reverse proxy, or a hosted deployment until OAuth client credentials are set in env (gitignored) and you accept the remaining unauthenticated surfaces (`GET /scan/*`, job list).

GitHub OAuth env (never commit, never log):

| Setting | Env | Notes |
|---|---|---|
| Client ID | `OKIE_GITHUB_CLIENT_ID` | GitHub App or OAuth App client id |
| Client secret | `OKIE_GITHUB_CLIENT_SECRET` | Env only |
| Public origin | `OKIE_PUBLIC_ORIGIN` | Callback + cookie origin (default `http://localhost:4173`) |
| App slug | `OKIE_GITHUB_APP_SLUG` | Optional install redirect (`/api/auth/github/install`) |
| Test double | `OKIE_GITHUB_TEST_DOUBLE` | `1` force on / `0` force off; default on for loopback when OAuth is unset |

## LLM gateway (explicit opt-in)

**Nothing is sent to an LLM unless you opt in (CLA-606).** By default the server never sends source excerpts to any provider, even when provider keys are exported in your shell. To turn LLM enrichment and Ask on, a local developer sets **both**:

1. a provider: `--llm-provider <name>` on the server command line (it beats the env var), or `OKIE_LLM_PROVIDER=<name>`; and
2. the key: `OKIE_LLM_API_KEY`.

```sh
OKIE_LLM_API_KEY=… node apps/server/dist/main.js --llm-provider openrouter
pnpm --filter @okie/server dev -- --llm-provider openrouter --dotenv   # key read from the repo-root .env
```

| Provider | Sends to | Base URL | Used for |
|---|---|---|---|
| `openrouter` | openrouter.ai | always `https://openrouter.ai/api/v1`; a different `OKIE_LLM_BASE_URL` / `okie.local.json` `baseUrl` stops the server (use `openai-compatible`) | scan + operator enrichment, Ask |
| `openai-compatible` | your gateway | **required**: `OKIE_LLM_BASE_URL` or `okie.local.json` `baseUrl` (startup fails without one) | scan + operator enrichment, Ask |
| `anthropic` | api.anthropic.com | `OKIE_LLM_BASE_URL` / `baseUrl`, else `https://api.anthropic.com` | scan enrichment only (no Ask, no operator enrichment) |
| `off` | nothing | — | — |

Any other value stops the server at startup.

| Setting | Env | Default |
|---|---|---|
| Provider | `--llm-provider` or `OKIE_LLM_PROVIDER` | unset: off |
| API key | `OKIE_LLM_API_KEY` (the only key that is read) | unset: off |
| Base URL | `OKIE_LLM_BASE_URL` | per provider, above |
| Model id | `OKIE_LLM_MODEL` | `xiaomi/mimo-v2.6-pro` |

`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_LOG`, `ANTHROPIC_PROFILE`, `OPENAI_BASE_URL`, `OPENROUTER_MODEL` and `OPENAI_MODEL` are **ignored**. If any is set, the server prints one `LLM notice: ignoring …` line naming the variables (never their values) and how to opt in. A provider without `OKIE_LLM_API_KEY`, or the key without a provider, stays off and the startup line says why. The Anthropic SDK is given the key and base URL explicitly, and the client is built with every `ANTHROPIC_*` variable hidden and SDK logging off, so it never picks up `ANTHROPIC_*` settings (keys, base URL, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_LOG`) or an `ant auth login` profile (profile auth is gone). Startup lines and job labels name the host packets actually go to (`api.anthropic.com`, or your base URL's host).

Every start prints one state line, in both server modes, with the host only (never a URL or key):

```
[okie-server] LLM enrichment: off (no --llm-provider / OKIE_LLM_PROVIDER)
[okie-server] LLM enrichment: off (--llm-provider openrouter is chosen but OKIE_LLM_API_KEY is unset)
[okie-server] LLM enrichment: on → openrouter.ai (model xiaomi/mimo-v2.6-pro); scan enrichment, operator enrichment and Ask
```

**`.env` is not loaded by default.** The server reads the repo-root `.env` only with `--dotenv` (or `OKIE_DOTENV=1`), without overriding variables already in the environment. `askEvalLive.ts`, `scripts/cross-repo-eval.mjs --live` and `scripts/measure-incremental.mjs --live` follow the same rule (and take `--llm-provider` too). If a `.env` exists and was not loaded, the server says so at startup. This applies to **every** key you keep there: `JEV_API` (block planner / claim checks) and the GitHub OAuth settings also need `--dotenv` now, or must be exported. `scripts/publish-atlas.mjs` still loads `.env` unconditionally (it holds publish credentials, not LLM keys). Do not commit a key. There is no `.env.example` (CLA-16).

The deployed container (`apps/edge/src/container.ts` `containerEnvVars`) sets `OKIE_LLM_PROVIDER=openrouter` in code and forwards only `OKIE_LLM_API_KEY` / `OKIE_LLM_MODEL`, so staging and production need no secret change.

Ask Atlas (`GET`/`POST /api/ask`) uses the same gateway and the same GitHub session as hosted scan. `GET /api/ask` returns `{ connected: true|false }` with no key, base URL, or model id — it does not require sign-in. `POST /api/ask` and `GET /api/ask/thread` require a GitHub session (or loopback `test-login`): **401 without one**, and the gateway is not called. Unsigned visitors keep the deterministic atlas. With a session and a key, `POST /api/ask` answers one question from the client-supplied packets and accepted summaries for the selected (or isolated) scopes — never a silent whole-repo dump — and appends that Q&A to an in-process thread keyed by GitHub user + `owner/repo` + `commitSha`. Citations are filtered to those scope ids. The operator gateway key stays in the process env; it is never stored on the user, never written into a thread, never logged, and never returned on `/healthz`. The `anthropic` provider does not connect Ask; an OpenAI-compatible gateway (`openrouter` / `openai-compatible`) is the path.

Non-secret overlay (base URL / model id only) can live in `okie.local.json` at the repo root, or in a JSON file pointed at by `OKIE_LLM_CONFIG`:

```json
{ "baseUrl": "https://openrouter.ai/api/v1", "modelId": "xiaomi/mimo-v2.6-pro" }
```

An `apiKey` field in that file is ignored. With a gateway key, each enrichment scope POSTs the bounded, redacted packet to `{baseUrl}/chat/completions` (OpenAI-compatible). Packet excerpts reuse the existing GitHub token scrub (`gho_` / `ghp_` / `github_pat_`); the operator key is stripped from the outbound JSON body (it stays on `Authorization`). Gateway error strings are scrubbed the same way before `job.error` and logs. The reply's `choices[0].message.content` is parsed into the container-id-keyed document the merge gate already consumes. Live prompts ask for a short summary of **that packet's scope only**; hallucinated ids and out-of-scope entities still reject the scope. With `--llm-provider anthropic`, packets go to the Anthropic SDK instead, with `OKIE_LLM_API_KEY`. Packets are built and sent only while the ephemeral checkout exists.

No opt-in or no key: enrichment is skipped and the deterministic atlas still publishes. Scan enrichment is also skipped when `OKIE_SCAN_ENRICH=0`. `OKIE_SCAN_ENRICH=1` never enables egress on its own: it only applies once a provider is chosen and `OKIE_LLM_API_KEY` is set. OpenRouter is optional — paste-a-repo still maps the repo without a gateway key.

The scan job (`GET /api/scans/:id`) and the paste-a-repo landing report whether enrichment **ran** (provider host + model id), was **skipped (no key)**, or **failed**. They never include the API key or a gateway URL that carries a token (`user:pass@host`, `?api_key=`). `GET /healthz` stays `{ service, ok, public, bind, enrich }` — no keys, no model id, no `scanRoot`.

The enrichment pass uses the configured model id as an opaque string (no hardcoded model table beyond the default above). Change the env var or `okie.local.json` — no code change. A present-but-empty model (`OKIE_LLM_MODEL=""`, or `"modelId": ""` in local config) or a provider-rejected id fails **the enrichment pass only**: the job still completes with the deterministic atlas and an enrichment failed note.

Enrichment is bounded so a paste-a-repo job cannot run unbounded:

| Setting | Env | Default |
|---|---|---|
| Per-request timeout | `OKIE_LLM_TIMEOUT_MS` | `60000` (60s) |
| Max scopes per scan | `OKIE_LLM_MAX_SCOPES` | `16` |
| Max tokens per scan | `OKIE_LLM_MAX_TOKENS` | `200000` (from gateway `usage` when present) |
| Max code entities per packet | (constant `MAX_ENRICHABLE_CODE_ENTITIES`) | `500` (covers THISS/okie `@okie/web` chunk 1 at 474; oversized *packets* skip, remainders can still run) |
| Max dollars per scan | `OKIE_LLM_MAX_DOLLARS` | `1` (enforced only if the gateway returns cost) |
| Global max tokens | `OKIE_LLM_GLOBAL_MAX_TOKENS` | unset (no process-wide token ceiling) |
| Global max dollars | `OKIE_LLM_GLOBAL_MAX_DOLLARS` | unset (no process-wide dollar ceiling) |

A per-scope timeout omits that scope and continues. Hitting a scan-level cap skips remaining scopes; the deterministic atlas stays live. HTTP 429 or 5xx skips remaining scopes, records **enrichment failed**, and leaves the atlas up. Invalid env values keep the defaults. These numbers are not on `/healthz`.

The system packet is scheduled **before** container packets so a 200k token cap cannot starve the system-scope summary after three container proposals. A packet over the 500-code cap is skipped on its own; remainder chunks for the same container are still asked when they fit. The 2000 hang-guard is a different axis and is not this table.

The global token/$ cap is a **process-wide** ceiling across GitHub users (CLA-38), not a per-account quota. The existing 5 scans / 10 minutes per-user (plus IP) submit limiter stays. When the process is already at the global cap, enrichment is skipped (`enrichment.state: skipped`, note `global enrichment budget reached`) and the deterministic atlas still publishes. Unset / invalid global env values mean no global ceiling — only the per-scan caps apply. Dollar totals are enforced only when the gateway reports cost. Spend totals, keys, and gateway URLs never appear on `/healthz`, in job JSON, or in logs.

## public-readonly mode (container)

`OKIE_SERVER_MODE=public-readonly` is the stateless container behind the sourcefor.dev edge Worker (CLA-266). Scans stay on the operator's machine; `pnpm publish:atlas` uploads published versions to R2 and the container mirrors them. The browse-only launch does not deploy it (the Worker serves everything from R2); it stays for signed-in Ask later.

- Routes: `GET/POST /api/ask`, `GET /api/ask/thread`, `POST /api/block-plan`, `GET /scan/*` (neighborhood, excerpt, source, published objects), `GET /healthz`. Everything else — OAuth/session, `/api/operator/*`, cron, webhook, `/api/scans*`, `/` — is 404. No operator runner, enrichment or incremental automation runs.
- Ask and block plans are anonymous: the per-IP windows, the Ask retrieval worker admission, the 48 KB Ask body cap and the planner ledger / kill switch still apply; Ask threads are not persisted (`POST /api/ask` answers without `thread`; `GET /api/ask/thread` returns an empty thread). `POST /api/ask` sets `x-okie-ask-cost-usd` for the edge's dollar ledger: the gateway-reported cost after a gateway call (absent when unreported), and `0` for every answer that made no gateway call (per-IP refusals, 400s, empty question, `connected: false`, no scope) so the edge releases its estimate. `x-okie-ask-tokens` is set when known.
- The scan root is scratch disk. `publishedMirror.ts` materialises published versions from `<OKIE_PUBLISHED_STORE_URL>/<key>` (layout: `publishedStoreLayout.ts`) into a minimal operator-v1 store — at boot, every `OKIE_PUBLISHED_REFRESH_MS`, and on demand when a request names a slug or `?version=` it lacks. It downloads only `snapshot.json`, `view.json` and the private raw `operator-explanations.json` (the Worker serves every other public file from R2). Files are checked against the manifest's sha256/bytes before install; a miss is a closed 404. A slug whose sync failed is retried on every refresh (the index digest only advances when every slug synced), and a request naming a version or commit that is not current re-reads `latest.json` (at most once per 10 s per slug, deduped).
- Image: `apps/server/Dockerfile` (build context = repo root, root `.dockerignore` is an allowlist): `docker buildx build --platform linux/amd64 -f apps/server/Dockerfile -t okie-atlas-api .`

| Env | Purpose |
|---|---|
| `OKIE_SERVER_MODE` | `default` (unset) or `public-readonly`; anything else fails at boot |
| `OKIE_SERVER_HOST` / `OKIE_SERVER_PORT` | Bind (loopback by default; the image sets `0.0.0.0:8080`) |
| `OKIE_TRUSTED_PROXY` | `cloudflare`: the client IP is `CF-Connecting-IP` when it is a valid IP literal, else `x-okie-client-ip` (set by the Worker, which deletes any client copy), else the socket address; the Ask loopback exemption no longer applies. Unset by default; `X-Forwarded-For` is never trusted |
| `OKIE_PUBLISHED_STORE_URL` | Origin serving published-store keys (the container: `http://atlas-store.internal`) |
| `OKIE_PUBLISHED_REFRESH_MS` | Mirror refresh interval (default 60000; 0 disables the timer) |
| `OKIE_SCAN_ROOT` | Mirror scratch dir (default: a new temp dir) |
| `OKIE_ASK_WORKER_MAX_HEAP_MB` | Ask worker heap cap (default 1536; the image sets 512) |
| `OKIE_ASK_MAX_WARM_INDEXES` | Warm Ask indexes (default 4; the image sets 2) |
| `OKIE_NEIGHBORHOOD_CACHE_ENTRIES` | Parsed snapshot/view LRU for neighborhood/excerpt packets (default 4; the image sets 2) |

Publishing (operator machine; build `@okie/server` first):

```sh
pnpm publish:atlas --repo owner/name --env staging|production|local [--scan-root <dir>] [--dry-run [--out <dir>]] [--persist-to <dir>] [--license-override <SPDX id or expression>] [--yes]
pnpm publish:atlas --repo owner/name --env <env> --set-latest <versionId> [--yes]     # rollback
```

- Reads the operator store read-only. Uploads the version's public files, the private raw sidecar, the `neighborhood` pack (default view + every entity) and `excerpt` pack, and `packs/source-paths.json`, then `manifest.json`, `latest.json` and the merged `index.json`.
- Packs: every entry is its own gzip member of the exact route body (`index.encoding: "gzip"`, `[offset, length]` of the compressed member). One object per pack; a pack over 300 MB fails the publish (wrangler's per-object limit is 315 MB).
- Licence: `GET api.github.com/repos/<o>/<r>/license?ref=<commit>`, unauthenticated. No licence, `NOASSERTION` or a failed lookup refuses the publish unless `--license-override <SPDX id or expression>` (no lookup, no URL; e.g. `"MIT AND CC-BY-4.0"`, `"Unlicense OR MIT"`).
- `--set-latest <versionId>` checks that version's manifest exists in the target store, then rewrites `latest.json` and `index.json` from it; nothing else is uploaded.
- Remote envs use the `wrangler login` OAuth session and take the account from `apps/edge/wrangler.jsonc` `account_id` (`CLOUDFLARE_ACCOUNT_ID` overrides it). `CLOUDFLARE_API_TOKEN` (and `CF_API_TOKEN` / API keys) are stripped from the wrangler child, with a one-line note. Production needs `--yes`.
- A `wrangler r2 object get` counts as "missing" only on wrangler's exact `The specified key does not exist.` error; anything else fails the publish before any upload.
