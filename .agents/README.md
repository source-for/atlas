# Amp orb environment

`setup` installs the locked pnpm dependencies, the repository's Rust toolchain
and WASM target, CI's Rust analyzer components, and wasm-pack 0.13.1. It also
builds workspace packages and generates the stress fixture and optimized WASM.
It installs Node 22.23.3 in `~/.local/share/atlas/node` without replacing the
orb's system Node. This matches CI's Node 22 LTS major: the orb base image's
Node 26 causes mounted happy-dom tests to fail on `localStorage`. pnpm's exact
version comes from `package.json`; Rust's pin comes from `rust-toolchain.toml`.
No API keys, live scans, databases, or authentication are needed for setup.

Amp snapshots the installed tools, dependency caches, and generated outputs.
An exact snapshot skips setup; stale snapshots rerun it using the cached files.
The updated setup took 5m16s in a clean checkout (empty node_modules, target,
and generated outputs, but warm package/toolchain caches) on a small orb, and
46–49s on warm reruns. `resume` deliberately does no installation or server work.

Node and Rust are added to the login-shell PATH. Setup also persists single-job
Cargo/CMake/Binaryen limits and a private `TMPDIR` outside the Cargo workspace
(`~/.cache/atlas/tmp`); Rust scan tests reject world-writable `/tmp` ancestry.
In a thread already running when setup is first installed, use
`bash -lc '<command>'` until the next normal activation.

Follow `CLAUDE.md` for checks and development commands. The scan tests create
temporary Git repositories. If the orb's global Git configuration requires
signing but has no key for those repositories, run the test suite with a
process-local override (do not disable signing globally):

```sh
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false pnpm test
```

## Preview and Desktop

Run `amp orb services ensure` from the repository root and use its printed
Atlas Portal URL. `.amp/services.yaml` supervises Vite on 4173 and the scan
server on loopback 4180. Vite proxies `/api` and `/scan`, so the backend needs no
separate Portal. The services use the outputs already prepared by setup rather
than rebuilding WASM on every start. Rebuild after source changes as usual.

The preview forces LLM **off**, does not load `.env`, and disables the loopback
OAuth test-login bypass. The deterministic demo works without secrets. GitHub
sign-in needs explicit OAuth credentials and an `OKIE_PUBLIC_ORIGIN` matching
the Portal; see `apps/server/README.md`. Mapping/publishing follows the operator
workflow in `docs/portable-atlas.md`; the legacy scan POST returns 403 even in
this preview. Keep the Portal private:
scan read/status surfaces are still unauthenticated at the application layer.
Never expose the scan port separately or make this development preview public.
Optional LLM use needs both a provider and `OKIE_LLM_API_KEY` in Amp Secrets,
and an explicit change to the service's `--llm-provider off` argument.

`.agents/desktop/resume` ensures these same services and opens Atlas in a Chrome
app window, avoiding duplicate Atlas windows. It runs only when Desktop starts;
ordinary orb resume stays fast. The repository hook takes priority over any
project Desktop resume setting. No project pre-setup override is needed because
setup belongs in this repository. Local hook edits do not reach future orbs
until shipped to the project's base branch.

## Intended tiny default

The project default is `a1.tiny` (1 CPU / 2 GB). Keep builds/tests sequential,
close browser sessions, and stop preview services before running heavy gates.
Setup serializes native
builds and its initial workspace build. For lower-memory full-workspace gates:

```sh
pnpm prepare:generated
pnpm -r --workspace-concurrency=1 --if-present check
pnpm prepare:generated:release
pnpm -r --workspace-concurrency=1 --if-present build
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false \
  pnpm -r --workspace-concurrency=1 --if-present test
cargo test --workspace
```

Verification in the setup-audit thread used `a1.small` (2 CPUs / 4 GB), not tiny.
Successful small-orb checks do not certify tiny's memory headroom or cold-start
time. The clean check/build peaked at 1.44 GiB RSS in one subprocess (not an
aggregate measurement), leaving little headroom on tiny for Amp and services.
A fresh tiny setup/build/test/browser trial is still required; use small
as a per-thread override for memory-heavy scans or concurrent browser/build work
if tiny runs out of memory. No evidence yet establishes that tiny is unsuitable
for ordinary sequential deterministic work.
