import { describe, expect, it } from 'vitest';
import { appliesRemoteMigrations, deployBlockedReason, PRIVACY_PENDING_MARKER, runDeploy, type DeploySpawn } from '../scripts/deployCore.mjs';
import deployScriptSource from '../scripts/deploy.mjs?raw';
import privacySource from '../../web/src/privacyPage.ts?raw';
import termsSource from '../../web/src/termsPage.ts?raw';
import { PRIVACY_COPY_PENDING } from '../../web/src/privacyPage';
import { csvField, deleteOutputUnreadableMessage, deleteSql, EXPORT_COLUMNS, exportSql, parseUsersArgs, sqlString, toCsv, wranglerRows } from '../scripts/usersCore.mjs';
import { edgeEnv } from './helpers';

describe('operator users scripts (CLA-316)', () => {
  it('parses export and delete arguments, refusing unknown environments and malformed ids/emails', () => {
    expect(parseUsersArgs(['export', 'production'])).toEqual({ command: 'export', env: 'production', optedIn: false });
    expect(parseUsersArgs(['export', 'staging', '--opted-in'])).toEqual({ command: 'export', env: 'staging', optedIn: true });
    expect(parseUsersArgs(['delete', 'production', '--github-id', '123'])).toEqual({ command: 'delete', env: 'production', githubId: 123 });
    expect(parseUsersArgs(['delete', 'production', '--github-id', '0'])).toEqual({ command: 'delete', env: 'production', githubId: 0 });
    expect(parseUsersArgs(['delete', 'staging', '--email', 'Some.One+x@example.co.uk'])).toEqual({ command: 'delete', env: 'staging', email: 'Some.One+x@example.co.uk' });
    for (const argv of [
      [], ['export'], ['export', 'local'], ['export', 'production', '--all'], ['drop', 'production'],
      ['delete', 'production'], ['delete', 'production', '--github-id'], ['delete', 'production', '--github-id', '1 OR 1=1'],
      ['delete', 'production', '--github-id', '-1'], ['delete', 'production', '--github-id', '1.5'], ['delete', 'production', '--github-id', '0x10'],
      ['delete', 'production', '--github-id', '99999999999999999999'],
      ['delete', 'production', '--email', "x'@example.com"], ['delete', 'production', '--email', 'a@b.com; DROP TABLE users'],
      ['delete', 'production', '--email', 'no-at-sign'], ['delete', 'production', '--email', 'a b@example.com'],
      ['delete', 'production', '--github-id', '1', '--email', 'a@example.com'],
    ]) {
      expect(parseUsersArgs(argv), argv.join(' ')).toHaveProperty('error');
    }
  });

  it('builds the SQL, which runs against the real schema', async () => {
    expect(exportSql(false)).toBe(`SELECT ${EXPORT_COLUMNS.join(', ')} FROM users ORDER BY github_id;`);
    expect(exportSql(true)).toContain('WHERE product_updates_opt_in = 1 AND email IS NOT NULL');
    expect(deleteSql({ githubId: 42 })).toBe('DELETE FROM scan_requests WHERE github_id IN (SELECT github_id FROM users WHERE github_id = 42); DELETE FROM users WHERE github_id = 42 RETURNING github_id;');
    expect(deleteSql({ email: 'A@Example.com' })).toBe("DELETE FROM scan_requests WHERE github_id IN (SELECT github_id FROM users WHERE lower(email) = lower('A@Example.com')); DELETE FROM users WHERE lower(email) = lower('A@Example.com') RETURNING github_id;");
    expect(() => deleteSql({ email: "x'--@example.com" })).toThrow();
    expect(() => deleteSql({ githubId: -1 })).toThrow();
    expect(sqlString("it's")).toBe("'it''s'");

    const db = edgeEnv.USERS_DB!;
    // Ids of this file's own (other test files share the database: never clear the table).
    await db.exec('DELETE FROM users WHERE github_id >= 900000');
    const insert = db.prepare("INSERT INTO users (github_id, github_login, email, email_verified, created_at, last_sign_in_at, privacy_version, product_updates_opt_in) VALUES (?1, ?2, ?3, 1, 't', 't', 'v', ?4)");
    await db.batch([insert.bind(900001, 'a', 'a@example.com', 1), insert.bind(900002, 'b', 'b@example.com', 0), insert.bind(900003, 'c', null, 1)]);
    const mine = (rows: Array<Record<string, unknown>>) => rows.map(row => row.github_id).filter(id => Number(id) >= 900000);
    expect(mine((await db.prepare(exportSql(true)).all()).results)).toEqual([900001]);
    expect(mine((await db.prepare(exportSql(false)).all()).results)).toEqual([900001, 900002, 900003]);
    // wrangler runs the statements in order; the last one's rows are the deleted accounts.
    const run = async (sql: string) => (await db.batch(sql.split(/;\s*/).filter(Boolean).map(statement => db.prepare(statement)))).at(-1)!.results;
    await db.exec('DELETE FROM scan_requests WHERE github_id >= 900000');
    const request = db.prepare("INSERT INTO scan_requests (github_id, owner, repo, repo_key, created_at, updated_at) VALUES (?1, 'acme', 'app', 'acme/app', 't', 't')");
    await db.batch([request.bind(900001), request.bind(900002)]);
    expect(await run(deleteSql({ email: 'B@EXAMPLE.COM' }))).toEqual([{ github_id: 900002 }]);
    expect(await run(deleteSql({ githubId: 900003 }))).toEqual([{ github_id: 900003 }]);
    expect(await run(deleteSql({ githubId: 900003 }))).toEqual([]);
    // The deleted account's scan requests went with it (CLA-455); another account's stayed.
    expect((await db.prepare('SELECT github_id FROM scan_requests WHERE github_id >= 900000').all()).results).toEqual([{ github_id: 900001 }]);
  });

  it('reads wrangler --json output and writes CSV (quoted, formula-safe, nulls empty)', () => {
    const stdout = JSON.stringify([{ results: [{ github_id: 1, github_login: 'a', email: null }], success: true, meta: { changes: 0 } }]);
    expect(wranglerRows(stdout)).toEqual([{ github_id: 1, github_login: 'a', email: null }]);
    expect(wranglerRows(`some banner\n${stdout}`)).toHaveLength(1);
    expect(() => wranglerRows(JSON.stringify([{ success: false, results: [] }]))).toThrow();
    expect(() => wranglerRows('no json')).toThrow();
    expect(csvField(null)).toBe('');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('+1')).toBe("'+1");
    expect(toCsv([{ github_id: 1, github_login: 'a', email: 'a@example.com' }], ['github_id', 'github_login', 'email', 'missing'])).toBe('github_id,github_login,email,missing\r\n1,a,a@example.com,\r\n');
    expect(toCsv([]).split('\r\n')[0]).toBe(EXPORT_COLUMNS.join(','));
  });

  it('shows wrangler\'s raw output when a DELETE\'s result cannot be read, warning rows may be gone', () => {
    const message = deleteOutputUnreadableMessage('▲ [WARNING] something odd\n{"partial":');
    expect(message).toMatch(/^the DELETE may still have run: rows may have been deleted/);
    expect(message).toContain('▲ [WARNING] something odd\n{"partial":');
  });

  it('deploy.mjs applies remote migrations except on --dry-run', () => {
    expect(appliesRemoteMigrations([])).toBe(true);
    expect(appliesRemoteMigrations(['--minify'])).toBe(true);
    expect(appliesRemoteMigrations(['--dry-run', '--outdir', 'x'])).toBe(false);
  });

  const sources = (privacy: string, terms: string) => (path: string) => {
    if (path === 'apps/web/src/privacyPage.ts') return privacy;
    if (path === 'apps/web/src/termsPage.ts') return terms;
    throw new Error(`unexpected read: ${path}`);
  };

  it('deploy.mjs refuses production while the privacy or terms copy has an unfilled placeholder; staging still deploys', () => {
    expect(PRIVACY_PENDING_MARKER).toBe(PRIVACY_COPY_PENDING);
    const message = 'privacy copy has an unfilled placeholder (apps/web/src/privacyPage.ts)';
    // The shipped copy is filled in: production deploys.
    expect(privacySource).not.toContain(PRIVACY_PENDING_MARKER);
    expect(deployBlockedReason('production', sources(privacySource, termsSource))).toBeUndefined();
    expect(deployBlockedReason('production', sources('Run by [pending owner: operator legal name].', termsSource))).toBe(message);
    expect(deployBlockedReason('staging', () => { throw new Error('staging reads nothing'); })).toBeUndefined();
    const fill = (text: string) => text.replace(/\[pending owner[^\]]*\]/g, 'Example Ltd');
    expect(fill(privacySource)).not.toContain(PRIVACY_PENDING_MARKER);
    // The terms page carries no marker of its own today (it imports the operator from privacyPage.ts).
    expect(termsSource).not.toContain(PRIVACY_PENDING_MARKER);
    expect(deployBlockedReason('production', sources(fill(privacySource), termsSource))).toBeUndefined();
    // A marker in the terms copy blocks too, naming that file.
    expect(deployBlockedReason('production', sources(fill(privacySource), 'x [pending owner: governing law] y'))).toBe('terms copy has an unfilled placeholder (apps/web/src/termsPage.ts)');
    // Both forms of the tag count: bare, and with what the owner has to do.
    expect(deployBlockedReason('production', sources('x [pending owner] y', ''))).toBe(message);
    expect(deployBlockedReason('production', sources('x [pending owner: confirm or drop] y', ''))).toBe(message);
  });

  function fakeDeploy(argv: string[], options: { privacy?: string; terms?: string; dist?: boolean; status?: number; env?: Record<string, string>; results?: Array<ReturnType<DeploySpawn>> } = {}) {
    const spawned: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = [];
    const out: string[] = [];
    const err: string[] = [];
    const reads: string[] = [];
    const waits: number[] = [];
    const spawn: DeploySpawn = (command, args, spawnOptions) => {
      spawned.push({ command, args, env: spawnOptions.env });
      return options.results?.[spawned.length - 1] ?? { status: options.status ?? 0 };
    };
    const code = runDeploy({
      argv: ['node', 'deploy.mjs', ...argv],
      env: { CLOUDFLARE_API_TOKEN: 'secret', HOME: '/home/x', ...options.env },
      edgeDir: '/repo/apps/edge/',
      repoRoot: '/repo/',
      readFile: path => { reads.push(path); return sources(options.privacy ?? privacySource, options.terms ?? termsSource)(path.replace('/repo/', '')); },
      exists: () => options.dist ?? true,
      spawn,
      sleep: milliseconds => waits.push(milliseconds),
      log: message => out.push(message),
      error: message => err.push(message),
    });
    return { code, spawned, out, err, reads, waits };
  }

  it('deploy.mjs production stops at the privacy guard before running anything; a dry run only warns', () => {
    const message = 'privacy copy has an unfilled placeholder (apps/web/src/privacyPage.ts)';
    const real = fakeDeploy(['production'], { privacy: 'Run by [pending owner: operator legal name].' });
    expect(real.code).toBe(1);
    expect(real.reads).toEqual(['/repo/apps/web/src/privacyPage.ts']);
    expect(real.err).toEqual([`refusing to deploy production: ${message}`]);
    expect(real.spawned).toEqual([]);
    expect(fakeDeploy(['production', '--minify'], { privacy: '[pending owner]' }).spawned).toEqual([]);

    const dry = fakeDeploy(['production', '--dry-run', '--outdir', 'x'], { privacy: 'Run by [pending owner].' });
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`warning: a real deploy to production would be refused: ${message}`);
    expect(dry.spawned.map(call => call.args)).toEqual([['exec', 'wrangler', 'deploy', '--env', 'production', '--dry-run', '--outdir', 'x']]);
    expect(dry.spawned[0]!.env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
  });

  it('deploy.mjs staging (and filled-in production) migrates the remote database first, then deploys', () => {
    const staging = fakeDeploy(['staging']);
    expect(staging.code).toBe(0);
    expect(staging.err).toEqual([]);
    expect(staging.spawned.map(call => call.args)).toEqual([
      ['exec', 'wrangler', 'd1', 'execute', 'USERS_DB', '--env', 'staging', '--remote', '--command', 'SELECT 1'],
      ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'USERS_DB', '--env', 'staging', '--remote'],
      ['exec', 'wrangler', 'deploy', '--env', 'staging'],
    ]);
    expect(staging.spawned.every(call => call.command === 'pnpm' && !('CLOUDFLARE_API_TOKEN' in call.env))).toBe(true);

    const production = fakeDeploy(['production'], { privacy: 'Run by Example Ltd.' });
    expect(production.code).toBe(0);
    expect(production.reads).toEqual(['/repo/apps/web/src/privacyPage.ts', '/repo/apps/web/src/termsPage.ts']);
    expect(production.spawned).toHaveLength(3);
    expect(fakeDeploy(['production'], { privacy: 'Run by Example Ltd.', terms: '[pending owner]' })).toMatchObject({ code: 1, spawned: [] });

    expect(fakeDeploy(['staging'], { status: 7 })).toMatchObject({ code: 7, spawned: [{ args: expect.arrayContaining(['execute']) }] });
    expect(fakeDeploy(['staging'], { dist: false })).toMatchObject({ code: 1, spawned: [], err: ['apps/web/dist is missing; run `pnpm build` first'] });
    expect(fakeDeploy(['prod'])).toMatchObject({ code: 2, spawned: [], reads: [] });
  });

  it.each(['preflight', 'migrations'])('retries %s once after code 7403 while surfacing redacted diagnostics', phase => {
    const failed = { status: 1, stderr: '[ERROR] D1 unauthorized [code: 7403] token=never-print-this' };
    const prefix = phase === 'migrations' ? [{ status: 0 }] : [];
    const result = fakeDeploy(['staging'], { results: [...prefix, failed, { status: 0 }] });
    expect(result.code).toBe(0);
    expect(result.waits).toEqual([5000]);
    expect(result.out).toContain(`USERS_DB ${phase} returned code 7403; waiting 5 seconds before one retry (OAuth refresh).`);
    const index = prefix.length;
    expect(result.spawned[index]!.args).toEqual(result.spawned[index + 1]!.args);
    expect(result.spawned.at(-1)!.args).toEqual(['exec', 'wrangler', 'deploy', '--env', 'staging']);
    expect([...result.out, ...result.err].join(' ')).not.toContain('never-print-this');
    expect(result.spawned.every(call => !('CLOUDFLARE_API_TOKEN' in call.env))).toBe(true);
  });

  it.each(['preflight', 'migrations'])('stops after the second 7403 failure in %s', phase => {
    const prefix = phase === 'migrations' ? [{ status: 0 }] : [];
    const result = fakeDeploy(['production'], { results: [...prefix, { status: 3, stdout: 'CODE7403' }, { status: 9, stderr: 'code: 7403' }] });
    expect(result.code).toBe(9);
    expect(result.waits).toEqual([5000]);
    expect(result.spawned).toHaveLength(prefix.length + 2);
    expect(result.spawned.some(call => call.args.includes('deploy'))).toBe(false);
  });

  it.each(['preflight', 'migrations'])('never retries other failures in %s', phase => {
    const prefix = phase === 'migrations' ? [{ status: 0 }] : [];
    for (const stderr of ['[code: 7404]', 'row count: 7403', 'code: 17403']) {
      const result = fakeDeploy(['staging'], { results: [...prefix, { status: 7, stderr }] });
      expect(result.code).toBe(7);
      expect(result.waits).toEqual([]);
      expect(result.spawned).toHaveLength(prefix.length + 1);
    }
  });

  it('surfaces non-retryable errors and successful progress with credentials redacted', () => {
    const diagnostics = `Migration 0001 applied
Authorization: Bearer auth-value
Bearer bearer-value
{
      "authorization": "quoted\nheader-value",
      "access_token": "access-value",
      "refresh_token": "refresh\nvalue",
      "client_secret": "client\\\"quoted\\\"value"
    }
CLOUDFLARE_API_TOKEN=inline-value
password='multiline
password-value'
environment-value`;
    const result = fakeDeploy(['staging'], {
      env: { SERVICE_API_KEY: 'environment-value' },
      results: [{ status: 0, stdout: diagnostics }, { status: 7, stderr: 'SQL syntax error near TABLE [code: 7404]' }],
    });
    expect(result.code).toBe(7);
    expect(result.waits).toEqual([]);
    const output = [...result.out, ...result.err].join('\n');
    expect(output).toContain('Migration 0001 applied');
    expect(output).toContain('SQL syntax error near TABLE [code: 7404]');
    for (const secret of ['auth-value', 'header-value', 'bearer-value', 'access-value', 'refresh', 'client\\"quoted', 'inline-value', 'password-value', 'environment-value']) {
      // Credential field names remain useful, so check values rather than their names.
      if (secret === 'refresh') expect(output).not.toContain('refresh\nvalue');
      else expect(output).not.toContain(secret);
    }
  });

  it('redacts credentials inside double-encoded JSON without hiding ordinary short values', () => {
    const payload = {
      access_token: 'nested-access-value', refresh_token: 'nested-refresh\nvalue',
      client_secret: 'nested-"quoted"-value', authorization: 'Bearer nested-auth-value',
      progress: 'Migration completed',
    };
    const encoded = JSON.stringify(JSON.stringify(payload));
    const result = fakeDeploy(['staging'], {
      env: { SERVICE_API_KEY: 'environment-secret-value', SHORT_SECRET: 'applied' },
      results: [{ status: 7, stderr: `API rejected payload ${encoded}\nMigration applied\n${JSON.stringify(JSON.stringify('environment-secret-value'))}` }],
    });
    const output = [...result.out, ...result.err].join('\n');
    expect(output).toContain('API rejected payload');
    expect(output).toContain('Migration completed');
    expect(output).toContain('Migration applied');
    for (const secret of ['nested-access-value', 'nested-refresh', 'nested-', 'environment-secret-value']) expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
    expect(result.waits).toEqual([]);
  });

  it('shows redacted diagnostics from the initial and retried D1 attempts', () => {
    const result = fakeDeploy(['staging'], { results: [
      { status: 1, stderr: 'Unauthorized [code: 7403] token=initial-value' },
      { status: 0, stdout: 'SELECT 1 completed token=retry-value' },
      { status: 0, stdout: 'All migrations applied' },
    ] });
    expect(result.code).toBe(0);
    expect(result.err).toContain('Unauthorized [code: 7403] token=[REDACTED]');
    expect(result.out).toContain('SELECT 1 completed token=[REDACTED]');
    expect(result.out).toContain('All migrations applied');
  });

  it('dry runs perform no D1 preflight, migration, or wait even with 7403 output', () => {
    const result = fakeDeploy(['staging', '--dry-run'], { results: [{ status: 7, stderr: 'code: 7403' }] });
    expect(result.spawned).toHaveLength(1);
    expect(result.spawned[0]!.args).toContain('deploy');
    expect(result.waits).toEqual([]);
  });

  it('deploy.mjs itself is only runDeploy wired to the real process, fs and child_process', () => {
    expect(deployScriptSource).toContain("import { runDeploy } from './deployCore.mjs';");
    expect(deployScriptSource).toMatch(/process\.exit\(runDeploy\(\{/);
    expect(deployScriptSource).toContain('argv: process.argv,');
    expect(deployScriptSource).toContain('spawn: spawnSync,');
    // No second code path that could spawn wrangler without the guard.
    expect(deployScriptSource.match(/spawnSync/g)).toHaveLength(2);
    expect(deployScriptSource).not.toContain('wrangler deploy');
    expect(deployScriptSource).not.toContain("'deploy'");
  });
});
