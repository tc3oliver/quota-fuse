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
/** Persisted proof that an incomplete generation's token accounting is final. */
export interface IncompleteSettlement {
  responseId: string; reason: 'max_output_tokens'; inputTokens: number; outputTokens: number
}
export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const migration = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../migrations/001_initial.sql'), 'utf8');
const safeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
// A healthy collector may clear ONLY these known transport/readiness pauses.
// Invariant failures, operator holds and unrecognized reasons remain sticky.
const collectorRecoverable = new Set<string | null>([
  null, 'COLLECTOR_NOT_VERIFIED', 'COLLECTOR_UNVERIFIED', 'COLLECTOR_DOWN',
  'COLLECTOR_REFRESHING' // recovery from an older interrupted deployment
]);
const collectorInvariantFailures = new Set([
  'ACTUAL_EXCEEDS_RESERVED', 'UNACCOUNTED_OFFICIAL_USAGE',
  'OFFICIAL_WATERMARK_REGRESSION', 'ANCHOR_UNVERIFIED'
]);

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
    this.db.exec(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../migrations/003_dispatched_day_reviews.sql'), 'utf8'));
    this.db.exec(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../migrations/004_incomplete_settlements.sql'), 'utf8'));
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
      localAgentTools: true,
      // Backward-compatible fingerprint: existing ledgers keep legacy
      // premium-only classification until an audited policy transition.
      ...(config.dataSharing.modelGroupAccounting === 'official_v1'
        ? {modelGroupAccounting:'official_v1'} : {}) });
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
  /**
   * Initial setup may need a Project/tier choice after the Proxy has created
   * an EMPTY, PAUSED SQLite ledger. Allow a policy rebind only when absolutely
   * no usage, observations, or manual reconciliation history exists.
   * Caller must hold both proxy and collector instance locks.
   */
  rebindPristinePolicy(config: Config): void {
    this.tx(() => {
      const paused = this.db.prepare('SELECT paused_reason FROM guard_control WHERE id=1').get() as {paused_reason:string|null}|undefined;
      if (!paused || paused.paused_reason === null)
        throw new LedgerError('POLICY_CHANGED', 'Cannot change a running or unpaused ledger policy');
      for (const name of ['reservations','observations','reconciliation_audit'] as const) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM ' + name).get() as {n:number};
        if (count.n !== 0)
          throw new LedgerError('POLICY_CHANGED', 'Ledger already contains usage or audit history: operator reconciliation required');
      }
      const next = this.policyHash(config);
      this.db.prepare('INSERT INTO policy_fingerprint(id,sha256) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256').run(next);
    });
  }
  /**
   * Explicit cross-day cutover from legacy Premium-only to exact-ID grouping.
   * Never relabels history. Today must be EMPTY, no pending older uncertainty,
   * and both services stopped. The caller writes config.json after success.
   */
  upgradeOfficialGroupAccounting(oldConfig: Config, nextConfig: Config,
      operator: string, evidence: string, now = new Date()): void {
    if (oldConfig.dataSharing.modelGroupAccounting === 'official_v1' ||
        nextConfig.dataSharing.modelGroupAccounting !== 'official_v1' ||
        !/^[a-zA-Z0-9_.@-]{3,100}$/.test(operator) ||
        evidence.trim().length < 80 || evidence.length > 4096)
      throw new LedgerError('INVALID_EVIDENCE', 'Explicit accounting version and detailed independent evidence required');
    this.tx(() => {
      if (!this.isPaused()) throw new LedgerError('PAUSE_REQUIRED', 'Collector and Proxy must be stopped and ledger paused');
      const day = utcDay(now);
      if (this.hasCrossDayUnknown(day))
        throw new LedgerError('PRIOR_DAY_UNKNOWN', 'Unaudited previous-day reservations prohibit accounting changes');
      for (const table of ['reservations','observations'] as const) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE utc_day>=?').get(day) as {n:number};
        if (count.n) throw new LedgerError('DAY_ALREADY_STARTED','Current UTC day has persisted usage or baseline; wait until an EMPTY new UTC day');
      }
      const record = this.db.prepare('SELECT sha256 FROM policy_fingerprint WHERE id=1').get() as {sha256:string}|undefined;
      const oldHash=this.policyHash(oldConfig),newHash=this.policyHash(nextConfig);
      if (!record || record.sha256!==oldHash || oldHash===newHash)
        throw new LedgerError('POLICY_CHANGED','Unexpected accounting fingerprint; do not override current policy');
      this.db.prepare('UPDATE policy_fingerprint SET sha256=? WHERE id=1').run(newHash);
      this.db.prepare(`INSERT INTO accounting_migration_audit
         (operator,evidence,effective_utc_day,from_fingerprint,to_fingerprint,created_at)
         VALUES(?,?,?,?,?,?)`).run(operator,evidence,day,oldHash,newHash,now.toISOString());
    });
  }
  pauseReason(): string | null { return (this.db.prepare('SELECT paused_reason FROM guard_control WHERE id=1').get() as {paused_reason:string|null}).paused_reason; }
  isPaused(): boolean { return this.pauseReason() !== null; }
  setPause(reason: string | null): void {
    this.tx(() => this.db.prepare('UPDATE guard_control SET paused_reason=? WHERE id=1').run(reason));
  }
  /** Maintenance may pause a READY ledger, but must never erase a pre-existing
   * collector failure or an operator hold (including on a failed audit). */
  enterManualReview(): void {
    this.tx(() => this.db.prepare("UPDATE guard_control SET paused_reason='MANUAL_REVIEW' WHERE id=1 AND paused_reason IS NULL").run());
  }
  observation(day: string, group: Group): { official_high_watermark: number; anchor_tokens: number | null; reconciled_at: string } | undefined {
    return this.db.prepare('SELECT official_high_watermark, anchor_tokens, reconciled_at FROM observations WHERE utc_day=? AND group_name=?').get(day, group) as any;
  }
  /** No network calls or long-running work are performed while holding a write lock. */
  private validateObservation(day: string, group: Group, tokens: number, at: Date): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !safeInt(tokens) || !Number.isFinite(at.getTime()))
      throw new LedgerError('INVALID_OBSERVATION', 'Invalid official reading');
    const old = this.observation(day, group);
    if (old && tokens < old.official_high_watermark)
      throw new LedgerError('OFFICIAL_WATERMARK_REGRESSION', 'Official reading decreased');
    if (old && old.anchor_tokens === null)
      throw new LedgerError('ANCHOR_UNVERIFIED', 'Legacy checkpoint cannot be trusted without a verified reconciliation baseline');
    if (!old) {
      const present = this.db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE utc_day=? AND group_name=?').get(day, group) as {n:number};
      if (present.n) throw new LedgerError('ANCHOR_UNVERIFIED', 'Cannot initialize a baseline after local requests were admitted');
    }
    if (at.getTime() > Date.now() + 5000) throw new LedgerError('CLOCK_SKEW', 'Future collector checkpoint');
    if (old) {
      const { settled, outstanding } = this.usage(day, group);
      const knownUpperBound = old.anchor_tokens! + settled + outstanding;
      if (!Number.isSafeInteger(knownUpperBound) || tokens > knownUpperBound)
        throw new LedgerError('UNACCOUNTED_OFFICIAL_USAGE', 'Official reading exceeds verified baseline plus local upper bound');
    }
  }
  private saveObservation(day: string, group: Group, tokens: number, at: Date): void {
    this.db.prepare(`INSERT INTO observations(utc_day,group_name,official_high_watermark,anchor_tokens,reconciled_at) VALUES(?,?,?,?,?)
      ON CONFLICT(utc_day,group_name) DO UPDATE SET official_high_watermark=excluded.official_high_watermark,reconciled_at=excluded.reconciled_at`)
      .run(day, group, tokens, tokens, at.toISOString());
  }
  recordObservation(day: string, group: Group, tokens: number, at = new Date()): void {
    this.tx(() => {
      this.validateObservation(day, group, tokens, at);
      this.saveObservation(day, group, tokens, at);
    });
  }
  /** A collector may fetch off-lock while the existing verified watermark is fresh.
   * Publish both groups and clear a recoverable collector pause in ONE transaction,
   * so admission never observes a half-updated pair of official baselines.
   * Any accounting invariant failure pauses in that same transaction. */
  publishOfficialUsage(day: string, sums: Record<Group,number>, at = new Date()): void {
    let validationFailure: LedgerError | null = null;
    this.tx(() => {
      if (!collectorRecoverable.has(this.pauseReason()))
        throw new LedgerError('MANUAL_REVIEW_REQUIRED', 'Collector cannot replace an operator hold or accounting failure');
      try {
        for (const group of ['premium','economy'] as const)
          this.validateObservation(day, group, sums[group], at);
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        validationFailure = e;
        // Commit the failure pause without committing any partially checked
        // observation. Throwing inside the transaction would roll back pause.
        this.db.prepare('UPDATE guard_control SET paused_reason=? WHERE id=1')
          .run(collectorInvariantFailures.has(e.code) ? e.code : 'COLLECTOR_UNVERIFIED');
        return;
      }
      for (const group of ['premium','economy'] as const)
        this.saveObservation(day, group, sums[group], at);
      this.db.prepare('UPDATE guard_control SET paused_reason=NULL WHERE id=1').run();
    });
    if (validationFailure) throw validationFailure;
  }
  /** Fail closed on unavailable/untrustworthy collector data without erasing a
   * stronger pre-existing pause, even if it was set during an in-flight fetch. */
  pauseCollectorFailure(reason = 'COLLECTOR_UNVERIFIED'): void {
    this.tx(() => {
      const current = this.pauseReason();
      if (collectorRecoverable.has(current))
        this.db.prepare('UPDATE guard_control SET paused_reason=? WHERE id=1')
          .run(collectorInvariantFailures.has(reason) ? reason : 'COLLECTOR_UNVERIFIED');
    });
  }
  collectorMayPoll(): boolean { return collectorRecoverable.has(this.pauseReason()); }
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
    // An audited same-day terminal response can establish that a specific
    // dispatched UNKNOWN belongs entirely to its original UTC day. The row
    // stays UNKNOWN and its entire old-day upper bound stays reserved.
    // Other UNKNOWN, PREFLIGHT, PENDING and MANUAL_REVIEW always block.
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM reservations AS r
      LEFT JOIN dispatched_day_reviews AS d ON d.idempotency_key = r.idempotency_key
      WHERE r.utc_day < ? AND r.state IN ('PENDING','UNKNOWN','MANUAL_REVIEW')
        AND NOT (r.state='UNKNOWN' AND r.phase='DISPATCHED'
          AND d.idempotency_key IS NOT NULL AND d.utc_day=r.utc_day
          AND d.reserved=r.reserved)`).get(day) as any;
    return row.n > 0;
  }
  /**
   * Audited day-boundary recovery ONLY when independently evidenced that the
   * dispatched request reached a terminal response BEFORE old-day midnight.
   * This never settles, deletes or releases the UNKNOWN; it only makes its
   * conservative old-day reservation safe to leave in that day.
   * Caller must hold BOTH proxy/collector instance locks.
   */
  reviewDispatchedDay(key: string, operator: string, terminalObservedAt: string, evidence: string, now = new Date()): void {
    if (!/^[a-zA-Z0-9_.@-]{3,100}$/.test(operator) ||
        evidence.trim().length < 80 || evidence.length > 4096 ||
        !Number.isFinite(Date.parse(terminalObservedAt)) || now.getTime() > Date.now() + 5000)
      throw new LedgerError('INVALID_EVIDENCE', 'Named reviewer, UTC terminal timestamp and detailed independent evidence required');
    this.tx(() => {
      if (!this.isPaused()) throw new LedgerError('PAUSE_REQUIRED', 'Stop and pause services before audited rollover review');
      const r = this.find(key);
      if (!r || r.state !== 'UNKNOWN' || r.phase !== 'DISPATCHED')
        throw new LedgerError('INVALID_TRANSITION', 'Only dispatched UNKNOWN requests qualify; request remains UNKNOWN');
      const start = Date.parse(r.utc_day + 'T00:00:00Z');
      const terminal = Date.parse(terminalObservedAt);
      const admitted = Date.parse((this.db.prepare('SELECT admitted_at FROM reservations WHERE idempotency_key=?').get(key) as {admitted_at:string}).admitted_at);
      const updated = Date.parse((this.db.prepare('SELECT updated_at FROM reservations WHERE idempotency_key=?').get(key) as {updated_at:string}).updated_at);
      if (!Number.isFinite(admitted) || !Number.isFinite(updated) ||
          admitted < start || admitted >= start + 86400000 ||
          terminal < admitted || terminal >= start + 86400000 ||
          updated < terminal || updated >= start + 86400000)
        throw new LedgerError('DAY_BOUNDARY_UNVERIFIED', 'Terminal response and UNKNOWN recording must both be within original UTC day');
      // A full UTC day of billing/usage delay is reserved for an independent
      // review of request-specific logs, old/new day Usage, and actual Costs.
      if (now.getTime() < start + 2 * 86400000)
        throw new LedgerError('AUDIT_COOLDOWN', 'At least 24 hours after old UTC day closes is required');
      if (!this.observation(r.utc_day,r.group_name)?.anchor_tokens && this.observation(r.utc_day,r.group_name)?.anchor_tokens !== 0)
        throw new LedgerError('ANCHOR_UNVERIFIED', 'Original UTC-day baseline missing');
      for (const group of ['premium','economy'] as const) {
        const obs = this.observation(utcDay(now),group);
        if (!obs || obs.anchor_tokens === null || now.getTime()-Date.parse(obs.reconciled_at) > 300000 ||
            now.getTime() < Date.parse(obs.reconciled_at))
          throw new LedgerError('COLLECTOR_UNVERIFIED', 'Fresh new-day official baselines required for both groups');
      }
      const existing = this.db.prepare('SELECT idempotency_key FROM dispatched_day_reviews WHERE idempotency_key=?').get(key);
      if (existing) throw new LedgerError('DUPLICATE_REVIEW', 'Rollover review already recorded; never overwrite evidence');
      this.db.prepare(`INSERT INTO dispatched_day_reviews
        (idempotency_key,utc_day,reserved,terminal_observed_at,operator,evidence,reviewed_at)
        VALUES(?,?,?,?,?,?,?)`)
        .run(key,r.utc_day,r.reserved,terminalObservedAt,operator,evidence,now.toISOString());
      this.db.prepare('INSERT INTO reconciliation_audit(idempotency_key,operator,evidence,action,created_at) VALUES(?,?,?,?,?)')
        .run(key,operator,evidence,'BOUNDED_DISPATCHED_UNKNOWN_OLD_DAY_RETAIN_FULL_RESERVE',now.toISOString());
    });
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
  complete(key: string, actual: number, incomplete?: IncompleteSettlement): void {
    if (!safeInt(actual)) throw new LedgerError('INVALID_USAGE', 'Usage must contain nonnegative integer tokens');
    if (incomplete && (incomplete.reason !== 'max_output_tokens' ||
        !/^resp_[a-zA-Z0-9_-]{3,128}$/.test(incomplete.responseId) ||
        !safeInt(incomplete.inputTokens) || !safeInt(incomplete.outputTokens) ||
        !Number.isSafeInteger(incomplete.inputTokens + incomplete.outputTokens) ||
        incomplete.inputTokens + incomplete.outputTokens !== actual))
      throw new LedgerError('INVALID_USAGE', 'Invalid provider incomplete-settlement evidence');
    this.tx(() => {
      const r = this.find(key);
      if (!r || r.state !== 'PENDING' || (incomplete && r.phase !== 'DISPATCHED'))
        throw new LedgerError('INVALID_TRANSITION', 'Cannot settle nonpending or un-dispatched reservation');
      if (actual > r.reserved) {
        this.db.prepare("UPDATE reservations SET state='UNKNOWN',updated_at=? WHERE idempotency_key=?").run(new Date().toISOString(), key);
        // A breached usage bound invalidates further admissions until manual review.
        this.db.prepare("UPDATE guard_control SET paused_reason='ACTUAL_EXCEEDS_RESERVED' WHERE id=1").run();
        // Commit UNKNOWN and PAUSED together, then report the failure.
        return;
      }
      if (incomplete) this.db.prepare(`INSERT INTO incomplete_settlements
        (idempotency_key,upstream_response_id,reason,input_tokens,output_tokens,total_tokens,observed_at)
        VALUES(?,?,?,?,?,?,?)`).run(key,incomplete.responseId,incomplete.reason,
          incomplete.inputTokens,incomplete.outputTokens,actual,new Date().toISOString());
      // COMPLETED refers to the *accounting* lifecycle, not output quality.
      // The separate immutable receipt retains the incomplete generation state.
      this.db.prepare("UPDATE reservations SET state='COMPLETED',actual=?,updated_at=? WHERE idempotency_key=?")
        .run(actual, new Date().toISOString(), key);
    });
    if (this.find(key)?.state === 'UNKNOWN') throw new LedgerError('ACTUAL_EXCEEDS_RESERVED', 'Unexpected provider token usage; reservation retained');
  }
  unknown(key: string): void {
    this.tx(() => this.db.prepare("UPDATE reservations SET state='UNKNOWN',updated_at=? WHERE idempotency_key=? AND state='PENDING'").run(new Date().toISOString(), key));
  }
}
