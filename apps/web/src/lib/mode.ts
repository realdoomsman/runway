import type { ChainPublic, GlobalStats } from '@runway/shared';

export type ModeLabel = 'DEMO' | 'SIM' | 'DEVNET' | 'MAINNET';

export interface ModeInfo {
  label: ModeLabel;
  /** Env banner copy (D29); null ONLY when money, brains and the colony are all real. */
  banner: string | null;
  /** '.ticker-label' text (D29). */
  tickerLabel: string;
}

type ModeStats = Pick<GlobalStats, 'chain' | 'llm'> & Partial<Pick<GlobalStats, 'demo'>>;

/**
 * The mode line, per AMENDMENTS D29 and the v2 no-fallback rule.
 *
 * The banner is COMPOSED from three independent facts rather than picked from a table, because the
 * three can disagree: real devnet money behind mock brains, real brains over a simulated chain, a
 * seeded demo colony on either. An earlier version keyed only off `chain.mode`, so a devnet run with
 * LLM_PROVIDER=mock showed "DEVNET · CIRCLE TEST USDC" and said nothing at all about the agents being
 * scripted — exactly the "I think I am running for real" state this banner exists to prevent.
 *
 * Every segment states something that has been checked. Nothing is implied by omission except the
 * one case where all three are real, which is the only time the banner is hidden.
 */
export function modeInfo(stats: ModeStats | null): ModeInfo {
  if (!stats) return { label: 'SIM', banner: null, tickerLabel: 'LIVE' };

  const demo = stats.demo === true;
  const memory = stats.chain.mode === 'memory';
  const mainnet = !memory && stats.chain.cluster === 'mainnet-beta';
  const mock = stats.llm.provider === 'mock';

  const segments: string[] = [];
  if (demo) segments.push('DEMO COLONY · SEEDED, NOT REAL CUSTOMERS');
  if (memory) segments.push('SIMULATED CHAIN · NO REAL MONEY');
  else if (!mainnet) segments.push(`${stats.chain.cluster.toUpperCase()} · TEST USDC, NOT REAL MONEY`);
  if (mock) segments.push('MOCK BRAINS · AGENTS ARE SCRIPTED, NOT THINKING');

  const label: ModeLabel = demo ? 'DEMO' : memory ? 'SIM' : mainnet ? 'MAINNET' : 'DEVNET';
  const tickerLabel = demo ? 'LIVE · DEMO' : `LIVE · ${label}`;
  return { label, banner: segments.length > 0 ? segments.join(' · ') : null, tickerLabel };
}

/** Short chain badge text for the topbar: devnet / mainnet / memory. */
export function chainBadge(stats: Pick<GlobalStats, 'chain'> | null): string {
  if (!stats) return '…';
  if (stats.chain.mode === 'memory') return 'memory';
  return stats.chain.cluster === 'mainnet-beta' ? 'mainnet' : stats.chain.cluster;
}

/** RPC endpoint for the wallet ConnectionProvider (devnet until stats arrive). */
export function rpcEndpoint(chain: Pick<ChainPublic, 'mode' | 'cluster'> | null): string {
  const override = import.meta.env.VITE_SOLANA_RPC_URL;
  if (override) return override;
  // Solana mode: talk to the API's own /rpc proxy (server-side Helius key), same origin in prod and
  // vite-proxied in dev. Public cluster RPCs rate-limit/403 browser calls, which surfaced to buyers
  // as a false "No USDC token account for this wallet".
  if (chain?.mode === 'solana' && typeof window !== 'undefined') return `${window.location.origin}/rpc`;
  const cluster = chain?.mode === 'solana' ? chain.cluster : 'devnet';
  return cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : `https://api.${cluster}.solana.com`;
}
