import type { Config, Group } from './config.ts';
import { utcDay } from './config.ts';
import { Ledger } from './ledger.ts';

export interface CollectOptions { fetchImpl?: typeof fetch; now?: Date; adminKey?: string }
function whole(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }
export async function collectOnce(config: Config, ledger: Ledger, options: CollectOptions = {}): Promise<Record<Group,number>> {
  ledger.setPause('COLLECTOR_REFRESHING');
  try {
    const key = options.adminKey ?? process.env.OPENAI_ADMIN_KEY;
    if (!key) throw new Error('Missing collector admin credential');
    const now = options.now ?? new Date();
    const day = utcDay(now);
    const today = Math.floor(Date.parse(day + 'T00:00:00Z') / 1000);
    const end = Math.floor(now.getTime() / 1000);
    const sums: Record<Group, number> = { premium: 0, economy: 0 };
    if (end <= today) throw new Error('Collector must start after UTC midnight');
    const groups = new Map<string, Group>([...config.quotas.premium.models.map((m): [string, Group] => [m, 'premium']), ...config.quotas.economy.models.map((m): [string, Group] => [m, 'economy'])]);
    const fetchImpl = options.fetchImpl ?? fetch;
    let cursor: string | null = null;
    const visited = new Set<string>();
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
        if (!whole(bucket.start_time) || bucket.start_time !== today || !Array.isArray(bucket.results)) throw new Error('Invalid usage day bucket');
        for (const row of bucket.results) {
          // Unknown/other project usage may consume the same organization-level incentive: pause.
          if (!row || row.project_id !== config.upstream.projectId || typeof row.model !== 'string') throw new Error('Unattributed or side-channel usage detected');
          const group = groups.get(row.model);
          if (!group) throw new Error('New or unreviewed model observed in org usage');
          if (!whole(row.input_tokens) || !whole(row.output_tokens)) throw new Error('Untrustworthy official token count');
          sums[group] += row.input_tokens + row.output_tokens;
          if (!Number.isSafeInteger(sums[group])) throw new Error('Overflow in usage sum');
        }
      }
      if (!json.has_more) {
        for (const group of ['premium','economy'] as const) ledger.recordObservation(day, group, sums[group], now);
        ledger.setPause(null);
        return sums;
      }
      if (typeof json.next_page !== 'string' || !json.next_page || visited.has(json.next_page)) throw new Error('Broken pagination');
      visited.add(json.next_page);
      cursor = json.next_page;
    }
    throw new Error('Pagination safety cap reached');
  } catch (e) {
    // Set/preserve paused state even for mid-pagination or authentication failures.
    try { ledger.setPause('COLLECTOR_UNVERIFIED'); } catch { /* DB failures already fail closed */ }
    throw e;
  }
}
