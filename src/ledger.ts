import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utcDay, nextReset, type Config, type Group } from './config.ts';

export interface Reservation {
  phase: 'PREFLIGHT' | 'DISPATCHED';
  idempotency_key: string; request_id: string; body_hash: string; model: string;
  group_name: Group; utc_day: string; reserved: number; actual: number | null; state: string;
}
export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const migration = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../migrations/001_initial.sql'), 'utf8');
const safeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export class Ledger {
  readonly db: DatabaseSync;
  constructor(path: string, options: { recoverPending?: boolean; readOnly?: boolean } = {}) {
    if (!options.readOnly) mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly === true });
    // Two processes may open the ledger together on boot. Install busy_timeout
    // before any migration/DDL (not after it), or one may exit on SQLITE_BUSY.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (options.readOnly) return;
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(migration);
    // Additive migration. Existing checkpoints cannot be safely assigned a historical
    // baseline: NULL anchor deliberately pauses them pending operator reconciliation.
    const columns = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(x=>x.name);
    if (!columns('observations').includes('anchor_tokens')) this.db.exec('ALTER TABLE observations ADD COLUMN anchor_tokens INTEGER CHECK(anchor_tokens >= 0)');
    if (!columns('reservations').includes('phase')) this.db.exec("ALTER TABLE reservations ADD COLUMN phase TEXT NOT NULL DEFAULT 'DISPATCHED' CHECK(phase IN ('PREFLIGHT','DISPATCHED'))");
    this.db.exec(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../migrations/002_reconciliation.sql'), 'utf8'));
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
    if (options.recoverPending !== false) this.recoverPending();
  }
  close(): void { this.db.close(); }
  private tx<T>(fn: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw e;
    }
  }
  recoverPending(): void {
    this.tx(() => this.db.prepare("UPDATE reservations SET state='UNKNOWN', updated_at=? WHERE state='PENDING'").run(new Date().toISOString()));
  }
  private policyHash(config: Config): string {
    const canonical = JSON.stringify({ projectId: config.dataSharing.projectId, dataSharingTier: config.dataSharing.tier,
      groups: config.quotas, safetyPct: config.policy.safetyPct,
      outputCap: config.policy.maxOutputTokens, accountMargin: config.policy.accountMargin,
      counter: config.policy.inputCounter,
      structuredTextVerified: config.policy.structuredTextVerified === true,
      localAgentTools: true });
    return createHash('sha256').update(canonical).digest('hex');
  }
  verifyPolicy(config: Config): void {
    const old = this.db.prepare('SELECT sha256 FROM policy_fingerprint WHERE id=1').get() as any;
    if (!old || old.sha256 !== this.policyHash(config)) throw new LedgerError('POLICY_CHANGED', 'Uninitialized or changed policy; operator reconciliation required');
  }
  assertPolicy(config: Config): void {
    const hash = this.policyHash(config);
    this.tx(() => {
      const old = this.db.prepare('SELECT sha256 FROM policy_fingerprint WHERE id=1').get() as any;
      if (old && old.sha256 !== hash) throw new LedgerError('POLICY_CHANGED', 'Model/quota/project policy changed: operator reconciliation required');
      if (!old) {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as any;
        if (row.n) throw new LedgerError('POLICY_UNINITIALIZED', 'Existing ledger has no policy fingerprint');
        this.db.prepare('INSERT INTO policy_fingerprint(id,sha256) VALUES(1,?)').run(hash);
      }
    });
  }
  pauseReason(): string | null { return (this.db.prepare('SELECT paused_reason FROM guard_control WHERE id=1').get() as {paused_reason:string|null}).paused_reason; }
  isPaused(): boolean { return this.pauseReason() !== null; }
  setPause(reason: string | null): void {
    this.tx(() => this.db.prepare('UPDATE guard_control SET paused_reason=? WHERE id=1').run(reason));
  }
  observation(day: string, group: Group): { official_high_watermark: number; anchor_tokens: number | null; reconciled_at: string } | undefined {
    return this.db.prepare('SELECT official_high_watermark, anchor_tokens, reconciled_at FROM observations WHERE utc_day=? AND group_name=?').get(day, group) as any;
  }
  recordObservation(day: string, group: Group, tokens: number, at = new Date()): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !safeInt(tokens)) throw new LedgerError('INVALID_OBSERVATION', 'Invalid official reading');
    this.tx(() => {
      const old = this.observation(day, group);
      if (old && tokens < old.official_high_watermark) throw new LedgerError('OFFICIAL_WATERMARK_REGRESSION', 'Official reading decreased');
      if (old && old.anchor_tokens === null) throw new LedgerError('ANCHOR_UNVERIFIED', 'Legacy checkpoint cannot be trusted without a verified reconciliation baseline');
      if (!old) {
        const present = this.db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE utc_day=? AND group_name=?').get(day, group) as {n:number};
        if (present.n) throw new LedgerError('ANCHOR_UNVERIFIED', 'Cannot initialize a baseline after local requests were admitted');
      }
      if (at.getTime() > Date.now() + 5000) throw new LedgerError('CLOCK_SKEW', 'Future collector checkpoint');
      if (old) {
        // Every token after a verified exclusive-traffic baseline must fit
        // within locally settled requests or outstanding upper bounds.
        const { settled, outstanding } = this.usage(day, group);
        const knownUpperBound = old.anchor_tokens! + settled + outstanding;
        if (!Number.isSafeInteger(knownUpperBound) || tokens > knownUpperBound)
          throw new LedgerError('UNACCOUNTED_OFFICIAL_USAGE', 'Official reading exceeds verified baseline plus local upper bound');
      }
      this.db.prepare(`INSERT INTO observations(utc_day,group_name,official_high_watermark,anchor_tokens,reconciled_at) VALUES(?,?,?,?,?)
        ON CONFLICT(utc_day,group_name) DO UPDATE SET official_high_watermark=excluded.official_high_watermark,reconciled_at=excluded.reconciled_at`)
        .run(day, group, tokens, tokens, at.toISOString());
    });
  }
  private usage(day: string, group: Group) {
    const s = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state IN ('COMPLETED','RECONCILED') THEN actual ELSE 0 END),0) AS settled,
      COALESCE(SUM(CASE WHEN state IN ('PENDING','UNKNOWN','MANUAL_REVIEW') THEN reserved ELSE 0 END),0) AS outstanding,
      COALESCE(SUM(CASE WHEN state='UNKNOWN' THEN reserved ELSE 0 END),0) AS unknown
      FROM reservations WHERE utc_day=? AND group_name=?`).get(day, group) as any;
    return { settled: Number(s.settled), outstanding: Number(s.outstanding), unknown: Number(s.unknown) };
  }
  snapshot(config: Config, day: string, group: Group, now = new Date()) {
    const obs = this.observation(day, group);
    const { settled, outstanding, unknown } = this.usage(day, group);
    const safetyCap = Math.floor(config.quotas[group].dailyTokens * config.policy.safetyPct / 100);
    // Anchor = first vetted official snapshot BEFORE any local request of this group/day.
    // ALL subsequent local completions AND reservations count against that baseline.
    // Later official totals can include these same local requests, so MAX avoids
    // double-counting. This is conditional on exclusive-org traffic and a verified
    // complete baseline; Admin Usage is neither real-time nor a free-balance oracle.
    const anchored = obs?.anchor_tokens !== null && obs?.anchor_tokens !== undefined;
    const committed = anchored
      ? Math.max(obs.official_high_watermark, (obs!.anchor_tokens as number) + settled + outstanding)
      : safetyCap;
    if (!Number.isSafeInteger(committed)) throw new LedgerError('INVALID_USAGE', 'Usage overflow');
    const fresh = anchored && !!obs && now.getTime() - Date.parse(obs.reconciled_at) >= 0 && now.getTime() - Date.parse(obs.reconciled_at) <= config.policy.reconcileMaxAgeSeconds * 1000;
    return {
      group, utc_day: day, limit: config.quotas[group].dailyTokens, safety_cap: safetyCap,
      admitted_reserved: outstanding, local_settled: settled, official_observed: obs?.official_high_watermark ?? null,
      baseline_observed: obs?.anchor_tokens ?? null,
      estimated_remaining: Math.max(0, safetyCap - committed), confidence: fresh ? 'CONDITIONAL' : 'UNVERIFIED',
      last_reconciled_at: obs?.reconciled_at ?? null, state: fresh ? (committed >= safetyCap ? 'EXHAUSTED' : 'READY') : 'PAUSED_UNVERIFIED',
      next_reset_at: nextReset(day), unknown_reserved: unknown
    };
  }
  hasCrossDayUnknown(day: string): boolean {
    // PENDING requests are also unsafe across UTC rollover: their upstream usage
    // may be attributed to either day, and no new-day budget is released until review.
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE utc_day<? AND state IN ('PENDING','UNKNOWN','MANUAL_REVIEW')").get(day) as any;
    return row.n > 0;
  }
  find(key: string): Reservation | undefined {
    return this.db.prepare('SELECT * FROM reservations WHERE idempotency_key=?').get(key) as unknown as Reservation | undefined;
  }
  admit(config: Config, args: { key: string; hash: string; requestId: string; model: string; group: Group; day: string; reserve: number; now?: Date }): Reservation {
    if (!safeInt(args.reserve) || args.reserve === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(args.day)) throw new LedgerError('INVALID_RESERVATION', 'Invalid reservation');
    return this.tx(() => {
      // Re-check persistent control *inside* the admission transaction. A collector
      // may pause the ledger between the HTTP gate and BEGIN IMMEDIATE.
      if (this.isPaused()) throw new LedgerError('FREE_QUOTA_UNVERIFIED', 'Collector has paused admission');
      const existing = this.find(args.key);
      if (existing) throw new LedgerError(existing.body_hash === args.hash ? 'DUPLICATE_REQUEST' : 'IDEMPOTENCY_CONFLICT', 'Idempotency key is already used; no replay allowed');
      if (this.hasCrossDayUnknown(args.day)) throw new LedgerError('FREE_QUOTA_UNVERIFIED', 'Prior-day reservations require review');
      const view = this.snapshot(config, args.day, args.group, args.now ?? new Date());
      if (view.state === 'PAUSED_UNVERIFIED') throw new LedgerError('FREE_QUOTA_UNVERIFIED', 'Collector checkpoint stale or missing');
      if (args.reserve > view.estimated_remaining) throw new LedgerError('FREE_QUOTA_EXHAUSTED', 'Not enough guarded free-token capacity');
      const at = (args.now ?? new Date()).toISOString();
      this.db.prepare(`INSERT INTO reservations(idempotency_key,request_id,body_hash,model,group_name,utc_day,reserved,actual,state,admitted_at,updated_at)
        VALUES(?,?,?,?,?,?,?,NULL,'PENDING',?,?)`)
        .run(args.key, args.requestId, args.hash, args.model, args.group, args.day, args.reserve, at, at);
      this.db.prepare("UPDATE reservations SET phase='PREFLIGHT' WHERE idempotency_key=?").run(args.key);
      return this.find(args.key)!;
    });
  }
  /** Atomically reduce provisional reservation after a trusted counter and BEFORE generation dispatch. */
  prepareDispatch(config: Config, key: string, inputTokens: number, maxOutput: number, now = new Date()): void {
    if (!safeInt(inputTokens) || !safeInt(maxOutput) || maxOutput < 1) throw new LedgerError('INVALID_USAGE', 'Invalid trusted preflight count');
    const total = inputTokens + maxOutput + config.policy.accountMargin;
    if (!Number.isSafeInteger(total)) throw new LedgerError('INVALID_USAGE', 'Reservation overflow');
    this.tx(() => {
      const r = this.find(key);
      if (!r || r.state !== 'PENDING' || r.phase !== 'PREFLIGHT') throw new LedgerError('INVALID_TRANSITION', 'Generation already dispatched or request no longer pending');
      if (this.isPaused() || utcDay(now) !== r.utc_day || total > r.reserved || this.hasCrossDayUnknown(r.utc_day))
        throw new LedgerError('FREE_QUOTA_UNVERIFIED', 'Cannot safely dispatch after preflight');
      const view = this.snapshot(config, r.utc_day, r.group_name, now);
      if (view.confidence !== 'CONDITIONAL') throw new LedgerError('FREE_QUOTA_UNVERIFIED', 'Collector checkpoint stale');
      this.db.prepare("UPDATE reservations SET phase='DISPATCHED',reserved=?,updated_at=? WHERE idempotency_key=?")
        .run(total, now.toISOString(), key);
    });
  }
  /** Operator-only reviewed recovery; generation was never dispatched. */
  reconcilePreflight(key: string, operator: string, evidence: string): void {
    if (!/^[a-zA-Z0-9_.@-]{3,100}$/.test(operator) || evidence.trim().length < 20 || evidence.length > 2048)
      throw new LedgerError('INVALID_EVIDENCE', 'Named operator and verifiable >=20-char evidence required');
    this.tx(() => {
      if (this.isPaused() === false) throw new LedgerError('PAUSE_REQUIRED', 'Pause admission before manual reconciliation');
      const r = this.find(key);
      if (!r || r.state !== 'UNKNOWN' || r.phase !== 'PREFLIGHT') throw new LedgerError('INVALID_TRANSITION', 'Only an UNKNOWN preflight-only request can be reconciled');
      const when = new Date().toISOString();
      this.db.prepare("UPDATE reservations SET state='RECONCILED',actual=0,updated_at=? WHERE idempotency_key=?").run(when,key);
      this.db.prepare('INSERT INTO reconciliation_audit(idempotency_key,operator,evidence,action,created_at) VALUES(?,?,?,?,?)')
        .run(key,operator,evidence,'VERIFIED_NO_GENERATION_AND_ZERO_BILLABLE_USAGE',when);
    });
  }
  complete(key: string, actual: number): void {
    if (!safeInt(actual)) throw new LedgerError('INVALID_USAGE', 'Usage must contain nonnegative integer tokens');
    this.tx(() => {
      const r = this.find(key);
      if (!r || r.state !== 'PENDING') throw new LedgerError('INVALID_TRANSITION', 'Cannot settle nonpending reservation');
      if (actual > r.reserved) {
        this.db.prepare("UPDATE reservations SET state='UNKNOWN',updated_at=? WHERE idempotency_key=?").run(new Date().toISOString(), key);
        // A breached usage bound invalidates further admissions until manual review.
        this.db.prepare("UPDATE guard_control SET paused_reason='ACTUAL_EXCEEDS_RESERVED' WHERE id=1").run();
        // Commit UNKNOWN and PAUSED together, then report the failure.
        return;
      }
      this.db.prepare("UPDATE reservations SET state='COMPLETED',actual=?,updated_at=? WHERE idempotency_key=?")
        .run(actual, new Date().toISOString(), key);
    });
    if (this.find(key)?.state === 'UNKNOWN') throw new LedgerError('ACTUAL_EXCEEDS_RESERVED', 'Unexpected provider token usage; reservation retained');
  }
  unknown(key: string): void {
    this.tx(() => this.db.prepare("UPDATE reservations SET state='UNKNOWN',updated_at=? WHERE idempotency_key=? AND state='PENDING'").run(new Date().toISOString(), key));
  }
}
