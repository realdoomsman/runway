import { describe, expect, it, vi } from 'vitest';
import { JUPITER_PRICE_URL, PRICE_CACHE_MS, SOL_MINT, createSolPriceSource, lamportsToMicro } from '../../src/chain/price.js';
import { silentLogger } from '../../src/lib/log.js';

const jupiter = (usdPrice: unknown): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify({ [SOL_MINT]: { usdPrice } }), { status: 200 })) as unknown as typeof fetch;

describe('chain/price', () => {
  it('values lamports in micro-dollars', () => {
    expect(lamportsToMicro(1_000_000_000, 150)).toBe(150_000_000);   // 1 SOL at $150
    expect(lamportsToMicro(5_000_000, 150)).toBe(750_000);           // the 0.005 SOL gas stipend
    expect(lamportsToMicro(0, 150)).toBe(0);
    expect(lamportsToMicro(1, 150)).toBe(0);                          // rounds, never fractional micro
  });

  it('uses SOL_PRICE_USD off mainnet and never calls the price API', async () => {
    const fetchFn = jupiter(999);
    const price = createSolPriceSource({ cluster: 'devnet', fallbackUsd: 150, log: silentLogger, fetchFn });
    expect(await price.get()).toBe(150);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads Jupiter on mainnet and caches for 60s', async () => {
    const fetchFn = jupiter(213.75);
    let now = 1_000_000;
    const price = createSolPriceSource({ cluster: 'mainnet-beta', fallbackUsd: 150, log: silentLogger, fetchFn, now: () => now });

    expect(await price.get()).toBe(213.75);
    expect(await price.get()).toBe(213.75);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(JUPITER_PRICE_URL, expect.objectContaining({ headers: { accept: 'application/json' } }));

    now += PRICE_CACHE_MS + 1;
    expect(await price.get()).toBe(213.75);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into one request', async () => {
    const fetchFn = jupiter(100);
    const price = createSolPriceSource({ cluster: 'mainnet-beta', fallbackUsd: 150, log: silentLogger, fetchFn });
    expect(await Promise.all([price.get(), price.get(), price.get()])).toEqual([100, 100, 100]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the last known price when the API fails or lies', async () => {
    const failing = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const price = createSolPriceSource({ cluster: 'mainnet-beta', fallbackUsd: 150, log: silentLogger, fetchFn: failing });
    expect(await price.get()).toBe(150);

    let now = 0;
    const flapping = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 180 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('null', { status: 500 })) as unknown as typeof fetch;
    const price2 = createSolPriceSource({ cluster: 'mainnet-beta', fallbackUsd: 150, log: silentLogger, fetchFn: flapping, now: () => now });
    expect(await price2.get()).toBe(180);
    now += PRICE_CACHE_MS + 1;
    expect(await price2.get()).toBe(180);   // keeps the last good value, not the env fallback

    const bogus = createSolPriceSource({ cluster: 'mainnet-beta', fallbackUsd: 150, log: silentLogger, fetchFn: jupiter('nope') });
    expect(await bogus.get()).toBe(150);
  });
});
