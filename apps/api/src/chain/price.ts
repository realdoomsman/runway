// SOL/USD price: Jupiter's lite price API on mainnet (cached 60s, last good value or env fallback on
// failure), the SOL_PRICE_USD env value everywhere else (SPEC §8.12). Plus the lamports → micro-dollar valuation.
import type { Micro } from '@runway/shared';
import type { Logger } from '../lib/log.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const JUPITER_PRICE_URL = `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`;
export const PRICE_CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

// lamports × usd/SOL → micro-dollars. (lamports / 1e9) × price × 1e6 = lamports × price / 1e3.
export function lamportsToMicro(lamports: number, solPriceUsd: number): Micro {
  return Math.round((lamports * solPriceUsd) / (LAMPORTS_PER_SOL / 1_000_000));
}

export interface SolPriceSource { get(): Promise<number> }

export interface SolPriceOpts {
  cluster: string;
  fallbackUsd: number;
  log: Logger;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export function createSolPriceSource(opts: SolPriceOpts): SolPriceSource {
  const { cluster, fallbackUsd, log } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  if (cluster !== 'mainnet-beta') return { get: async () => fallbackUsd };

  let cached: { value: number; at: number } | null = null;
  let lastGood = fallbackUsd;
  let inflight: Promise<number> | null = null;

  const refresh = async (): Promise<number> => {
    try {
      const value = await fetchJupiterSolPrice(fetchFn);
      lastGood = value;
      cached = { value, at: now() };
      return value;
    } catch (e) {
      log.warn({ err: e, fallbackUsd: lastGood }, 'SOL price fetch failed; using last known value');
      cached = { value: lastGood, at: now() };
      return lastGood;
    }
  };

  return {
    async get() {
      if (cached && now() - cached.at < PRICE_CACHE_MS) return cached.value;
      inflight ??= refresh().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

async function fetchJupiterSolPrice(fetchFn: typeof fetch): Promise<number> {
  const res = await fetchFn(JUPITER_PRICE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jupiter price API responded ${res.status}`);
  const body = (await res.json()) as Record<string, { usdPrice?: unknown } | undefined>;
  const price = body[SOL_MINT]?.usdPrice;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) throw new Error('Jupiter price API returned no SOL price');
  return price;
}
