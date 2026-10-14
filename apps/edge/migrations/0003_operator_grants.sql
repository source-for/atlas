-- CLA-539: one-time operator grants for POST /api/operator/ask-usage (src/operator.ts). scripts/asks.mjs writes a
-- row through `wrangler d1 execute` (the operator's `wrangler login` session) and then calls the Worker with the
-- token; the Worker deletes the row as it accepts it. Only the token's SHA-256 is stored. action is `ask-show` or
-- `ask-reset`; account_id is the GitHub id the grant is for; expires_at and created_at are ISO timestamps (UTC).
CREATE TABLE operator_grants (
  token_hash TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  account_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
