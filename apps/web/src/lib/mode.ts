import type { ChainPublic, GlobalStats } from '@runway/shared';

export type ModeLabel = 'SIM' | 'DEVNET' | 'MAINNET';

export interface ModeInfo {
  label: ModeLabel;
  /** Env banner copy (D29); null only for mainnet + real router. */
  banner: string | null;
  /** '.ticker-label' text (D29). */
  tickerLabel: string;
}

/** Mode line derived from chain + llm config, per AMENDMENTS D29. */
export function modeInfo(stats: Pick<GlobalStats, 'chain' | 'llm'> | null): ModeInfo {
  if (!stats) return { label: 'SIM', banner: null, tickerLabel: 'LIVE' };
  const mock = stats.llm.provider === 'mock';
  if (stats.chain.mode === 'memory') {
    return { label: 'SIM', banner: 'SIMULATION · IN-MEMORY CHAIN · MOCK LLM · NO REAL MONEY', tickerLabel: 'LIVE · SIM' };
  }
  if (stats.chain.cluster !== 'mainnet-beta') {
    return { label: 'DEVNET', banner: 'DEVNET · CIRCLE TEST USDC · BALANCES ARE NOT REAL MONEY', tickerLabel: 'LIVE · DEVNET' };
  }
  return { label: 'MAINNET', banner: mock ? 'MOCK LLM · AGENTS ARE SCRIPTED' : null, tickerLabel: 'LIVE · MAINNET' };
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
  const cluster = chain?.mode === 'solana' ? chain.cluster : 'devnet';
  return cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : `https://api.${cluster}.solana.com`;
}
