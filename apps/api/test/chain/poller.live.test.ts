// The deposit poller against a REAL chain and a REAL database. This is the mechanism the whole buy
// flow rests on: nothing else decides that a purchase has been paid.
//
// Nothing is simulated. A purchase row is created by the real payments module, real USDC is sent to
// the deposit address it minted, and the real poller reads the cluster and moves the row. Fulfilment
// then sweeps that address on chain, pays the founder fee, books the treasury and funds the agent —
// every one of those a signed transaction.
//
// Skipped unless SOLANA_RPC_URL and RUNWAY_IT_PAYER are both set. See solana.live.test.ts for how to
// run it against devnet or against a local validator.
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CATALOG, estimateMicro, usd, type AgentPublic, type Micro, type ModelInfo, type WsMsg,
} from '@runway/shared';
import { Keypair } from '@solana/web3.js';
import { loadSecret } from '../../src/chain/keys.js';
import { createSolanaChain } from '../../src/chain/solana.js';
import { getProtocolWallets, type WalletAwareChain } from '../../src/chain/wallets.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createBus } from '../../src/core/bus.js';
import type { LlmRouter, Payments, Services, SpawnInput } from '../../src/core/interfaces.js';
import { createDb, type Db, type DbHandle } from '../../src/db/client.js';
import { agents, ledger, purchases, users, type PurchaseRow } from '../../src/db/schema.js';
import { treasuryService } from '../../src/economy/treasury.js';
import { newAgentId } from '../../src/lib/ids.js';
import { silentLogger } from '../../src/lib/log.js';
import { createPayments } from '../../src/payments/index.js';
import type { PaymentsDeps } from '../../src/payments/deps.js';

const RPC_URL = process.env['SOLANA_RPC_URL'];
const PAYER_SOURCE = process.env['RUNWAY_IT_PAYER'];
const MINT_OVERRIDE = process.env['RUNWAY_IT_USDC_MINT'];
const DATABASE_URL = process.env['RUNWAY_IT_DATABASE_URL'] ?? 'postgres://localhost:5432/runway_chain_test';
const LIVE = !!RPC_URL && !!PAYER_SOURCE;

const TABLES = [
  'sessions', 'auth_nonces', 'agent_keys', 'ledger', 'steps', 'decisions', 'projects', 'events', 'pool_txs',
  'pool_snapshots', 'pool', 'deposits_seen', 'bounties', 'service_calls', 'services', 'forks', 'withdrawals',
  'owner_messages', 'deployments', 'purchases', 'agents', 'users',
];

interface Harness {
  config: Config;
  db: Db;
  deps: PaymentsDeps;
  chain: WalletAwareChain;
  payments: Payments;
  payerSecret: Uint8Array;
  payerPubkey: string;
  spawns: SpawnInput[];
  loadRow(id: string): Promise<PurchaseRow>;
  close(): Promise<void>;
}

async function createLiveHarness(treasurySecret: Uint8Array): Promise<Harness> {
  const payerSecret = treasurySecret;
  const payerPubkey = Keypair.fromSecretKey(payerSecret).publicKey.toBase58();

  // The treasury IS the funded payer: it signs every sweep fee, the founder-fee shortfall and the
  // agent funding, exactly as it does in production.
  const config = loadConfig({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', LLM_PROVIDER: 'mock', SANDBOX_DRIVER: 'local',
    DATABASE_URL, SESSION_SECRET: 'live-poller-session-secret-long-enough',
    KEY_ENCRYPTION_KEY: 'cd'.repeat(32),
    CHAIN_MODE: 'solana',
    SOLANA_CLUSTER: (process.env['SOLANA_CLUSTER'] ?? 'devnet'),
    SOLANA_RPC_URL: RPC_URL!,
    ...(MINT_OVERRIDE ? { USDC_MINT: MINT_OVERRIDE } : {}),
    TREASURY_WALLET_SECRET: JSON.stringify([...payerSecret]),
    ESCROW_WALLET_SECRET: JSON.stringify([...Keypair.generate().secretKey]),
    PROTOCOL_FEE_WALLET: Keypair.generate().publicKey.toBase58(),
    FOUNDER_FEE_WALLET: Keypair.generate().publicKey.toBase58(),
    ACCEPT_SOL_DEPOSITS: '0',
    DEPOSIT_POLL_MS: '600000',            // the tests drive pollOne directly; no background ticking
  });

  const handle: DbHandle = createDb(config.databaseUrl, { max: 4 });
  await handle.pool.query(`truncate table ${TABLES.join(', ')} restart identity cascade`);

  const bus = createBus(silentLogger);
  const seen: WsMsg[] = [];
  bus.onAny((m) => seen.push(m));

  const chain = createSolanaChain(config, silentLogger);
  const spawns: SpawnInput[] = [];

  const deps = {
    config, db: handle.db, chain, bus, log: silentLogger,
    clock: { now: () => new Date() },
    llm: liveRouter(),
    sandbox: null as never,
    search: { name: 'none' as const, search: async () => [] },
  } as unknown as PaymentsDeps;

  // Stands in for economy/spawn.ts: the agent row, its wallet, and a REAL treasury → agent transfer.
  deps.services = {
    async spawn(input: SpawnInput): Promise<AgentPublic> {
      spawns.push(input);
      const now = new Date();
      const keypair = chain.newKeypair();
      await handle.db.insert(users).values({
        wallet: input.ownerWallet, kind: input.ownerKind, createdAt: now, lastLoginAt: now,
      }).onConflictDoNothing({ target: users.wallet });
      const [row] = await handle.db.insert(agents).values({
        id: input.agentId ?? newAgentId(), name: input.name, ownerWallet: input.ownerWallet,
        ownerKind: input.ownerKind, tier: input.tierId, purchaseId: input.purchaseId, status: 'alive',
        directive: input.directive, enabledTools: input.tools, model: input.model, effort: input.effort,
        heartbeatMin: input.heartbeatMin, walletPubkey: keypair.pubkey, deploySlug: input.name.toLowerCase(),
        bornAt: now, lastRentAt: now, createdAt: now, updatedAt: now,
      }).returning();
      const payout = await treasuryService(deps).fundAgent(
        { id: row!.id, name: row!.name, walletPubkey: row!.walletPubkey }, input.fundingMicro, { skipIfHeld: true },
      );
      await handle.db.insert(ledger).values({
        agentId: row!.id, kind: 'funding', amountMicro: input.fundingMicro, balanceAfterMicro: input.fundingMicro,
        memo: 'purchase funding', txSig: payout.fundingSig, settled: true, meta: { purchaseId: input.purchaseId },
      });
      await handle.db.update(agents)
        .set({ treasuryMicro: input.fundingMicro, fundingMicro: input.fundingMicro }).where(eq(agents.id, row!.id));
      return { id: row!.id, name: row!.name, walletPubkey: row!.walletPubkey } as AgentPublic;
    },
    async creditTopUp(agentId: string): Promise<AgentPublic> {
      const [row] = await handle.db.select().from(agents).where(eq(agents.id, agentId));
      return { id: row!.id, name: row!.name } as AgentPublic;
    },
  } as unknown as Services;

  const payments = createPayments(deps);
  deps.payments = payments;
  await treasuryService(deps).sync();     // adopt the payer's real on-chain balances

  return {
    config, db: handle.db, deps, chain, payments, payerSecret, payerPubkey, spawns,
    async loadRow(id) {
      const [row] = await handle.db.select().from(purchases).where(eq(purchases.id, id));
      return row!;
    },
    async close() {
      await payments.stop();
      await handle.close();
    },
  };
}

function liveRouter(): LlmRouter {
  const catalog = DEFAULT_CATALOG.filter((m) => m.provider === 'mock');
  return {
    mode: 'mock',
    models: () => catalog,
    resolve: (id: string) => catalog.find((m) => m.id === id) ?? catalog[0]!,
    cheapest: () => catalog[0]!,
    estimateMicro: (model: ModelInfo, inTok: number, outTok: number) => estimateMicro(model, inTok, outTok),
    refreshPricing: async () => undefined,
    complete: async () => { throw new Error('the live poller harness never completes'); },
  } as unknown as LlmRouter;
}

let h: Harness;
let nameSeq = 0;
const nextName = (): string => `LIVEBUY${(nameSeq += 1)}`;

// The treasury used here is a wallet of this file's own, funded once from RUNWAY_IT_PAYER. Vitest runs
// test files in parallel and solana.live.test.ts draws on the same payer, so sharing it would make
// every balance assertion below a race.
const TREASURY_SOL = 200_000_000;      // 0.2 SOL: sweep fees and ATA rent for every test in the file
const TREASURY_USDC = 400_000_000;     // $400: the tests move about $180 plus the refund round trip
let treasurySecret: Uint8Array;

describe.skipIf(!LIVE)('payments/poller against a live chain', () => {
  beforeAll(async () => {
    const payerSecret = loadSecret(PAYER_SOURCE!);
    const bootstrap = await createLiveHarness(payerSecret);
    try {
      const funded = bootstrap.chain.newKeypair();
      await bootstrap.chain.transferSol(payerSecret, funded.pubkey, TREASURY_SOL);
      await bootstrap.chain.transferUsdc(payerSecret, funded.pubkey, TREASURY_USDC);
      expect(await bootstrap.chain.getUsdcBalance(funded.pubkey)).toBe(TREASURY_USDC);
      treasurySecret = funded.secret;
    } finally {
      await bootstrap.close();
    }
  }, 300_000);

  beforeEach(async () => { h = await createLiveHarness(treasurySecret); }, 120_000);
  afterEach(async () => { await h?.close(); });

  const buy = (amountMicro: Micro = usd(25)) => h.payments.createPurchase({
    amountMicro, name: nextName(), directive: 'Prove the deposit poller sees real money.', path: 'deposit',
  });

  it('leaves an unpaid purchase pending and records that it looked', async () => {
    const { purchase } = await buy();
    expect(purchase.depositPubkey).toBeTruthy();
    expect(await h.chain.getUsdcBalance(purchase.depositPubkey!)).toBe(0);

    await h.payments.pollNow(purchase.id);

    const row = await h.loadRow(purchase.id);
    expect(row.status).toBe('pending');
    expect(row.amountMicro).toBe(0);
    expect(row.lastPolledAt).not.toBeNull();
    expect(h.spawns).toHaveLength(0);
  }, 120_000);

  it('records a real underpayment and names the real sender, without receiving it', async () => {
    const { purchase } = await buy(usd(25));
    const part = usd(4);
    await h.chain.transferUsdc(h.payerSecret, purchase.depositPubkey!, part);

    await h.payments.pollNow(purchase.id);

    const row = await h.loadRow(purchase.id);
    expect(row.status).toBe('pending');
    expect(row.usdcMicro).toBe(part);
    expect(row.amountMicro).toBe(part);
    // refundTo is read off the chain, not off the request: it is whoever actually sent the money.
    expect(row.refundTo).toBe(h.payerPubkey);
  }, 180_000);

  it('receives a real deposit, sweeps it on chain and funds the agent', async () => {
    const { purchase } = await buy(usd(25));
    const deposit = purchase.depositPubkey!;
    const wallets = getProtocolWallets(h.config);
    const founderBefore = await h.chain.getUsdcBalance(wallets.founderFee);

    await h.chain.transferUsdc(h.payerSecret, deposit, usd(25));
    expect(await h.chain.getUsdcBalance(deposit)).toBe(usd(25));

    await h.payments.pollNow(purchase.id);

    const row = await h.loadRow(purchase.id);
    expect(row.status).toBe('spawned');
    expect(row.amountMicro).toBe(usd(25));
    expect(row.usdcMicro).toBe(usd(25));
    expect(row.feeMicro).toBe(usd(25) * h.config.economy.founderFeeBps / 10_000);
    expect(row.fundingMicro).toBe(usd(25) - row.feeMicro);
    expect(row.agentId).not.toBeNull();
    expect(row.spawnError).toBeNull();

    // The deposit address is empty and its secret is gone.
    expect(await h.chain.getUsdcBalance(deposit)).toBe(0);
    expect(row.depositSecretEnc).toBeNull();

    // The founder fee really arrived, on chain, at the configured wallet.
    expect(await h.chain.getUsdcBalance(wallets.founderFee)).toBe(founderBefore + row.feeMicro);

    // And the agent really holds its funding.
    const [agent] = await h.db.select().from(agents).where(eq(agents.id, row.agentId!));
    expect(agent).toBeTruthy();
    expect(await h.chain.getUsdcBalance(agent!.walletPubkey)).toBe(row.fundingMicro);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.fundingMicro).toBe(row.fundingMicro);
  }, 300_000);

  it('upgrades the tier when the buyer really overpays', async () => {
    const { purchase } = await buy(usd(25));
    const quotedTier = (await h.loadRow(purchase.id)).quotedTier;

    await h.chain.transferUsdc(h.payerSecret, purchase.depositPubkey!, usd(120));
    await h.payments.pollNow(purchase.id);

    const row = await h.loadRow(purchase.id);
    expect(row.amountMicro).toBe(usd(120));
    expect(row.status).toBe('spawned');
    expect(row.tier).not.toBe(quotedTier);        // the gross, not the quote, picks the tier
  }, 300_000);

  it('refunds a real underpayment to the real sender when the purchase expires', async () => {
    const { purchase } = await buy(usd(25));
    const part = usd(3);
    await h.chain.transferUsdc(h.payerSecret, purchase.depositPubkey!, part);
    await h.payments.pollNow(purchase.id);          // learns refundTo

    // Expire it where the buyer would have waited hours.
    await h.db.update(purchases).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(purchases.id, purchase.id));
    const senderBefore = await h.chain.getUsdcBalance(h.payerPubkey);

    await h.payments.pollNow(purchase.id);

    const row = await h.loadRow(purchase.id);
    expect(row.status).toBe('refunded');
    expect(row.refundSig).toBeTruthy();
    expect(row.depositSecretEnc).toBeNull();
    expect(await h.chain.getUsdcBalance(purchase.depositPubkey!)).toBe(0);
    expect(await h.chain.getUsdcBalance(h.payerPubkey)).toBe(senderBefore + part);

    // The refund is a real transaction that reads back as one.
    const tx = await h.chain.getUsdcTransfer(row.refundSig!);
    expect(tx).not.toBeNull();
    expect(tx!.to).toBe(h.payerPubkey);
    expect(tx!.amount).toBe(part);
  }, 300_000);

  it('expires an unpaid purchase with nothing to sweep', async () => {
    const { purchase } = await buy();
    await h.db.update(purchases).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(purchases.id, purchase.id));

    await h.payments.pollNow(purchase.id);

    const row = await h.loadRow(purchase.id);
    expect(row.status).toBe('expired');
    expect(row.amountMicro).toBe(0);
    expect(row.refundSig).toBeNull();
  }, 120_000);

  it('is idempotent: polling a finished purchase again changes nothing and moves no money', async () => {
    const { purchase } = await buy(usd(25));
    await h.chain.transferUsdc(h.payerSecret, purchase.depositPubkey!, usd(25));
    await h.payments.pollNow(purchase.id);
    const first = await h.loadRow(purchase.id);
    expect(first.status).toBe('spawned');

    const [agent] = await h.db.select().from(agents).where(eq(agents.id, first.agentId!));
    const funded = await h.chain.getUsdcBalance(agent!.walletPubkey);

    await h.payments.pollNow(purchase.id);
    await h.payments.pollNow();

    const second = await h.loadRow(purchase.id);
    expect(second.agentId).toBe(first.agentId);
    expect(second.status).toBe('spawned');
    expect(h.spawns).toHaveLength(1);
    expect(await h.chain.getUsdcBalance(agent!.walletPubkey)).toBe(funded);
  }, 300_000);
});
