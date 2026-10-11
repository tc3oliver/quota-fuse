/**
 * A no-credentials OMP integration contract demo. Do NOT use this as an automatic
 * live fallback transport: actual OMP extension APIs and subscription semantics
 * must be verified separately.
 */
export interface WorkItem { id: string; publicOnly: boolean; hasSideEffects: boolean }
export type Provider = 'openai-datashare' | 'codex-plus';
export function chooseAfterQuotaGuard(status: number, reason: string, task: WorkItem): Provider | 'STOP' {
  const denied = ['FREE_QUOTA_EXHAUSTED','FREE_QUOTA_UNVERIFIED','MODEL_NOT_ELIGIBLE'];
  if (!denied.includes(reason) || ![403,429,503].includes(status)) return 'STOP';
  // Only retry at a safe, independently idempotent task boundary.
  if (task.hasSideEffects || !task.publicOnly) return 'STOP';
  return 'codex-plus';
}
if (process.argv[1]?.endsWith('/omp-fallback.ts')) {
  console.log(chooseAfterQuotaGuard(429,'FREE_QUOTA_EXHAUSTED',{id:'readme-review',publicOnly:true,hasSideEffects:false}));
  console.log(chooseAfterQuotaGuard(503,'FREE_QUOTA_UNVERIFIED',{id:'file-write',publicOnly:true,hasSideEffects:true}));
}
