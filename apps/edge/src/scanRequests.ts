/**
 * Scan requests (CLA-455): a signed-in user asks for a public GitHub repository to be scanned. Nothing is
 * fetched from GitHub here; the operator checks, scans and publishes the repo locally, then sets the status
 * (scripts/users.mjs). Storage is the `scan_requests` table in USERS_DB (migrations/0002_scan_requests.sql).
 */

export const MAX_OPEN_SCAN_REQUESTS = 5;
export const MAX_SCAN_REQUEST_NOTE = 500;

export type ScanRequestStatus = 'requested' | 'published' | 'declined';
export type ScanRequest = { owner: string; repo: string; status: ScanRequestStatus; createdAt: string };
export type ScanRequestOutcome = 'requested' | 'invalid' | 'duplicate' | 'limit';

// GitHub's own rules: owners are 1–39 alphanumerics or single hyphens; repo names are [A-Za-z0-9._-]{1,100}.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/repo`, or a github.com URL to the repo or any page inside it. Undefined when it is neither. */
export function parseScanRequestRepo(input: string): { owner: string; repo: string } | undefined {
  const text = input.trim();
  if (text.length > 300) return undefined;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.*)$/i.exec(text);
  const path = (url ? url[1]! : text).split(/[?#]/)[0]!;
  const parts = path.split('/');
  // A bare value is exactly `owner/repo`; a URL may point anywhere inside the repo.
  if (!url && (parts.length !== 2 || /[:\s]/.test(text))) return undefined;
  const [owner, rawRepo] = parts;
  const repo = rawRepo?.replace(/\.git$/i, '');
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return undefined;
  return { owner, repo };
}

/** The optional note: trimmed, control characters removed, at most MAX_SCAN_REQUEST_NOTE characters. */
export function cleanScanRequestNote(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = input.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return text ? [...text].slice(0, MAX_SCAN_REQUEST_NOTE).join('') : null;
}

export async function createScanRequest(
  db: D1Database,
  githubId: number,
  input: { repo: unknown; note: unknown },
  now: Date,
): Promise<ScanRequestOutcome> {
  const parsed = typeof input.repo === 'string' ? parseScanRequestRepo(input.repo) : undefined;
  if (!parsed) return 'invalid';
  const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  const open = await db.prepare("SELECT repo_key FROM scan_requests WHERE github_id = ?1 AND status = 'requested'").bind(githubId).all<{ repo_key: string }>();
  const existing = await db.prepare('SELECT 1 AS found FROM scan_requests WHERE github_id = ?1 AND repo_key = ?2').bind(githubId, key).first();
  if (existing) return 'duplicate';
  if (open.results.length >= MAX_OPEN_SCAN_REQUESTS) return 'limit';
  const at = now.toISOString();
  await db.prepare(
    `INSERT INTO scan_requests (github_id, owner, repo, repo_key, note, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT (github_id, repo_key) DO NOTHING`,
  ).bind(githubId, parsed.owner, parsed.repo, key, cleanScanRequestNote(input.note), at).run();
  return 'requested';
}

/** A user's requests, newest first. */
export async function listScanRequests(db: D1Database, githubId: number): Promise<ScanRequest[]> {
  const rows = await db.prepare('SELECT owner, repo, status, created_at FROM scan_requests WHERE github_id = ?1 ORDER BY created_at DESC, id DESC')
    .bind(githubId).all<{ owner: string; repo: string; status: ScanRequestStatus; created_at: string }>();
  return rows.results.map(row => ({ owner: row.owner, repo: row.repo, status: row.status, createdAt: row.created_at }));
}

export function deleteScanRequestsStatement(db: D1Database, githubId: number): D1PreparedStatement {
  return db.prepare('DELETE FROM scan_requests WHERE github_id = ?1').bind(githubId);
}
