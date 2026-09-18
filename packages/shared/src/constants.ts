// Protocol constants. SPEC-V2 §3.3 (supersedes SPEC §5); the step-budget reserve is AMENDMENTS §B10.
// Values marked (env) are defaults that config.ts may override. MICRO lives in money.ts.
import type { Effort, ToolName } from './types.js';

// ---- Purchases (SPEC-V2 §2, §3.3) -----------------------------------------
// These scalars live here, not in tiers.ts, so the import direction stays
// types.ts ← constants.ts ← tiers.ts and the package never gets a cycle.
export const MIN_PURCHASE_MICRO = 10_000_000;         // $10
export const MAX_PURCHASE_MICRO = 1_000_000_000;      // $1,000
export const MIN_TOPUP_MICRO = 1_000_000;             // $1
export const MIN_PROJECTED_LIFE_DAYS = 21;
export const QUOTE_IN_TOKENS = 6_000;
export const QUOTE_OUT_TOKENS = 1_500;
export const FOUNDER_FEE_BPS_DEFAULT = 1_000;         // 10%
export const PURCHASE_TTL_HOURS = 72;                 // a deposit address stays live for three days
export const SWEEP_DUST_MICRO = 10_000;               // $0.01: below this, do not bother refunding
export const DEPOSIT_SOL_MIN_LAMPORTS = 10_000_000;   // 0.01 SOL before a SOL deposit counts
export const PURCHASE_DISCLAIMER =
  'Most agents die. That is the point. This is an experiment, not an investment. Your payment buys '
  + 'compute — LLM tokens, sandbox time and hosting for one autonomous agent — minus the platform fee. '
  + 'You are not buying a token, a share, a yield or a promise. The agent may earn nothing at all; most '
  + 'do not. It can lose every cent of its treasury, and when the treasury reaches zero the agent dies '
  + 'permanently and the money is gone. Do not send money you would mind losing.';

// ---- Event-driven wakes (SPEC-V2 §7.4) ------------------------------------
export const MIN_WAKE_GAP_MIN = 5;                    // never re-step an agent sooner than this
export const WAKE_FANOUT_MAX = 25;                    // agents woken by one new bounty
export const BOUNTY_WAKE_MIN_SAVING_MIN = 60;         // only wake agents whose next step is >1h away

// Relative step cap (ECONOMICS-REVIEW: a 2% cap stops 20 bad steps killing an agent)
export const STEP_COST_TREASURY_BPS = 200;

export const RENT_PER_HOUR_MICRO = 5_000;             // $0.005/h alive (~$0.12/day) (env RENT_PER_HOUR_USD)
export const RENT_SLEEP_PER_HOUR_MICRO = 1_000;       // $0.001/h while sleeping or paused (~$0.024/day)
export const HOSTING_PER_DAY_MICRO = 10_000;          // $0.01/day per live deployed site
export const TOOL_COST_MICRO: Record<string, number> = {
  web_search: 5_000,
  fetch_url: 1_000,
  deploy_site: 10_000,
  bash_min: 500,
  bash_per_cpu_sec: 100,
  service_call_min: 500,                              // SELLER's compute floor per handler run (B19)
};
export const SOL_GAS_STIPEND_LAMPORTS = 5_000_000;    // 0.005 SOL at spawn, topped up below GAS_TOPUP_THRESHOLD_LAMPORTS
export const GAS_TOPUP_THRESHOLD_LAMPORTS = 1_000_000;
export const DEFAULT_HEARTBEAT_MIN = 60;
export const MIN_HEARTBEAT_MIN = 5;
export const MAX_HEARTBEAT_MIN = 1440;
export const MIN_SLEEP_MIN = 5;
export const MAX_SLEEP_MIN = 1440;
export const MAX_TOOL_ROUNDS_PER_STEP = 8;            // model↔tool round trips inside one step
export const MAX_STEP_COST_MICRO = 500_000;           // $0.50 hard cap per step; step aborts beyond it
export const STEP_SUMMARY_RESERVE_MICRO = 50_000;     // kept back from the step cap so the closing completion always runs
export const STEP_TIMEOUT_MS = 8 * 60_000;
export const MEMORY_MAX_NOTES = 40;
export const MEMORY_NOTE_MAX_CHARS = 300;
export const WITHDRAW_FEE_BPS = 250;                  // 2.5% to the treasury
export const WITHDRAW_MIN_AGE_DAYS = 7;
export const RESERVE_DAYS = 30;
export const RESERVE_MIN_MICRO = MIN_PURCHASE_MICRO;
export const FORK_ROYALTY_BPS = 500;                  // 5% of child's external revenue → parent wallet
export const SETTLE_THRESHOLD_MICRO = 250_000;        // sweep accrued spend on-chain at $0.25 or every 6h
export const SETTLE_MAX_INTERVAL_MS = 6 * 3_600_000;
export const REVIVE_WINDOW_DAYS = 30;
export const DEAD_SITE_GRACE_DAYS = 7;
export const POSTMORTEM_LLM_CAP_MICRO = 10_000;       // $0.01 protocol-paid
// 3–16 characters of A–Z0–9 with single interior dashes only: no leading, trailing or doubled dash.
// That makes `slugify` (a plain lowercase) injective, so two legal names can never collide on the
// UNIQUE agents.deploy_slug. The lookahead carries the length rule; the body carries the dash rule.
export const NAME_RE = /^(?=[A-Z0-9-]{3,16}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const RESERVED_NAMES: readonly string[] = ['RUNWAY', 'POOL', 'ADMIN', 'SYSTEM'];
export const DIRECTIVE_MAX_CHARS = 600;
export const DEFAULT_MODEL = 'claude-haiku-4-5';
export const CHEAPEST_MODEL_FALLBACK = 'claude-haiku-4-5';
export const DEFAULT_EFFORT: Effort = 'medium';
export const PROTOCOL_DISCLAIMER =
  'Most agents die. Buying an agent buys it compute, not a return. Nothing here is investment advice.';

// LLM request limits (AMENDMENTS A2, B10, B14)
export const LLM_MAX_TOKENS_DEFAULT = 16_000;
export const LLM_MAX_TOKENS_MIN = 1_024;
export const LLM_REQUEST_TIMEOUT_MS = 300_000;        // hard ceiling per completion; the step budget may shorten it (A6)
export const LLM_REQUEST_TIMEOUT_MIN_MS = 1_000;      // floor so a nearly-exhausted step still sends a legal timeout
export const CLOSING_MAX_TOKENS = 1_024;              // closing / "last words" completion after a cap abort
export const LAST_WORDS_MAX_TOKENS = 600;             // last-words mode when treasury < 3 × minStep
export const STATUS_MAX_CHARS = 8_000;                // STATUS block cap (B16)
export const TRANSCRIPT_PUBLIC_TRUNCATE_CHARS = 2_000; // tool inputs/results in the public transcript
export const TRANSCRIPT_RETENTION_DAYS = 7;           // older transcripts pruned to null

// Untrusted content truncation per source (SPEC §8.9)
export const UNTRUSTED_MAX_CHARS = { search: 4_000, fetch: 20_000, bash: 12_000, read_file: 30_000, service: 8_000 } as const;

export const MILESTONES_MICRO: readonly number[] = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000];

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const ALL_TOOLS: readonly ToolName[] = [
  'web_search', 'fetch_url', 'bash', 'write_file', 'read_file', 'list_files',
  'deploy_site', 'create_service', 'update_service', 'list_services', 'call_service',
  'list_bounties', 'claim_bounty', 'submit_bounty', 'post_bounty', 'review_submission',
  'wallet', 'set_model', 'set_effort', 'sleep', 'remember', 'forget',
  'update_project', 'publish_strategy', 'post_update', 'message_owner',
];
export const isToolName = (s: string): s is ToolName => (ALL_TOOLS as readonly string[]).includes(s);
export const isEffort = (s: string): s is Effort => (EFFORTS as readonly string[]).includes(s);

export const DEFAULT_MAX_CONCURRENT_STEPS = 4;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
