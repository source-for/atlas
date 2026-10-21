# AGENTS.md

Repo conventions, commands, and gotchas live in [`CLAUDE.md`](./CLAUDE.md). Follow those. The section below is extra for Cursor Cloud agents.

## Proof required before shipping

Ship targets `main` directly, but only after task completion is demonstrated in
the thread. Before pushing or merging to `main`:

- Exercise the requested behavior end to end and report the commands, observable
  results, and relevant regression checks. Passing unit tests or a clean diff
  alone is not proof that a feature works.
- For UI work, explore the running application through the changed flow and
  representative affected states. Capture and inspect screenshots, then embed
  them in the thread. For interactions, also capture, inspect, and share a video
  of the real pointer/keyboard flow. Do not substitute generated mockups for
  evidence from the running app.
- For bug fixes, show the failing case before the fix and the same case passing
  afterward when reproducible. Include nearby behavior that must remain intact.
- State every material verification gap explicitly. If a requirement remains
  unproven, do not call the task complete or ship it; resolve the gap or obtain
  the user's explicit acceptance of that limitation first.

This proof gate applies to all agents and to direct pushes as well as Ship.
It does not itself authorize a push, merge, deployment, or release.

## Cursor Cloud specific instructions

Before opening or closing a pull request, QA must **explore the running application** — not only unit tests, logs, or `GET /healthz`. A diff-only pass or a single screenshot is not enough.

1. Boot the app the way a user would:
   - Scan server: `node apps/server/dist/main.js` on `http://127.0.0.1:4180` (Vite proxies `/api` and `/scan` here). Bind is loopback; this process has no auth. LLM enrichment and Ask stay off unless you add `--llm-provider openrouter --dotenv` (see `apps/server/README.md`).
   - Web: `pnpm dev` on `http://localhost:4173` (regenerates WASM + the stress fixture first). If those generated outputs already exist, `pnpm --filter @okie/web dev` is enough to serve the UI.
2. Exercise the changed flow in the browser the way a real user would: click, type, submit, navigate. Confirm behavior, not just appearance.
3. For atlas work, play the guided story (jump to a step and wait for `[data-playback-state="paused"]`, not a fixed delay), select a node, and confirm the inspector is not blank. Check related routes that share state (`/`, `/new`, `?fixture=scan` when a scan fixture is present).
4. Do not open or close a PR until that app exploration is done. Automated tests (`pnpm check`, `pnpm test`, `cargo test --workspace` as in `CLAUDE.md`) remain required; they do not replace it.

Dev diagnostics (renderer/backend pill, View/Edit, `+ Diagram`) are hidden until `Shift+Alt+D`. Never log API keys or put them on `/healthz`. Do not run live OpenRouter in CI; fake/fixture servers only unless the slice explicitly requires a live scan.
