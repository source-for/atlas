# aa-router-shaped scanner fixture (CLA-605)

A miniature of aa-router's layout, used by `packages/scan/src/nested-roots.test.ts`:

- `typescript/` is a pnpm workspace (`packages/*`, `apps/web`) with no root workspace above it.
- `typescript/apps/cloudflare-worker` is outside that workspace and has its own `package-lock.json`.
- `rust/` is a Cargo workspace (`crates/*`) whose crates inherit `[workspace.dependencies]`.
- `typescript/examples/demo` (own lockfile) and `rust/vendor/legacy` (`[workspace]`) are
  example/vendored roots the scanner must not promote to containers.

The test copies this tree into a temporary Git repository and scans it there; the files
are never built or installed.
