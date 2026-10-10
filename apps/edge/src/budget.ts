import { DurableObject } from 'cloudflare:workers';
import type { EdgeEnv } from './env';

/**
 * Durable daily budget for the paid routes (CLA-266). ONE instance (`getByName("global")`), SQLite-backed,
 * counters per UTC day:
 *
 *   - five Ask admissions per verified GitHub account per UTC day;
 *   - requests per bucket (`ask`, `block-plan`), refused past the bucket's daily max;
 *   - an Ask dollar ledger: admission reserves an estimate and is refused when
 *     reserved + spent + estimate would exceed the daily dollar cap; once the container answers, the
 *     reservation settles to the real cost (`x-okie-ask-cost-usd`) or keeps the estimate.
 *
 * A reservation whose settle never arrives (isolate died mid-request) stays counted — fail closed.
 * CLA-472: a settle marked unanswered also gives the account's daily Ask back (the bucket count and dollars stand).
 * All methods are synchronous SQL inside one Durable Object, so admission is atomic.
 */

export type BudgetBucket = 'ask' | 'block-plan';

export type AdmitInput = {
  bucket: BudgetBucket;
  /** UTC day `YYYY-MM-DD` (computed by the caller so tests control time). */
  day: string;
  maxRequests: number;
  /** Ask only: dollars reserved at admission and the day's dollar cap. */
  dollars?: { estimate: number; max: number };
  /** Verified account identity, supplied by edge auth, never request JSON. */
  accountId?: string;
};

export type AdmitResult =
  | { ok: true; reservationId?: string }
  | { ok: false; reason: 'requests' | 'dollars' | 'user' | 'identity' };

export type DayUsage = {
  day: string;
  requests: Record<BudgetBucket, number>;
  reservedDollars: number;
  spentDollars: number;
  openReservations: number;
};

const KEEP_DAYS = 14;

function dayMinus(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export class AtlasBudget extends DurableObject<EdgeEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: EdgeEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS user_requests (day TEXT NOT NULL, account_id TEXT NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY (day, account_id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS request_counts (day TEXT NOT NULL, bucket TEXT NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY (day, bucket))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dollar_spent (day TEXT PRIMARY KEY, spent REAL NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dollar_reservations (id TEXT PRIMARY KEY, day TEXT NOT NULL, amount REAL NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ask_admissions (reservation_id TEXT PRIMARY KEY, day TEXT NOT NULL, account_id TEXT NOT NULL)`);
  }

  private requests(day: string, bucket: BudgetBucket): number {
    return (this.sql.exec<{ requests: number }>('SELECT requests FROM request_counts WHERE day = ? AND bucket = ?', day, bucket).toArray()[0]?.requests) ?? 0;
  }

  private spent(day: string): number {
    return (this.sql.exec<{ spent: number }>('SELECT spent FROM dollar_spent WHERE day = ?', day).toArray()[0]?.spent) ?? 0;
  }

  private reserved(day: string): { amount: number; count: number } {
    const row = this.sql.exec<{ amount: number | null; count: number }>('SELECT SUM(amount) AS amount, COUNT(*) AS count FROM dollar_reservations WHERE day = ?', day).toArray()[0];
    return { amount: row?.amount ?? 0, count: row?.count ?? 0 };
  }

  admit(input: AdmitInput): AdmitResult {
    if (input.bucket === 'ask' && (!input.accountId || !/^(?:0|[1-9][0-9]*)$/.test(input.accountId))) return { ok: false, reason: 'identity' };
    const cutoff = dayMinus(input.day, KEEP_DAYS);
    this.sql.exec('DELETE FROM user_requests WHERE day < ?', cutoff);
    if (input.bucket === 'ask') {
      const count = this.sql.exec<{ requests: number }>('SELECT requests FROM user_requests WHERE day = ? AND account_id = ?', input.day, input.accountId!).toArray()[0]?.requests ?? 0;
      if (count >= 5) return { ok: false, reason: 'user' };
    }
    this.sql.exec('DELETE FROM request_counts WHERE day < ?', cutoff);
    this.sql.exec('DELETE FROM dollar_spent WHERE day < ?', cutoff);
    this.sql.exec('DELETE FROM dollar_reservations WHERE day < ?', cutoff);
    this.sql.exec('DELETE FROM ask_admissions WHERE day < ?', cutoff);

    if (this.requests(input.day, input.bucket) + 1 > input.maxRequests) return { ok: false, reason: 'requests' };
    let reservationId: string | undefined;
    if (input.dollars) {
      const committed = this.reserved(input.day).amount + this.spent(input.day);
      if (committed + input.dollars.estimate > input.dollars.max + 1e-9) return { ok: false, reason: 'dollars' };
      reservationId = crypto.randomUUID();
      this.sql.exec('INSERT INTO dollar_reservations (id, day, amount) VALUES (?, ?, ?)', reservationId, input.day, input.dollars.estimate);
    }
    this.sql.exec(
      'INSERT INTO request_counts (day, bucket, requests) VALUES (?, ?, 1) ON CONFLICT (day, bucket) DO UPDATE SET requests = requests + 1',
      input.day,
      input.bucket,
    );
    if (input.bucket === 'ask') this.sql.exec('INSERT INTO user_requests (day, account_id, requests) VALUES (?, ?, 1) ON CONFLICT (day, account_id) DO UPDATE SET requests = requests + 1', input.day, input.accountId!);
    if (input.bucket === 'ask' && reservationId) this.sql.exec('INSERT INTO ask_admissions (reservation_id, day, account_id) VALUES (?, ?, ?)', reservationId, input.day, input.accountId!);
    return reservationId ? { ok: true, reservationId } : { ok: true };
  }

  /**
   * Close a reservation at the real cost (`undefined`/invalid → keep the estimate). Unknown ids are ignored.
   * `unanswered` (CLA-472) also returns the account's daily Ask, once per reservation.
   */
  settle(reservationId: string, actualDollars?: number, unanswered = false): void {
    const admission = this.sql.exec<{ day: string; account_id: string }>('SELECT day, account_id FROM ask_admissions WHERE reservation_id = ?', reservationId).toArray()[0];
    if (admission) {
      this.sql.exec('DELETE FROM ask_admissions WHERE reservation_id = ?', reservationId);
      if (unanswered) this.sql.exec('UPDATE user_requests SET requests = requests - 1 WHERE day = ? AND account_id = ? AND requests > 0', admission.day, admission.account_id);
    }
    const row = this.sql.exec<{ day: string; amount: number }>('SELECT day, amount FROM dollar_reservations WHERE id = ?', reservationId).toArray()[0];
    if (!row) return;
    const amount = typeof actualDollars === 'number' && Number.isFinite(actualDollars) && actualDollars >= 0 ? actualDollars : row.amount;
    this.sql.exec('DELETE FROM dollar_reservations WHERE id = ?', reservationId);
    this.sql.exec(
      'INSERT INTO dollar_spent (day, spent) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET spent = spent + excluded.spent',
      row.day,
      amount,
    );
  }

  usage(day: string): DayUsage {
    const reserved = this.reserved(day);
    return {
      day,
      requests: { ask: this.requests(day, 'ask'), 'block-plan': this.requests(day, 'block-plan') },
      reservedDollars: reserved.amount,
      spentDollars: this.spent(day),
      openReservations: reserved.count,
    };
  }
}
