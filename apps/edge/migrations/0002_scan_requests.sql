-- CLA-455: scans a signed-in user asked for. The operator scans and publishes public repos locally, then marks
-- the request published or declined (scripts/users.mjs). repo_key is `owner/repo` lowercased (GitHub names are
-- case-insensitive) so one user cannot ask for the same repo twice. No foreign key: deleteUser removes a user's
-- requests in the same batch as the user row.
CREATE TABLE scan_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'published', 'declined')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (github_id, repo_key)
);
CREATE INDEX scan_requests_status ON scan_requests (status, created_at);
