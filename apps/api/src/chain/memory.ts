// In-process chain simulator (CHAIN_MODE=memory, SPEC §8.2): balances in maps, synthetic signatures,
// no fees, no confirmation latency. Addresses are free strings so demo owners like `demo-wallet-3`
// and faucet labels like `customer-7` work without keypairs. The treasury wallet starts with a
// DEMO_TREASURY_USD float and some SOL so gas stipends work; `faucet` is also the local payment
// simulator behind POST /api/purchases/:id/simulate-pay (SPEC-V2 §5.9).
import { randomBytes } from 'node:crypto';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { makeRng, usd, type Micro, type Rng } from '@runway/shared';
import type { Config } from '../config.js';
import type { Clock, UsdcInflow, UsdcTransfer } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import { ChainError } from './errors.js';
import { pubkeyOfSecret } from './keys.js';
import { getProtocolWallets, type WalletAwareChain } from './wallets.js';

export const MEMORY_GENESIS_SIG = 'simGenesisTreasuryFloat';
export const MEMORY_GENESIS_FROM = 'runway-treasury-float';
export const MEMORY_TREASURY_SOL_LAMPORTS = 10 * LAMPORTS_PER_SOL;
const DEFAULT_INFLOW_LIMIT = 100;
const MAX_INFLOW_LIMIT = 1_000;

export interface MemoryChain extends WalletAwareChain {
  readonly mode: 'memory';
  faucet(to: string, amount: Micro, from: string): Promise<{ sig: string }>;  // external "customer" USDC
  faucetSol(to: string, lamports: number): Promise<{ sig: string }>;
  setTokenBalance(owner: string, mint: string, baseUnits: number): void;      // arbitrary SPL fixtures
  setTokenPrice(mint: string, usdPerToken: number): void;                     // memory-only price control for tests
  useClock(clock: Clock): void;                                               // demo: stamp txs with virtual time
}

interface MemTx { index: number; sig: string; kind: 'usdc' | 'sol'; from: string; to: string; amount: number; memo: string | null; ts: Date }

export function createMemoryChain(config: Config, log: Logger, opts: { clock?: Clock } = {}): MemoryChain {
  const usdcMint = config.chain.usdcMint;
  const usdc = new Map<string, Micro>();
  const sol = new Map<string, number>();
  const tokens = new Map<string, Map<string, number>>();
  const txs: MemTx[] = [];
  const bySig = new Map<string, MemTx>();
  let clock: Clock = opts.clock ?? { now: () => new Date() };

  const newSig = (): string => `sim${bs58.encode(randomBytes(16))}`;
  const balance = (map: Map<string, number>, key: string): number => map.get(key) ?? 0;
  const tokenPrices = new Map<string, number>();          // memory only: mint -> USD per whole token (6-decimal tokens)
  const tokenBal = (mint: string, owner: string): number => tokens.get(mint)?.get(owner) ?? 0;
  const setTok = (mint: string, owner: string, v: number): void => {
    const m = tokens.get(mint) ?? new Map<string, number>();
    m.set(owner, v);
    tokens.set(mint, m);
  };
  const priceOf = (mint: string): number => tokenPrices.get(mint) ?? 1;

  function record(kind: MemTx['kind'], from: string, to: string, amount: number, memo: string | null, sig = newSig()): MemTx {
    const tx: MemTx = { index: txs.length, sig, kind, from, to, amount, memo, ts: clock.now() };
    txs.push(tx);
    bySig.set(sig, tx);
    return tx;
  }

  function move(map: Map<string, number>, kind: MemTx['kind'], fromSecret: Uint8Array, to: string, amount: number, memo: string | null, sig?: string): MemTx {
    const from = pubkeyOfSecret(fromSecret);
    assertAddress(to);
    assertAmount(amount);
    const have = balance(map, from);
    if (have < amount) throw new ChainError('insufficient_funds', `${from} has ${have} ${kind === 'usdc' ? 'micro USDC' : 'lamports'}, needs ${amount}`);
    map.set(from, have - amount);
    map.set(to, balance(map, to) + amount);
    return record(kind, from, to, amount, memo, sig);
  }

  function credit(map: Map<string, number>, kind: MemTx['kind'], from: string, to: string, amount: number, sig?: string): MemTx {
    assertAddress(to);
    assertAmount(amount);
    map.set(to, balance(map, to) + amount);
    return record(kind, from, to, amount, null, sig);
  }

  // Inflows newer than `sinceSig`, newest first. When more than `limit` exist the OLDEST `limit` are
  // returned, so a caller that advances its cursor to the newest returned sig never skips one.
  function listUsdcInflows(pubkey: string, sinceSig: string | null, limit = DEFAULT_INFLOW_LIMIT): UsdcInflow[] {
    const since = sinceSig ? bySig.get(sinceSig) : undefined;
    const start = since ? since.index + 1 : 0;
    const page = Math.min(Math.max(1, limit), MAX_INFLOW_LIMIT);
    return txs.slice(start)
      .filter((t) => t.kind === 'usdc' && t.to === pubkey)
      .slice(0, page)
      .reverse()
      .map(toInflow);
  }

  // DEMO=1 derives agent keypairs from DEMO_SEED so a seeded colony gets the same wallets — and so the
  // same prompts, and the same mock behaviour — on every boot. Simulated money only; never real keys.
  const keySeed: Rng | null = config.demo.enabled ? makeRng(config.demo.seed ^ 0x5eed_c0de) : null;
  const wallets = getProtocolWallets(config);
  if (config.demo.treasuryUsd > 0) credit(usdc, 'usdc', MEMORY_GENESIS_FROM, wallets.treasury.pubkey, usd(config.demo.treasuryUsd), MEMORY_GENESIS_SIG);
  credit(sol, 'sol', MEMORY_GENESIS_FROM, wallets.treasury.pubkey, MEMORY_TREASURY_SOL_LAMPORTS);
  log.info(
    { treasury: wallets.treasury.pubkey, escrow: wallets.escrow.pubkey, treasuryUsd: config.demo.treasuryUsd },
    'memory chain ready',
  );

  return {
    mode: 'memory',
    cluster: 'memory',
    usdcMint,
    wallets,
    newKeypair() {
      const kp = keySeed ? Keypair.fromSeed(seedBytes(keySeed)) : Keypair.generate();
      return { pubkey: kp.publicKey.toBase58(), secret: kp.secretKey };
    },
    async getUsdcBalance(pubkey) { return balance(usdc, pubkey); },
    async getSolBalance(pubkey) { return balance(sol, pubkey); },
    async getTokenBalance(pubkey, mint) {
      return mint === usdcMint ? balance(usdc, pubkey) : tokens.get(mint)?.get(pubkey) ?? 0;
    },
    async transferUsdc(fromSecret, to, amount, memo) {
      return { sig: move(usdc, 'usdc', fromSecret, to, amount, memo ?? null).sig };
    },
    async transferSol(fromSecret, to, lamports) {
      return { sig: move(sol, 'sol', fromSecret, to, lamports, null).sig };
    },
    // One "transaction": every leg shares a signature, exactly like the real adapter's multi-transfer
    // sweep. Zero-amount outs are skipped so a fee leg that rounds to nothing is not an error.
    async sweepUsdc(fromSecret, _payerSecret, outs, memo) {
      const sig = newSig();
      for (const out of outs) {
        if (out.amount === 0) continue;
        move(usdc, 'usdc', fromSecret, out.to, out.amount, memo ?? null, sig);
      }
      return { sig };
    },
    async sweepSol(fromSecret, _payerSecret, to, lamports) {
      const from = pubkeyOfSecret(fromSecret);
      const amount = lamports ?? balance(sol, from);
      if (amount <= 0) throw new ChainError('insufficient_funds', `${from} has no lamports to sweep`);
      return { sig: move(sol, 'sol', fromSecret, to, amount, null).sig };
    },
    // Simulated Jupiter swap: USDC<->token at the memory price (6-decimal tokens); marks the two balances.
    async swap(fromSecret, inputMint, outputMint, amountBaseUnits, _slippageBps) {
      assertAmount(amountBaseUnits);
      const from = pubkeyOfSecret(fromSecret);
      if (inputMint === usdcMint && outputMint !== usdcMint) {
        const have = balance(usdc, from);
        if (have < amountBaseUnits) throw new ChainError('insufficient_funds', `${from} has ${have} micro USDC, needs ${amountBaseUnits}`);
        usdc.set(from, have - amountBaseUnits);
        const out = Math.round(amountBaseUnits / priceOf(outputMint));
        setTok(outputMint, from, tokenBal(outputMint, from) + out);
        return { sig: newSig(), inAmount: amountBaseUnits, outAmount: out };
      }
      if (outputMint === usdcMint && inputMint !== usdcMint) {
        const have = tokenBal(inputMint, from);
        if (have < amountBaseUnits) throw new ChainError('insufficient_funds', `${from} holds ${have} of ${inputMint}, needs ${amountBaseUnits}`);
        setTok(inputMint, from, have - amountBaseUnits);
        const out = Math.round(amountBaseUnits * priceOf(inputMint));
        usdc.set(from, balance(usdc, from) + out);
        return { sig: newSig(), inAmount: amountBaseUnits, outAmount: out };
      }
      throw new ChainError('invalid_amount', 'memory swap supports only USDC<->token');
    },
    async quoteUsdcOut(mint, amountBaseUnits) {
      if (mint === usdcMint) return amountBaseUnits;
      if (!Number.isSafeInteger(amountBaseUnits) || amountBaseUnits <= 0) return 0;
      return Math.round(amountBaseUnits * priceOf(mint));
    },
    async listUsdcInflows(pubkey, sinceSig, limit) { return listUsdcInflows(pubkey, sinceSig, limit); },
    async getUsdcTransfer(sig) {
      const tx = bySig.get(sig);
      return tx && tx.kind === 'usdc' ? toTransfer(tx) : null;
    },
    async ensureAta() { /* token accounts are implicit in the simulator */ },
    async solPriceUsd() { return config.chain.solPriceUsd; },
    async faucet(to, amount, from) {
      return { sig: credit(usdc, 'usdc', from, to, amount).sig };
    },
    async faucetSol(to, lamports) {
      return { sig: credit(sol, 'sol', MEMORY_GENESIS_FROM, to, lamports).sig };
    },
    setTokenBalance(owner, mint, baseUnits) {
      const holders = tokens.get(mint) ?? new Map<string, number>();
      holders.set(owner, baseUnits);
      tokens.set(mint, holders);
    },
    setTokenPrice(mint, usdPerToken) { tokenPrices.set(mint, usdPerToken); },
    useClock(next) { clock = next; },
  };
}

const seedBytes = (rng: Rng): Uint8Array => Uint8Array.from({ length: 32 }, () => rng.int(0, 255));

const toInflow = (t: MemTx): UsdcInflow => ({ sig: t.sig, from: t.from, amount: t.amount, ts: t.ts });
const toTransfer = (t: MemTx): UsdcTransfer => ({ sig: t.sig, from: t.from, to: t.to, amount: t.amount, ts: t.ts });

function assertAddress(address: string): void {
  if (typeof address !== 'string' || address.trim() === '') throw new ChainError('invalid_address', 'destination address is empty');
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ChainError('invalid_amount', `amount must be a positive integer, got ${amount}`);
}
