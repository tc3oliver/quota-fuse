import type { Group } from './config.ts';

/**
 * Reviewed static Data Sharing group mapping (2026-10-11).
 * This is NOT an allowlist or an eligibility/zero-cost guarantee.
 * Unknown IDs deliberately fall back to Premium for conservative accounting.
 * Keep this snapshot in sync with the official program terms; do not fetch
 * mutable remote catalogs at runtime.
 * https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai
 */
export const OFFICIAL_PREMIUM_MODELS = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.5-2026-04-23",
  "gpt-5.4-2026-03-05",
  "gpt-5.2-2025-12-11",
  "gpt-5.1-2025-11-13",
  "gpt-5.1-codex",
  "gpt-5-codex",
  "gpt-5-2025-08-07",
  "gpt-5-chat-latest",
  "gpt-4.1-2025-04-14",
  "gpt-4o-2024-05-13",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-11-20",
  "o3-2025-04-16",
  "o1-preview-2024-09-12",
  "o1-2024-12-17"
] as const;
export const OFFICIAL_ECONOMY_MODELS = [
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4-mini-2026-03-17",
  "gpt-5.4-nano-2026-03-17",
  "gpt-5.1-codex-mini",
  "gpt-5-mini-2025-08-07",
  "gpt-5-nano-2025-08-07",
  "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano-2025-04-14",
  "gpt-4o-mini-2024-07-18",
  "o4-mini-2025-04-16",
  "o1-mini-2024-09-12",
  "codex-mini-latest"
] as const;

const premium = new Set<string>(OFFICIAL_PREMIUM_MODELS);
const economy = new Set<string>(OFFICIAL_ECONOMY_MODELS);

/** Classification only; does not establish a model is accessible or free. */
export function groupForUnrestrictedModel(model: string): Group {
  if (economy.has(model)) return 'economy';
  // Verified Premium IDs and ALL unknown/retired/paid model IDs use the
  // smaller token bucket; the latter can still incur actual API charges.
  return 'premium';
}
