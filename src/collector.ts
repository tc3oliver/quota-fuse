import type { Config, Group } from './config.ts';
import { utcDay, unrestrictedModels } from './config.ts';
import { Ledger, LedgerError } from './ledger.ts';
import { groupForUnrestrictedModel } from './model-groups.ts';

export interface CollectOptions { fetchImpl?: typeof fetch; now?: Date; adminKey?: string }
function whole(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }
/** Organization-aware shared-quota collection.
 *
 * The org complimentary pool is SHARED with production services that bypass
 * the proxy. The collector queries the FULL organization usage
 * (group_by=model,project_id), splits each group into proxy scope
 * (config.dataSharing.projectId) and external scope (all other projects),
 * and publishes both atomically. External consumption is legitimate and
 * never an invariant failure; it only tightens subsequent admission via the
 * ledger's effective_used formula.
 *
 * The collector always attempts its read-only poll — even while the proxy is
 * PAUSED, EXHAUSTED, or under MANUAL_HOLD — so recovery is driven by fresh
 * trusted observations, not by operator restarts. API failures preserve the
 * last valid checkpoint (never fabricated as zero) and record the attempt.
 * Sticky operator/invariant holds (MANUAL_REVIEW, ACTUAL_EXCEEDS_RESERVED,
 * watermark regression, unverified baseline) are never auto-cleared.
 *
 * NOTE: a 120s poll interval is only an update frequency. Official
 * statistics may lag; admission adds externalSafetyReserve and never treats
 * the Usage API as a real-time free-balance oracle.
 */
export async function collectOnce(config: Config, ledger: Ledger, options: CollectOptions = {}): Promise<{ proxy: Record<Group, number>; external: Record<Group, number> }> {
  const now = options.now ?? new Date();
  const day = utcDay(now);
  const attemptAt = now;
  try {
    const key = options.adminKey ?? process.env.OPENAI_ADMIN_KEY;
    if (!key) throw new Error('Missing collector admin credential');
    const today = Math.floor(Date.parse(day + 'T00:00:00Z') / 1000);
    const end = Math.floor(now.getTime() / 1000);
    const proxy: Record<Group, number> = { premium: 0, economy: 0 };
    const external: Record<Group, number> = { premium: 0, economy: 0 };
    if (end <= today) throw new Error('Collector must start after UTC midnight');
    const openMode = unrestrictedModels(config);
    const groups = new Map<string, Group>([...config.quotas.premium.models.map((m): [string, Group] => [m, 'premium']), ...config.quotas.economy.models.map((m): [string, Group] => [m, 'economy'])]);
    const fetchImpl = options.fetchImpl ?? fetch;
    let cursor: string | null = null;
    const visited = new Set<string>();
    let sawBucket = false;
    // Network polling holds NO SQLite write lock: all parsing/aggregation
    // happens on local variables. Only the final publish takes one short
    // atomic transaction (see Ledger.publishSharedUsage).
    const seenRows = new Set<string>();
    for (let index = 0; index < 100; index++) {
      const u = new URL(config.upstream.baseUrl + '/organization/usage/completions');
      u.searchParams.set('start_time', String(today));
      u.searchParams.set('end_time', String(end));
      u.searchParams.set('bucket_width', '1d');
      u.searchParams.append('group_by', 'model');
      u.searchParams.append('group_by', 'project_id');
      u.searchParams.set('limit', '1');
      if (cursor) u.searchParams.set('page', cursor);
      const resp = await fetchImpl(u, { headers: { 'Authorization': `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw new Error('Admin Usage API unsuccessful');
      const json: any = await resp.json();
      if (json?.object !== 'page' || !Array.isArray(json.data) || typeof json.has_more !== 'boolean') throw new Error('Incomplete usage API response');
      for (const bucket of json.data) {
        if (bucket?.object !== 'bucket' || !whole(bucket.start_time) || bucket.start_time !== today || !whole(bucket.end_time) || bucket.end_time <= today || !Array.isArray(bucket.results)) throw new Error('Invalid usage day bucket');
        sawBucket = true;
        for (const row of bucket.results) {
          // Every row must be attributable to a known project scope.
          if (!row || typeof row.project_id !== 'string' || !row.project_id || typeof row.model !== 'string') throw new Error('Unattributable usage row detected');
          // Mirror Proxy exactly: the whitelist is only an admission filter
          // under official_v1; group accounting comes from the official ID map.
          // Legacy configurations retain their original operator-supplied groups.
          // Unknown models are NEVER assumed free-eligible: fail closed so an
          // operator reviews model mapping before admission resumes.
          const group = !openMode && !groups.has(row.model) ? undefined
            : config.dataSharing.modelGroupAccounting === 'official_v1'
              ? groupForUnrestrictedModel(row.model)
              : openMode ? 'premium' : groups.get(row.model);
          if (!group) throw new Error('Model outside the optional whitelist observed in org usage');
          if (!whole(row.input_tokens) || !whole(row.output_tokens)) throw new Error('Untrustworthy official token count');
          // Cross-page duplicate guard: the same (model, project) cell twice
          // in one collection cycle indicates overlapping pagination or a
          // malformed aggregate. Refuse rather than double-count.
          const cell = `${row.model}\u0000${row.project_id}`;
          if (seenRows.has(cell)) throw new Error('Duplicate usage cell across pages');
          seenRows.add(cell);
          const tokens = row.input_tokens + row.output_tokens;
          if (!Number.isSafeInteger(tokens)) throw new Error('Overflow in usage sum');
          if (row.project_id === config.dataSharing.projectId) {
            proxy[group] += tokens;
            if (!Number.isSafeInteger(proxy[group])) throw new Error('Overflow in usage sum');
          } else {
            // External production traffic shares the same org pool. Record,
            // do not reject: admission absorbs it via effective_used.
            external[group] += tokens;
            if (!Number.isSafeInteger(external[group])) throw new Error('Overflow in usage sum');
          }
        }
      }
      if (!json.has_more) {
        if (!sawBucket) throw new Error('Missing official day bucket (cannot assume zero usage)');
        ledger.publishSharedUsage(day, proxy, external, now);
        return { proxy, external };
      }
      if (typeof json.next_page !== 'string' || !json.next_page || visited.has(json.next_page)) throw new Error('Broken pagination');
      visited.add(json.next_page);
      cursor = json.next_page;
    }
    throw new Error('Pagination safety cap reached');
  } catch (e) {
    // Set/preserve paused state even for mid-pagination or authentication failures.
    // Never clobber MANUAL_REVIEW or a prior accounting-invariant failure.
    // Never treat failure as zero usage: watermarks are untouched. Preserve
    // the machine-readable cause (LedgerError code) for poll diagnostics.
    const code = e instanceof LedgerError ? e.code
      : e instanceof Error ? (/^[A-Z_]{1,60}$/.test(e.message) ? e.message : 'COLLECTOR_UNVERIFIED') : 'COLLECTOR_UNVERIFIED';
    try {
      for (const group of ['premium', 'economy'] as const) {
        try { ledger.recordPollAttempt(day, group, attemptAt, code); } catch { /* diagnostics only */ }
      }
      ledger.pauseCollectorFailure(code);
    } catch { /* DB failures already fail closed */ }
    throw e;
  }
}
