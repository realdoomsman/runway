// GET /api/stats and the WS hello share one 30-second memo of Services.stats() (SPEC §8.15).
// Each scheduler-driven `stats` broadcast refreshes it, so HTTP readers are never staler than the socket.
import type { GlobalStats } from '@runway/shared';
import type { Deps } from '../core/interfaces.js';
import { servicesOf } from './context.js';

export const STATS_TTL_MS = 30_000;

export interface StatsCache {
  get(): Promise<GlobalStats>;
  close(): void;
}

export function createStatsCache(deps: Deps, ttlMs = STATS_TTL_MS): StatsCache {
  let cached: { stats: GlobalStats; at: number } | null = null;
  let inflight: Promise<GlobalStats> | null = null;
  const offBus = deps.bus.on('stats', (msg) => {
    cached = { stats: msg.stats, at: Date.now() };
  });

  return {
    get() {
      if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.stats);
      if (inflight) return inflight;
      inflight = servicesOf(deps).stats()
        .then((stats) => {
          cached = { stats, at: Date.now() };
          return stats;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    close: offBus,
  };
}
