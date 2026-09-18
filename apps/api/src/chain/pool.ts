// TREASURY wallet (SPEC-V2 §5.7, was the seed pool): balances, price, agent funding, gas stipends and
// the purchase bookkeeping. The `pool` row is the expected balance; payouts and recorded inflows adjust
// it and `sync` adopts the chain balance, logging any difference as drift — there is no creator-fee
// inference any more, because every cent that arrives is either a purchase sweep or an operator top-up.
// One mutex serialises payouts against syncs so a balance read never straddles a transfer.
import {
  GAS_TOPUP_THRESHOLD_LAMPORTS, SOL_GAS_STIPEND_LAMPORTS, fmtUsd,
  type FeedEvent, type Micro, type TreasuryPublic, type TreasuryTx, type TreasuryTxKind,
} from '@runway/shared';
import type { Config } from '../config.js';
import type { ChainAdapter, Clock, EventBus } from '../core/interfaces.js';
import type { PoolRow } from '../db/schema.js';
import type { Logger } from '../lib/log.js';
import { ChainError } from './errors.js';
import { Mutex } from './mutex.js';
import { lamportsToMicro } from './price.js';
import type { TreasuryStore, TreasuryTxInsert } from './poolStore.js';
import type { Signer } from './wallets.js';

export const TREASURY_SYNC_INTERVAL_MS = 60_000;
const SOL_DRIFT_WARN_LAMPORTS = 50_000_000;   // 0.05 SOL of unexplained outflow (fees + ATA rent stay well below this)

export interface TreasuryAgentRef { id: string; name: string; walletPubkey: string }
export interface FundingPayout {
  fundingMicro: Micro;
  fundingSig: string | null;      // null when the agent already held the funding (retry after a partial failure)
  gasLamports: number; gasSig: string | null; gasMicro: Micro;
  solPriceUsd: number;
}
export interface GasTopUp { lamports: number; sig: string; gasMicro: Micro; solPriceUsd: number }
export type TreasuryInflowKind = Extract<TreasuryTxKind, 'withdraw_fee' | 'royalty' | 'refund' | 'sweep'>;

export interface RecordPurchaseInput {
  purchaseId: string;
  grossMicro: Micro;              // everything the buyer sent, USDC + valued SOL
  feeMicro: Micro;                // the founder fee, already paid out of the deposit address
  usdcInflowMicro: Micro;         // what actually landed in the treasury's USDC balance
  solLamportsInflow?: number;     // SOL swept in from a SOL-paid deposit
  txSig: string | null;
  kind: 'purchase' | 'topup';
  agentId?: string | null;        // set for a top-up
}

export interface FundAgentOpts {
  // Spawn retries after a partial failure pass this so a funding transfer is never made twice; a
  // top-up must always transfer, because the agent legitimately already holds money.
  skipIfHeld?: boolean;
}

export interface TreasuryService {
  readonly walletPubkey: string;
  current(): Promise<TreasuryPublic>;                                  // from the row; no chain call
  sync(): Promise<TreasuryPublic>;                                     // every 60s: balances, price, snapshot
  fundAgent(agent: TreasuryAgentRef, amountMicro: Micro, opts?: FundAgentOpts): Promise<FundingPayout>;
  topUpGas(agent: TreasuryAgentRef): Promise<GasTopUp | null>;         // null when above threshold or the treasury cannot pay
  recordPurchase(input: RecordPurchaseInput): Promise<void>;           // idempotent per purchase id
  recordInflow(kind: TreasuryInflowKind, amountMicro: Micro, txSig: string | null, agentId: string | null): Promise<void>;
  listTxs(q: { limit: number; before?: number }): Promise<TreasuryTx[]>;
}

export interface TreasuryServiceDeps {
  config: Config; chain: ChainAdapter; bus: EventBus; clock: Clock; log: Logger;
  store: TreasuryStore; wallet: Signer;
  // Pubkey only, and the EFFECTIVE one: in memory mode it is derived rather than configured, and the
  // panel must name the address the fee actually reaches rather than reporting "none".
  founderWallet: string | null;
}

export function createTreasuryService(deps: TreasuryServiceDeps): TreasuryService {
  const { config, chain, bus, clock, log, store, wallet, founderWallet } = deps;
  const healthFloorMicro = config.economy.minPurchaseMicro;
  const lock = new Mutex();
  let rowPromise: Promise<PoolRow> | null = null;

  const load = (): Promise<PoolRow> => (rowPromise ??= store.load(wallet.pubkey, config.chain.solPriceUsd));

  function toPublic(row: PoolRow): TreasuryPublic {
    return {
      walletPubkey: row.walletPubkey,
      usdcMicro: row.usdcMicro,
      solLamports: row.solLamports,
      solPriceUsd: row.solPriceUsd,
      usdValueMicro: row.usdcMicro + lamportsToMicro(row.solLamports, row.solPriceUsd),
      agentsFunded: row.agentsFunded,
      fundedMicro: row.fundedMicro,
      purchasesMicro: row.purchasesMicro,
      founderFeesMicro: row.founderFeesMicro,
      founderFeeBps: config.economy.founderFeeBps,
      founderWallet,
      // A health flag only: agents are funded from their own buyer's money, so a thin treasury blocks
      // nothing — it just means a purchase sweep has not settled yet.
      paused: row.paused || row.usdcMicro < healthFloorMicro,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    };
  }

  function commit(row: PoolRow, event: FeedEvent | null): PoolRow {
    rowPromise = Promise.resolve(row);
    if (event) bus.emit({ type: 'event', event });
    bus.emit({ type: 'treasury', treasury: toPublic(row) });
    return row;
  }

  async function sync(): Promise<TreasuryPublic> {
    const row = await load();
    const [usdc, sol, solPriceUsd] = await Promise.all([
      chain.getUsdcBalance(wallet.pubkey),
      chain.getSolBalance(wallet.pubkey),
      chain.solPriceUsd(),
    ]);

    const usdcDrift = usdc - row.usdcMicro;
    if (usdcDrift !== 0) {
      log[usdcDrift < 0 ? 'warn' : 'info'](
        { driftMicro: usdcDrift, onchainMicro: usdc },
        'treasury USDC differs from the booked balance; adopting the chain balance',
      );
    }
    const solDrift = row.lastSyncedAt ? sol - row.solLamports : 0;
    if (solDrift < -SOL_DRIFT_WARN_LAMPORTS) {
      log.warn({ expectedLamports: row.solLamports, onchainLamports: sol }, 'treasury SOL dropped more than fees explain');
    }

    const now = clock.now();
    const result = await store.update({
      usdcMicro: usdc, solLamports: sol, solPriceUsd, paused: usdc < healthFloorMicro, lastSyncedAt: now,
    }, []);
    await store.snapshot(day(now), usdc, sol);
    return toPublic(commit(result.row, null));
  }

  async function fundAgent(agent: TreasuryAgentRef, amountMicro: Micro, opts: FundAgentOpts): Promise<FundingPayout> {
    if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) {
      throw new ChainError('invalid_amount', `funding must be a positive integer, got ${amountMicro}`);
    }
    let row = await load();
    if (!row.lastSyncedAt) {      // first payout after boot: the row's balance is still unknown
      await sync();
      row = await load();
    }
    if (row.usdcMicro < amountMicro) {
      throw new ChainError('treasury_dry', `treasury holds ${fmtUsd(row.usdcMicro)}, this agent needs ${fmtUsd(amountMicro)}`);
    }
    const [solPriceUsd, agentSol, agentUsdc] = await Promise.all([
      chain.solPriceUsd(),
      chain.getSolBalance(agent.walletPubkey),
      chain.getUsdcBalance(agent.walletPubkey),
    ]);
    await chain.ensureAta(wallet.secret, agent.walletPubkey);

    const alreadyHeld = opts.skipIfHeld === true && agentUsdc >= amountMicro;
    const gasSig = agentSol < SOL_GAS_STIPEND_LAMPORTS ? (await chain.transferSol(wallet.secret, agent.walletPubkey, SOL_GAS_STIPEND_LAMPORTS)).sig : null;
    const fundingSig = alreadyHeld ? null : (await chain.transferUsdc(wallet.secret, agent.walletPubkey, amountMicro, 'RUNWAY funding')).sig;
    if (alreadyHeld) log.warn({ agentId: agent.id }, 'agent already holds its funding; skipped the USDC transfer');

    const gasLamports = gasSig ? SOL_GAS_STIPEND_LAMPORTS : 0;
    const gasMicro = lamportsToMicro(gasLamports, solPriceUsd);
    const paidMicro = fundingSig ? amountMicro : 0;
    const txs: TreasuryTxInsert[] = [];
    if (fundingSig) txs.push({ kind: 'funding', amountMicro: -amountMicro, txSig: fundingSig, agentId: agent.id });
    if (gasSig) txs.push({ kind: 'gas', amountMicro: -gasMicro, txSig: gasSig, agentId: agent.id });
    const usdcMicro = row.usdcMicro - paidMicro;
    const result = await store.update({
      usdcMicro,
      solLamports: Math.max(0, row.solLamports - gasLamports),
      paused: usdcMicro < healthFloorMicro,
      agentsFunded: row.agentsFunded + (fundingSig ? 1 : 0),
      fundedMicro: row.fundedMicro + paidMicro,
    }, txs);
    commit(result.row, null);
    log.info({ agentId: agent.id, fundingSig, gasSig, amountMicro }, 'agent funded');
    return { fundingMicro: amountMicro, fundingSig, gasLamports, gasSig, gasMicro, solPriceUsd };
  }

  async function topUpGas(agent: TreasuryAgentRef): Promise<GasTopUp | null> {
    const agentSol = await chain.getSolBalance(agent.walletPubkey);
    if (agentSol >= GAS_TOPUP_THRESHOLD_LAMPORTS) return null;
    const row = await load();
    if (row.solLamports < SOL_GAS_STIPEND_LAMPORTS) {
      log.warn({ agentId: agent.id, treasuryLamports: row.solLamports }, 'treasury cannot afford a gas top-up');
      return null;
    }
    const solPriceUsd = await chain.solPriceUsd();
    const { sig } = await chain.transferSol(wallet.secret, agent.walletPubkey, SOL_GAS_STIPEND_LAMPORTS);
    const gasMicro = lamportsToMicro(SOL_GAS_STIPEND_LAMPORTS, solPriceUsd);
    const result = await store.update(
      { solLamports: Math.max(0, row.solLamports - SOL_GAS_STIPEND_LAMPORTS) },
      [{ kind: 'gas', amountMicro: -gasMicro, txSig: sig, agentId: agent.id }],
    );
    commit(result.row, null);
    log.info({ agentId: agent.id, sig }, 'gas topped up');
    return { lamports: SOL_GAS_STIPEND_LAMPORTS, sig, gasMicro, solPriceUsd };
  }

  // The net of a purchase landing from the deposit address. Idempotent: fulfilment is retried, and the
  // founder fee and the gross must be counted exactly once.
  async function recordPurchase(input: RecordPurchaseInput): Promise<void> {
    const { purchaseId, grossMicro, feeMicro, usdcInflowMicro, txSig, kind } = input;
    for (const [what, value] of [['grossMicro', grossMicro], ['feeMicro', feeMicro], ['usdcInflowMicro', usdcInflowMicro]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new ChainError('invalid_amount', `${what} must be a non-negative integer, got ${value}`);
    }
    if (await store.hasPurchaseTx(purchaseId)) {
      log.info({ purchaseId }, 'purchase already booked on the treasury; skipping');
      return;
    }
    const row = await load();
    const usdcMicro = row.usdcMicro + usdcInflowMicro;
    const solLamports = row.solLamports + Math.max(0, input.solLamportsInflow ?? 0);
    const result = await store.update(
      {
        usdcMicro,
        solLamports,
        paused: usdcMicro < healthFloorMicro,
        purchasesMicro: row.purchasesMicro + grossMicro,
        founderFeesMicro: row.founderFeesMicro + feeMicro,
      },
      [{
        kind, amountMicro: grossMicro - feeMicro, txSig, agentId: input.agentId ?? null,
        meta: { purchaseId, grossMicro, feeMicro },
      }],
    );
    commit(result.row, null);
  }

  async function recordInflow(kind: TreasuryInflowKind, amountMicro: Micro, txSig: string | null, agentId: string | null): Promise<void> {
    if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) throw new ChainError('invalid_amount', `inflow must be a positive integer, got ${amountMicro}`);
    const row = await load();
    const usdcMicro = row.usdcMicro + amountMicro;
    const result = await store.update({ usdcMicro, paused: usdcMicro < healthFloorMicro }, [{ kind, amountMicro, txSig, agentId }]);
    commit(result.row, null);
  }

  return {
    walletPubkey: wallet.pubkey,
    current: async () => toPublic(await load()),
    sync: () => lock.run(sync),
    fundAgent: (agent, amountMicro, opts = {}) => lock.run(() => fundAgent(agent, amountMicro, opts)),
    topUpGas: (agent) => lock.run(() => topUpGas(agent)),
    recordPurchase: (input) => lock.run(() => recordPurchase(input)),
    recordInflow: (kind, amount, sig, agentId) => lock.run(() => recordInflow(kind, amount, sig, agentId)),
    listTxs: (q) => store.listTxs(q),
  };
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
