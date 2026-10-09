# Cloudflare deploy runbook (CLA-266)

This runbook covers how to set up, publish, deploy and roll back sourcefor.dev: the edge Worker `sourcefor-atlas`
and published atlases in R2. For the design, measurements and costs, see
[`../roadmap/cloudflare-deployment.md`](../roadmap/cloudflare-deployment.md).

**Signed-in Ask rollout (CLA-316).** Both environments bind a sleeping Node container. Staging enables
Ask for review; production keeps `ASK_ENABLED="0"` until that review is approved. Browsing is always
served by the Worker from R2, plus GitHub raw for `source.json`, without starting the container.

Public agent reads (`/mcp` and `/api/atlas/query`) are enabled in staging and production by
`AGENT_READS_ENABLED="1"`. They read published atlas data only, use the separate 60-request/IP/minute
limiter, and never wake the Ask container. Local development defaults off; override the flag when
testing. After deploying, verify MCP initialization and discovery with a Streamable HTTP client,
then exercise listing, search, entity, relationships and captured evidence using one returned version
pin. A static HTML 404 or empty POST 405 means the request did not reach the current MCP route;
a JSON 404 can mean the feature is disabled. To disable agent access, set this flag to `"0"` and
redeploy, independently of Ask.
Enabled Ask requires a verified GitHub session and admits at most five requests per account per UTC day
through the durable edge ledger before contacting the model. Missing authentication or budget storage
fails closed. Threads stay in browser IndexedDB, partitioned by account and atlas commit; they do not sync.
`BLOCK_PLAN_ENABLED="0"` and container `OKIE_JEV_BLOCK_PLANNER=0` keep the optional Overview ordering off.
A non-waking container-state probe lets the panel explain a cold start; submitting the question wakes it.

Environments:

| Env | Host | Worker | R2 bucket |
|---|---|---|---|
| local (`wrangler dev`) | 127.0.0.1:4196 | — | `sourcefor-atlas-local` (on disk under `apps/edge/.wrangler/state`) |
| staging | staging.sourcefor.dev | `sourcefor-atlas-staging` | `sourcefor-atlas-staging` |
| production | sourcefor.dev (+ www.sourcefor.dev → 301 to the apex) | `sourcefor-atlas-production` | `sourcefor-atlas` |

Credentials: run `pnpm --filter @okie/edge exec wrangler login` once (OAuth). The account id is not a secret and sits in
`apps/edge/wrangler.jsonc` (`account_id`, inherited by every env), so `deploy:<env>` needs nothing from `.env`. Don't
set `CLOUDFLARE_API_TOKEN`: a token in the environment overrides the OAuth session. `deploy:<env>` and
`pnpm publish:atlas` strip it (the publish script also strips `CF_API_TOKEN` / API keys) from the wrangler child and
print a one-line note if they found one.

## 1. First-time setup (once per environment)

1. **Prerequisites:** Node 22+, pnpm 11.10+, wasm-pack and running Docker for the container image. Then run `pnpm install && pnpm build`.
2. **Buckets:**
   `pnpm --filter @okie/edge exec wrangler r2 bucket create sourcefor-atlas-staging` (and `sourcefor-atlas` for
   production). Leave them private: there is no public bucket URL, because the Worker is the only reader.
3. **Rate-limit namespaces:** the `namespace_id` values in `apps/edge/wrangler.jsonc` (`2661` staging, `2662`
   production) are integers you choose, and each must be unique in the account. Change them if they collide.
4. **Secrets:** Ask needs the gateway key below plus the sign-in secrets in the Sign-in section (names
   only; set each with `pnpm --filter @okie/edge exec wrangler secret put <NAME> --env <staging|production>`):

   | Secret | Used by | Required |
   |---|---|---|
   | `OKIE_LLM_API_KEY` | Ask (OpenRouter-compatible gateway). Passed into the container env at start. | yes, for Ask |
   | `JEV_API` | Jev block planner. Passed into the container env. | only with `OKIE_JEV_BLOCK_PLANNER=on` |
   | `TURNSTILE_SECRET_KEY` | Turnstile guard | only with `TURNSTILE_ENABLED=1` |

   Optional non-secret vars (set in `wrangler.jsonc` per env): `ASK_ENABLED` (`"1"` enables signed-in Ask),
   `BLOCK_PLAN_ENABLED` (keep `"0"`), `OKIE_LLM_MODEL`,
   `OKIE_ASK_PER_IP_WINDOW`, the budget caps below, and `TURNSTILE_ENABLED`. Nothing is baked into the image.
5. **Budget caps** (per env `vars`; dormant while `ASK_ENABLED` is `"0"`). A cap of `0` refuses everything;
   an unset or invalid value uses the default. The five-per-account quota is fixed in edge code.

   | Var | Default | Meaning |
   |---|---|---|
   | `ASK_DAILY_MAX_DOLLARS` | 5 | Ask dollar ledger per UTC day (estimate reserved, settled to the gateway-reported cost) |
   | `ASK_ESTIMATED_DOLLARS_PER_REQUEST` | 0.006 | Reservation per Ask; kept when the gateway reports no cost |
   | `ASK_DAILY_MAX_REQUESTS` | 500 | Asks per UTC day |
   | `BLOCK_PLAN_DAILY_MAX_REQUESTS` | 200 | Block plans per UTC day (Jev reserves $0.003 each) |

6. **WAF (recommended):** in the dashboard (Security → WAF → Rate limiting rules), add a rule for
   `http.request.uri.path wildcard "/api/*"`, keyed by IP. The Free plan allows 1 rule with a 10 s period; Pro allows a
   1 min period.
7. **Custom domains:** these are created by the first deploy (`routes[].custom_domain: true`): `staging.sourcefor.dev`,
   and `sourcefor.dev` plus `www.sourcefor.dev` for production. The Worker 301s `www.<host>` to the same path and
   query on `OKIE_PUBLIC_ORIGIN` before anything else. The Worker runs first for every path (`run_worker_first: true`);
   `_headers` still apply to what it passes through `env.ASSETS`. A missing `/assets/*` file (a chunk of the previous
   build, asked for by a page loaded before a deploy) answers 404 `no-store` rather than the SPA shell. The cost is one
   Worker invocation per asset request (a pass-through; negligible on Workers Paid). Staging sets
   `ROBOTS_NOINDEX=1`: `X-Robots-Tag: noindex, nofollow` on every response and a disallow-all `/robots.txt`.
   The Worker also sets the security headers on every response (CLA-318, `apps/web/src/securityHeaders.ts`):
   `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` everywhere, and a
   `Content-Security-Policy` on HTML only. Pages under `/r/...` have no `frame-ancestors`, because oEmbed iframes them
   with `?embed=1` and `*` would still block file:, data:, blob: and sandboxed parents. Every other page has
   `frame-ancestors 'self'`. There is no `X-Frame-Options`. Only when `WEB_ANALYTICS_TOKEN` is set (step 8) does the
   CSP also allow Cloudflare Web Analytics (`static.cloudflareinsights.com` script, `cloudflareinsights.com`
   reports); without it, no `cloudflareinsights` source appears. `vite preview` mirrors the headers (without analytics);
   `vite dev` never gets the CSP, because Vite's HMR uses inline scripts.
   `/sitemap.xml` lists `/` (the home, with the newest `publishedAt` as its `lastmod`) and every published atlas's
   canonical `/r/<slug owner>/<slug repo>` on `OKIE_PUBLIC_ORIGIN`, with `lastmod` from `publishedAt`. It does not
   list `/new`, which 301s to `/` (CLA-269). It is served with `cache-control: public, max-age=300`.
   The Worker builds it from `index.json`, which each Worker isolate reads from R2 at most once a minute (the same
   cache serves the `/r` titles and the home's directory). A new publish can therefore take about a minute to appear in
   the sitemap and on the home (which shared caches keep for up to 1 more minute), and up to 5 more minutes in shared
   caches for the sitemap. Production's `robots.txt` points to it.
8. **Web Analytics (production only):** Cloudflare Web Analytics is cookieless, so there is no consent banner and no
   other tracker. In the dashboard (Analytics & Logs → Web Analytics → Add a site → `sourcefor.dev`), choose the
   **manual JS snippet install** and leave **automatic setup / JS snippet injection off** for the zone: the Worker
   injects the snippet itself, and Cloudflare's automatic injection on top would count every page view twice. Copy
   the site token from the snippet's `data-cf-beacon` (it is public; it ships in every page). Put
   `"WEB_ANALYTICS_TOKEN": "<token>"` in `env.production.vars` (sourcefor.dev's token is already there) in `apps/edge/wrangler.jsonc`, then run `pnpm build`
   and `deploy:production`. The Worker then adds the beacon just before `</body>` of every HTML page it serves: the
   home page `/`, the SPA shell, `/r/...` (oEmbed embeds included; `WEB_ANALYTICS_IN_EMBEDS` in `apps/edge/src/analytics.ts`
   turns that off) and the 404 pages. JSON, PNG, assets and the sitemap are never touched. A token that is not 16-64
   letters or digits is ignored (no beacon, and no `cloudflareinsights` in the CSP). Injected pages carry no ETag or
   Last-Modified, and the Worker drops conditional headers on the shell, so the shell (`max-age=0,
   must-revalidate`) is refetched in full rather than 304'd to a copy without the beacon. Staging and local dev stay unset. The web build (and the portable
   viewer) never contain the beacon. To turn analytics off, remove the var and redeploy.
9. **Staging behind Cloudflare Access:** staging.sourcefor.dev requires an Access login. Production stays public.
   Set it up once in the dashboard (the wrangler OAuth login has no Access scope):
   - **Zero Trust:** Zero Trust → pick a team name (the login lives at `<team>.cloudflareaccess.com`) → the Free
     plan. Integrations → Identity providers must list **One-time PIN** (else Add new identity provider → One-time
     PIN).
   - **Service token:** Access controls → Service credentials → Service Tokens → Create Service Token
     `atlas-staging-smoke`. Copy its Client ID and Client Secret; the secret is shown once.
   - **Application:** Access controls → Applications → Create new application → Self-hosted and private → Add
     public hostname `staging.sourcefor.dev` (no path), login method One-time PIN. It has two policies: **Allow** with Include → Emails → the owner's address, and
     **Service Auth** with Include → Service Token → `atlas-staging-smoke`. A Service Auth policy is needed because
     an Allow policy doesn't accept service tokens. The app's "401 Response for Service Auth policies" option can
     stay at its default; the smoke script treats a 401 like the login redirect.
   - **Local keys:** put the token in the gitignored repo-root `.env` as `STAGING_ACCESS_CLIENT_ID` and
     `STAGING_ACCESS_CLIENT_SECRET`. `smoke:staging` sends them as `CF-Access-Client-Id` / `CF-Access-Client-Secret`.
     Nothing else reads them, and nothing prints them.

   Everything on staging is behind the login, including `/og`, `/oembed`, share pages and `robots.txt`. So link
   unfurlers and embeds can't reach staging; test those on production or the local edge. Deploys are unaffected:
   `deploy:staging` talks to the Cloudflare API, not to the hostname. To rotate the token, create a new one, add it to
   the Service Auth policy, update `.env`, then delete the old one.
10. **First-deploy lessons (fresh account):**
    - Error **10063**: the account has no workers.dev subdomain yet. Open Workers & Pages in the dashboard once to
      create it, then deploy again.
    - Error **100117**: a custom-domain hostname already has DNS records. Delete them in the dashboard (DNS → Records)
      first, then deploy again.

## 2. Publish an atlas

Scan and publish in the local operator UI as usual. Then upload the repository's current publication:

```sh
pnpm --filter @okie/server build        # the publish script runs from apps/server/dist
pnpm publish:atlas --repo thiss/okie --env staging --scan-root ~/sites/okie/fixtures/scan
pnpm publish:atlas --repo thiss/okie --env production --scan-root ~/sites/okie/fixtures/scan --yes
```

- The operator store is read-only here: the script never takes the lock and never writes.
- Licence first: it asks the GitHub licence API for the repository at the published commit (unauthenticated) and records
  `{ spdxId, name, url }` in the manifest and the index row. No licence file, GitHub's `NOASSERTION`, or a failed lookup
  refuses the publish. After checking the repository's terms by hand, pass `--license-override` with an SPDX id or an
  SPDX expression (no lookup, no URL). Quote expressions and use upper-case operators: `--license-override "MIT AND
  CC-BY-4.0"` (code MIT, docs CC-BY, e.g. facebook/docusaurus), `--license-override "Unlicense OR MIT"` (dual
  licence, e.g. BurntSushi/ripgrep). The attribution strip shows an expression as `licence: <expression>`. A version is
  immutable, so changing the licence of a published atlas needs a new operator publication (a new version id).
- GitHub's casing: the publish also asks `GET api.github.com/repos/<owner>/<repo>` (unauthenticated) and records
  `ownerLogin` / `repoName` in the index row (`BurntSushi` where `owner` is `burntsushi`). The attribution strip, the
  home page's directory cards, and the `/r` title, oEmbed title and card text show that casing. Without it they show the stored names.
  URLs keep the slug form. A failed lookup doesn't stop the publish: the row keeps the names it already had, or goes
  without. To fill rows published before CLA-318, run the one-off backfill. It rewrites `index.json` only: no new
  versions, pointers or manifests. Rows that already have both names are skipped, and a failed lookup leaves its
  row unchanged:

  ```sh
  pnpm publish:atlas --env staging --backfill-names --dry-run   # reads the env's index.json, prints one line per row, writes nothing
  pnpm publish:atlas --env staging --backfill-names
  pnpm publish:atlas --env production --backfill-names --yes
  ```

  `--env local [--persist-to <dir>]` runs against the local bucket, and `--dry-run --out <dir>` runs against a
  directory store. Don't publish while it runs: it reads, then rewrites `index.json`.
- Description and language (CLA-269): the same GitHub response gives the repository's `description` and `language`.
  The publish records them in the index row, sanitised (trimmed, one line, no control, bidi or invisible characters,
  description capped at 280 characters and language at 40), and leaves them out when GitHub has none. The zero-width
  joiner and non-joiner (U+200D, U+200C) are kept, because emoji sequences such as the woman mage (U+1F9D9 U+200D U+2640 U+FE0F) need them. They show on the
  home page's cards and are searchable there. A re-publish refreshes them, and a failed lookup keeps the ones the row
  already had (as with the names). A renamed or transferred repository is refused, so it records neither names nor meta.
  To fill rows published before this, or to refresh them all, run `--backfill-meta`. It looks up **every** row, one
  request each (unauthenticated GitHub allows 60 an hour). It fills or refreshes `description` / `language`, and fills
  `ownerLogin` / `repoName` from the same response, so it covers `--backfill-names` too. It rewrites `index.json`
  only. A failed lookup leaves its row unchanged. A description or language that GitHub reports as null or empty is
  removed, and one missing from the response is kept. Rows missing names, a description or a language are looked up
  first. The first 403 or 429 from GitHub, or `x-ratelimit-remaining: 0`, stops the lookups. The run logs how many rows
  it didn't reach and writes only the rows it resolved, so re-run it after the limit resets. It re-reads `index.json`
  before writing and skips any row that changed meanwhile, and a run with nothing new writes nothing. A plain
  `--dry-run` reads through a read-only client, so it can't write:

  ```sh
  pnpm publish:atlas --env staging --backfill-meta --dry-run   # reads the env's index.json, prints one line per row, writes nothing
  pnpm publish:atlas --env staging --backfill-meta
  pnpm publish:atlas --env production --backfill-meta --dry-run
  pnpm publish:atlas --env production --backfill-meta --yes
  ```

- Backups: before either backfill writes, it saves the current `index.json` bytes to a local file, reads the file back
  to check the bytes, and logs the path. Pass `--backup <file>` to choose it; a relative path is resolved against the
  directory you ran `pnpm` from. By default it is `backfill-backup-<env>-<UTC timestamp>.json` in that directory, or
  beside the `--out` directory (not inside the store) with `--dry-run --out`. These files are gitignored. It never
  overwrites an existing file. If the backup can't be written, or doesn't read back identically, nothing is written to
  the bucket.
- After the write, the backfill reads `index.json` back. If the bytes are not what it wrote, it prints a `WARNING`:
  a publish that ran at the same time may have been overwritten. The warning names the backup path. **Don't publish
  during a backfill, or between a backfill and a restore from its backup.** A restore puts back the whole file, so it
  drops any row published after the backup was taken. To roll back, put the file back into the bucket the run logged
  (`sourcefor-atlas-staging` for staging, `sourcefor-atlas` for production):
  `pnpm --filter @okie/edge exec wrangler r2 object put <bucket>/atlas/v1/index.json --file <backup> --content-type application/json --remote`.
- Share URLs: `/r/<owner>/<repo>` resolves through the scan slugger (`BurntSushi` → `burnt-sushi`). A URL that misses
  but matches a published row once case and punctuation are ignored (`/r/burntsushi/ripgrep`) 301s to the canonical
  `/r/<slug owner>/<slug repo>`.
- It uploads the version's `public/` files, `private/operator-explanations.json`, the packs,
  `packs/source-paths.json` (the paths the pinned source view may fetch) and `manifest.json`, then moves `latest.json`,
  then rewrites `index.json`. An unreadable remote `index.json` fails the publish before anything is uploaded.
- Packs: `neighborhood` holds the default view and every entity (leaves included), `excerpt` every entity's excerpt.
  Each entry is its own gzip member of the exact route body (`encoding: "gzip"` in the pack index). thiss/okie
  (4,048 entities) takes ~32 s and ~700 MB RSS to build: neighborhood 432 MB of bodies → 34.7 MB, excerpt 5.1 → 1.9 MB,
  71 MB uploaded in 17 objects. A pack over 300 MB fails the publish (wrangler puts at most 315 MB per object).
- Versions are immutable. Re-publishing the same version is a no-op apart from the pointer and index. A different
  manifest under an existing version id is refused.
- `--dry-run [--out <dir>]` writes the objects to a local directory instead, and `--env local [--persist-to <dir>]`
  writes to the local `wrangler dev` bucket.
- The site picks up a new version without a redeploy:
  - latest-resolved responses cache for 60 s;
  - the container mirror polls `index.json` every 60 s and also fetches on demand.
- Share cards (CLA-319): the publish also renders the version's structure card (system, containers, peers from the
  public snapshot; apps/web/src/atlasStructureCard.ts, bundled for Node with esbuild at startup) and uploads it with the
  version objects, before the manifest, as `versions/<v>/card-<renderer>.png`, where `<renderer>` is
  `STRUCTURE_CARD_RENDERER_VERSION` (`r1`). It is **not** in `manifest.json` (versions are immutable and a re-publish
  compares manifest bytes, so a new field would make every existing version refuse to re-publish); it is found by key.
  - A stored card is permanent, so it is rendered only when the GitHub owner/repo casing lookup succeeded; otherwise
    the publish logs `no share card stored` (fix with `--backfill-names`, then `--backfill-cards`).
  - Before rendering, the script checks the renderer: the reference card must match
    `STRUCTURE_CARD_REFERENCE_SHA256`. A mismatch (stale package build: `pnpm --filter './packages/*' build`; a
    different Node/locale) or a bundle failure only warns, and the publish goes ahead without a card, as does a render
    failure.
  - Re-publishing an unchanged version adds the card only if the key is missing; a card on a completed version is
    never overwritten, and a card read/write error there only warns (`latest.json`/`index.json` still move).
- `/og/<owner>/<repo>` serves the card of the index row's `versionId` for the current renderer, if it is a
  1200×630 PNG; otherwise (missing, older renderer only, unreadable) it renders the generated owner/repo card. The edge
  cache key carries `&v=<versionId>&r=<renderer>`, so a re-publish or a `--set-latest` rollback switches cards within
  the index cache's minute. A generated card served for a published version is edge-cached for 5 minutes only (a
  day otherwise), so a card added later shows up quickly.
- Backfill cards for versions published before CLA-319 (or after a renderer bump). **Run it before deploying the Worker
  that reads the new key**: it is safe to run first, since the running Worker never reads `card-rN` keys it doesn't
  know. Dry run first and look at the previews:

  ```bash
  pnpm publish:atlas --env staging --backfill-cards --dry-run --preview ./card-preview   # reads the env, writes nothing to the bucket
  pnpm publish:atlas --env staging --backfill-cards
  pnpm publish:atlas --env production --backfill-cards --dry-run --preview ./card-preview
  pnpm publish:atlas --env production --backfill-cards --yes
  ```

  For every `index.json` row with GitHub's casing recorded (others are skipped: run `--backfill-names` first) it reads
  that version's `public/snapshot.json` + `view.json`, renders the card, saves it to the preview directory
  (`--preview <dir>`, default a new temp directory; the path is logged) and, unless a dry run, puts it, only when
  `card-<renderer>.png` is missing. It never overwrites a card on a completed version, never deletes, and never touches
  `index.json`, `latest.json` or manifests; before the first put it saves `index.json` like the other backfills (a
  record of which versions were carded). It refuses to start if the bundle fails or the renderer self-check does not
  match. One line per row: slug, versionId, bytes, action; a failed row is reported and the run continues (exit code
  1). `--dry-run --out <dir>` runs against a directory store.
- Changing the card layout: bump `STRUCTURE_CARD_RENDERER_VERSION` and re-pin `STRUCTURE_CARD_REFERENCE_SHA256`
  (apps/web/src/atlasStructureCardVersion.ts, `r1` → `r2`; apps/web/src/atlasStructureCard.test.ts fails until you
  do), run `--backfill-cards` for each env from that commit, then deploy the Worker. Versions without an `r2` card
  serve the generated card; the `r1` cards stay in the bucket untouched.

## 3. Deploy the Worker

```sh
pnpm build                                    # apps/web/dist + gates
pnpm --filter @okie/edge deploy:staging       # wrangler deploy --env staging (Worker + static assets + Node container)
```

To validate the config without deploying (no account calls, no Docker):
`pnpm --filter @okie/edge exec wrangler deploy --dry-run --containers-rollout=none --env staging --outdir <scratch dir>`.
Before a real deploy, validate the Linux amd64 image with Docker. Never print gateway or session secrets.

Then run the smoke checks against staging:

```sh
pnpm --filter @okie/edge smoke:staging       # needs STAGING_ACCESS_CLIENT_ID / _SECRET in .env (staging is behind Access)
pnpm --filter @okie/edge smoke:production    # after deploy:production; never sends the Access headers
```

The script (`apps/edge/scripts/smoke.mjs`) checks these routes: the home, the SPA shell, the 404 and `/new` 301,
`robots.txt`, the sitemap, `/api/auth/me`, the missing-asset 404, `/scan/index.json`, and the first published
atlas's `/r` page and `/og` card. On every HTML page it checks the status, the CSP, `nosniff`, and the beacon count:
1 on production, 0 on staging. It follows no redirects. If staging answers with the Access login (a redirect to
`*.cloudflareaccess.com`, or a 401), the run stops with an error: without the keys, it names them; with them, the token was
rejected (it is expired or missing from the Service Auth policy). If only one of the two keys is set, or a value has a line break
or space, it refuses to run. `curl` against staging needs the same two headers, e.g.
`curl -sI -H "CF-Access-Client-Id: $STAGING_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $STAGING_ACCESS_CLIENT_SECRET" https://staging.sourcefor.dev/`.
The list below is the full set, including the manual and browser checks. A browser on staging needs the One-time PIN
login first.

- `/` (the edge-rendered home: hero, "Explore an atlas" CTA, the search form and a card per published atlas; no SPA
  `<div id="root">`); `/?q=<part of a name>` shows only the matching cards with an `N of M atlases` count, `/?sort=az`
  orders them A–Z, and `curl -sI <origin>/home.js` answers `200` JavaScript with `cache-control: public, max-age=300`,
  `/?fixture=okie` (the SPA golden demo), `/r/<owner>/<repo>` (atlas renders, OG tags in the HTML), `/og/<owner>/<repo>`
  (PNG), `/oembed?url=https://staging.sourcefor.dev/r/<owner>/<repo>`.
- `curl -sI <origin>/new` answers `301` with `location: /` (`/new?utm_source=x&a=1` → `/?utm_source=x`: only the
  home's query params survive).
- On `/r/<owner>/<repo>`: no Ask button, panel or ⌘↵ shortcut; no account menu; the attribution strip at the bottom
  shows the repository, commit and licence, linking to GitHub. In an embed (`?embed=1` or framed) it is a compact line,
  `owner/repo · licence · source ↗`, with each link opening a new tab (CLA-328).
- Headers: `curl -sI <origin>/ | grep -iE 'content-security|x-content-type|referrer-policy|permissions-policy|origin-agent-cluster'`
  shows all five, with `frame-ancestors 'self'`, `Permissions-Policy: tools=(self)` and `Origin-Agent-Cluster: ?1`. `curl -sI <origin>/r/<owner>/<repo>` shows a CSP without `frame-ancestors`. A JSON or asset
  response has `nosniff` and no CSP. In a browser, the console on `/`, `/?fixture=okie` and `/r/<owner>/<repo>` (and in an embed)
  shows no `Refused to …` CSP errors.
- `curl -s <origin>/sitemap.xml` lists `/` and each published atlas, and no `/new` (`content-type: application/xml`).
  Production's `/robots.txt` ends with `Sitemap: https://sourcefor.dev/sitemap.xml`.
- Production with `WEB_ANALYTICS_TOKEN` set: `curl -s https://sourcefor.dev/ | grep -o cloudflareinsights.com/beacon | wc -l`
  prints exactly `1` (the home; same for `/?fixture=okie` and `/r/<owner>/<repo>`; `/new` is a 301 with no body). `2` means Cloudflare's automatic injection is also on:
  turn it off (step 8). Staging prints `0`. In a browser, the Network tab
  shows `beacon.min.js` and a `cdn-cgi/rum` POST with no CSP errors, and page views appear in Web Analytics within
  a few minutes.
- `/scan/index.json`, `/api/auth/me` (`{ mode: "public", ask: false }`), `/api/ask` (`{ connected: false }`).
- `curl -s -o /dev/null -w '%{http_code}' <origin>/assets/missing.js` answers `404`, and `curl -sI` on a real chunk
  from the page (`<origin>/assets/index-<hash>.js`) still shows `cache-control: public, max-age=31536000, immutable`
  (`_headers` through the Worker). On staging,
  `curl -sI <origin>/ | grep -i x-robots-tag` shows `noindex, nofollow` and `/robots.txt` disallows everything;
  production serves the allow-all `robots.txt` from the web build.
- `curl -sI -H 'accept-encoding: gzip' '<origin>/scan/<slug>/neighborhood.json'`: `content-encoding: gzip`,
  `vary: Accept-Encoding`.
  The pack must be decompressed exactly once:
  `curl -s --compressed '<origin>/scan/<slug>/neighborhood.json' | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8")); console.log("ok")'`
  prints `ok`. A double-gzipped body fails to parse.
- Open "View full source" in the inspector once. `source.json` fetches the file from GitHub raw at the pinned commit
  and caches the raw file in the Cache API (a year, keyed by repo + commit + path). When GitHub is down or
  rate-limiting, an uncached file answers 502 "Historical source is unavailable right now. The saved excerpt remains
  available." and the saved excerpt still shows.

Production is the same command with `deploy:production`, after staging looks right. Never deploy production first.

## 4. Roll back

- **Worker code:**
  `pnpm --filter @okie/edge exec wrangler deployments list --env <env>`, then
  `pnpm --filter @okie/edge exec wrangler rollback <deployment-id> --env <env>`.
  A rollback restores the Worker script and its static assets.
- **An atlas:** move the pointer back to an earlier immutable version that is already in R2:
  `pnpm publish:atlas --repo <owner/name> --env <env> --set-latest <versionId>` (production also needs `--yes`).
  This checks that the version's manifest exists in that bucket, rewrites `latest.json` and then `index.json` (the row
  is rebuilt from the manifest), and uploads nothing else.
  Version ids are listed in the old manifests (`previousVersionId`) and in the operator UI's publication history.
- **Take an atlas offline:** delete `atlas/v1/repos/<slug>/latest.json` and its row in `index.json`. The versions can
  stay; nothing serves a version without a pointer except pinned `?version=` links.
- **Ask spending too fast (once Ask is on):** set `ASK_ENABLED` to `"0"` and redeploy. Ask and block-plan then 404 at
  the edge, the web app hides Ask, and the atlas stays up. For a softer brake, set `ASK_DAILY_MAX_DOLLARS` /
  `ASK_DAILY_MAX_REQUESTS` low (`0` refuses all).

## 5. Local QA (no Cloudflare account)

Browse-only, exactly as staging/production serve it (no backend, no `.dev.vars` needed):

```sh
pnpm publish:atlas --repo <owner/name> --env local --scan-root <scratch copy of a scan root>
pnpm --filter @okie/edge dev                                  # wrangler dev on 127.0.0.1:4196, containers off
```

With Ask on, against a locally run apps/server:

```sh
cp apps/edge/.dev.vars.example apps/edge/.dev.vars          # uncomment ASK_ENABLED=1; DEV_* are local only
OKIE_SERVER_MODE=public-readonly OKIE_SERVER_PORT=4195 OKIE_SCAN_ROOT=$(mktemp -d) \
  OKIE_PUBLISHED_STORE_URL=http://127.0.0.1:4196/__store node apps/server/dist/main.js
pnpm --filter @okie/edge dev
```

- Don't use ports 4173, 4174 or 4180; they belong to the operator's own servers.
- To try the real container locally (Docker running), run
  `pnpm --filter @okie/edge exec wrangler dev --env='' --port 4197 --enable-containers`.

## 6. Sign-in (CLA-316)

GitHub sign-in and email capture live in the Worker (`apps/edge/src/auth.ts`); accounts are one D1 table
(`apps/edge/migrations/0001_users.sql`). Sign-in is **off** in an env until all of these exist there: the `USERS_DB`
binding (in `wrangler.jsonc` for every env), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and a `SESSION_SIGNING_KEY` of
at least 32 characters. While it is off, `/api/auth/me` answers the public shape unchanged, every other `/api/auth/*`
and `/api/account/*` route is a 404, and `/account` is the 404 page. Deploying without the secrets changes nothing.

| Env | GitHub OAuth app callback URL | D1 database (`USERS_DB`) |
|---|---|---|
| local | `http://127.0.0.1:4196/api/auth/github/callback` (optional; see below) | `sourcefor-atlas-local` (on disk) |
| staging | `https://staging.sourcefor.dev/api/auth/github/callback` | `sourcefor-atlas-staging` |
| production | `https://sourcefor.dev/api/auth/github/callback` | `sourcefor-atlas` |

1. **GitHub OAuth app, one per env** (GitHub → Settings → Developer settings → OAuth Apps): the homepage is the env's origin
   and the callback is the URL above. The Worker asks only for the `user:email` scope, reads the profile and the
   primary verified email, and throws the token away (it is never stored or logged).
2. **Secrets** (never in `wrangler.jsonc` vars; `test/config.test.ts` asserts it):

   ```sh
   cd apps/edge
   pnpm exec wrangler secret put GITHUB_CLIENT_ID --env <env>
   pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --env <env>
   openssl rand -base64 48 | pnpm exec wrangler secret put SESSION_SIGNING_KEY --env <env>
   ```

   Rotating `SESSION_SIGNING_KEY` signs everyone out (sessions are signed cookies); accounts and opt-ins are kept.

   **Revocation limits (stateless 30-day sessions):** logout clears the cookie in that browser only, so a copied
   cookie stays valid until it expires. Deleting an account signs every copy out (each request checks the D1 row), but
   if the same GitHub user signs in again, old unexpired cookies for that id work again. Rotating
   `SESSION_SIGNING_KEY` is the only way to revoke every session at once.
3. **Schema:** `deploy:<env>` runs `wrangler d1 migrations apply USERS_DB --env <env> --remote` before every deploy
   and stops if it fails. To apply by hand: the same command from `apps/edge`.
4. **Check:** `/api/auth/me` answers `mode: "accounts"`, the home header shows "Sign in with GitHub", and signing in
   lands on `/account?welcome=1` the first time (product updates unticked; ticking it is the only way to opt in).

**Export and deletion.** The operator path, through `wrangler d1 execute --remote` with your `wrangler login` session
(`--silent` keeps pnpm's banner out of the CSV):

```sh
pnpm --silent --filter @okie/edge users:export production > users.csv             # every account
pnpm --silent --filter @okie/edge users:export production --opted-in > updates.csv # product-updates opt-ins with an email
pnpm --silent --filter @okie/edge users:delete production --github-id 123456       # prints how many rows went
pnpm --silent --filter @okie/edge users:delete production --email someone@example.com
```

Self-serve: a signed-in user can untick product updates, or tick the confirmation and "Delete my account", on
`/account`. Deletion removes the row at once and signs them out.

**Scan requests (CLA-455):** a signed-in user can ask for a public repo to be scanned from `/account` (the home
page's "Request a scan" link goes there). Requests are in `scan_requests` in the same database, at most five open
per user. Work through them like this:

```sh
pnpm --silent --filter @okie/edge requests:export production > requests.csv       # open requests, oldest first, with login and email
pnpm --silent --filter @okie/edge requests:export production --all > all.csv      # every status
pnpm --silent --filter @okie/edge requests:status production --id 7 --status published   # after its atlas is live
pnpm --silent --filter @okie/edge requests:status production --id 8 --status declined     # not scanning it
```

The user sees the status on `/account`, with a link to the atlas once it is `published`. Nothing emails them
yet. Deleting an account, from `/account` or with `users:delete`, deletes its requests too.

**Privacy, terms and cookie notice:** the `/privacy` copy lives in `PRIVACY_COPY` at the top of `apps/web/src/privacyPage.ts` and the `/terms` copy in `TERMS_COPY` in `apps/web/src/termsPage.ts` (its date is `TERMS_VERSION` in `siteMeta.ts`; the operator's legal name on both pages is the one `SITE_OPERATOR` line in `privacyPage.ts`) (its cookie table comes from `auth.ts`, its date from `PRIVACY_POLICY_VERSION` in `apps/web/src/siteMeta.ts`: bump that when the policy changes); the notice's words are `COOKIE_NOTICE_TEXT` in the same `siteMeta.ts`. Copy the owner still has to fill in carries the marker `[pending owner]` (or `[pending owner: <what to do>]`); `deploy:production` refuses to run while `privacyPage.ts` or `termsPage.ts` contains it (staging deploys anyway, and a production `--dry-run` only prints a warning).

**Local:** in `apps/edge/.dev.vars` set `SESSION_SIGNING_KEY` (32+ characters) and either `DEV_AUTH_TEST_LOGIN=1` (a fixed
test user `okie-test-user`; honoured only on a loopback origin) or a local OAuth app's `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET`. Create the local table once with `pnpm --filter @okie/edge exec wrangler d1 migrations apply USERS_DB --local`.

## Container sizing

Both environments repeat the `ATLAS_API` binding and container configuration. The existing `v1` migration already
created `AtlasApiContainer`; do not add another creation migration. The instance is `basic` (1/4 vCPU, 1 GiB, 4 GB disk),
`max_instances: 1`, and all traffic goes to the named instance `atlas-api`.
It sleeps after 10 minutes idle, and a sleeping container isn't billed.

The image sets these memory defaults:

| Var | Image value |
|---|---|
| `OKIE_ASK_WORKER_MAX_HEAP_MB` | 512 |
| `OKIE_ASK_MAX_WARM_INDEXES` | 2 |
| `OKIE_NEIGHBORHOOD_CACHE_ENTRIES` | 2 |

With those, the measured peak RSS (main process plus Ask worker, three atlases warm, including a 19 MB snapshot) is
about 513 MB. With several near-cap (64 MB) snapshots, move to `standard-1` (4 GiB) and raise the three values.
