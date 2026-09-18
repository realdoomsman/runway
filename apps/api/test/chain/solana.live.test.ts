// Integration tests that talk to a REAL Solana cluster. Nothing here is mocked: every assertion is a
// round trip to a validator over JSON-RPC, and the write tests sign and land real transactions.
//
// It is skipped unless SOLANA_RPC_URL is set, so `pnpm test` stays offline by default.
//
//   Reads, against public devnet. Free, needs no wallet, and this is a real third-party cluster:
//     SOLANA_RPC_URL=https://api.devnet.solana.com pnpm --filter @runway/api test solana.live
//
//   Writes. These need a payer holding both SOL (fees) and the mint (transfers), which on public
//   devnet is currently unobtainable: the SOL faucet answers 429 to every request and devnet USDC
//   only comes from faucet.circle.com, an interactive web form. So the writes are proven against a
//   local Agave validator — same runtime, same SPL Token / ATA / Memo programs, same adapter code,
//   with a 6-decimal stand-in mint. `test/chain/setup-local-validator.ts` prepares it and prints the
//   mint to export:
//     solana-test-validator --reset --quiet --ledger /tmp/runway-ledger
//     pnpm --filter @runway/api exec tsx test/chain/setup-local-validator.ts
//     SOLANA_RPC_URL=http://127.0.0.1:8899 \
//     RUNWAY_IT_PAYER=~/.config/solana/runway-test.json \
//     RUNWAY_IT_USDC_MINT=<the mint it printed> \
//     pnpm --filter @runway/api test solana.live
//
//   The same command line works unchanged against devnet the day the payer has SOL and USDC — drop
//   RUNWAY_IT_USDC_MINT and point SOLANA_RPC_URL at the cluster. Nothing here is local-only by design.
//
// RUNWAY_IT_USDC_MINT overrides the cluster's USDC mint; devnet USDC is
// 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU, and the block below reads real traffic on it.
import {
  Connection, Keypair, PublicKey, type ParsedTransactionWithMeta,
} from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSolanaChain } from '../../src/chain/solana.js';
import type { UsdcTransfer } from '../../src/core/interfaces.js';
import { deriveAta, extractTokenTransfers } from '../../src/chain/parse.js';
import { createSolPriceSource } from '../../src/chain/price.js';
import { isChainError } from '../../src/chain/errors.js';
import { loadSecret } from '../../src/chain/keys.js';
import type { WalletAwareChain } from '../../src/chain/wallets.js';
import { loadConfig } from '../../src/config.js';
import { silentLogger } from '../../src/lib/log.js';

const RPC_URL = process.env['SOLANA_RPC_URL'];
const PAYER_SOURCE = process.env['RUNWAY_IT_PAYER'];
const MINT_OVERRIDE = process.env['RUNWAY_IT_USDC_MINT'];
const CLUSTER = (process.env['SOLANA_CLUSTER'] ?? 'devnet') as 'devnet' | 'mainnet-beta';
const FALLBACK_SOL_PRICE = 137.5;

// A valid base58 signature of the right length that no cluster has ever seen.
const UNKNOWN_SIG = '5'.repeat(87);
const MALFORMED_SIG = 'not-a-signature';

function chainFor(mint?: string): WalletAwareChain {
  const treasury = Keypair.generate();
  const config = loadConfig({
    NODE_ENV: 'test',
    KEY_ENCRYPTION_KEY: 'ab'.repeat(32),
    SESSION_SECRET: 'integration-test-session-secret-32',
    CHAIN_MODE: 'solana',
    SOLANA_CLUSTER: CLUSTER,
    SOLANA_RPC_URL: RPC_URL!,
    SOL_PRICE_USD: String(FALLBACK_SOL_PRICE),
    ...(mint ? { USDC_MINT: mint } : {}),
    TREASURY_WALLET_SECRET: JSON.stringify([...treasury.secretKey]),
    ESCROW_WALLET_SECRET: JSON.stringify([...Keypair.generate().secretKey]),
    PROTOCOL_FEE_WALLET: Keypair.generate().publicKey.toBase58(),
    FOUNDER_FEE_WALLET: Keypair.generate().publicKey.toBase58(),
    ...(CLUSTER === 'mainnet-beta' ? { ALLOW_MAINNET: '1' } : {}),
  });
  return createSolanaChain(config, silentLogger);
}

// ---------------------------------------------------------------------------
// Reads. Every one of these is a real RPC round trip and needs no funded wallet.
// ---------------------------------------------------------------------------
describe.skipIf(!RPC_URL)('chain/solana against a live cluster (reads)', () => {
  const chain = (): WalletAwareChain => chainFor(MINT_OVERRIDE);

  it('mints a keypair whose secret really is the pubkey it claims', () => {
    const { pubkey, secret } = chain().newKeypair();
    expect(secret).toHaveLength(64);
    expect(Keypair.fromSecretKey(secret).publicKey.toBase58()).toBe(pubkey);
    expect(new PublicKey(pubkey).toBase58()).toBe(pubkey);
  });

  it('reports 0 SOL for an address the cluster has never heard of', async () => {
    const fresh = Keypair.generate().publicKey.toBase58();
    expect(await chain().getSolBalance(fresh)).toBe(0);
  });

  // The case the poller hits on every single unpaid deposit address: no associated token account
  // exists yet, and getAccount throws TokenAccountNotFoundError. That must read as zero, not as an
  // error, or no purchase would ever be polled twice.
  it('reports 0 USDC for a wallet with no token account instead of throwing', async () => {
    const fresh = Keypair.generate().publicKey.toBase58();
    const c = chain();
    expect(await c.getUsdcBalance(fresh)).toBe(0);
    expect(await c.getTokenBalance(fresh, c.usdcMint)).toBe(0);
  });

  it('lists no inflows for a wallet with no token account', async () => {
    const fresh = Keypair.generate().publicKey.toBase58();
    expect(await chain().listUsdcInflows(fresh, null, 10)).toEqual([]);
  });

  it('rejects an address that is not base58', async () => {
    await expect(chain().getSolBalance('nope')).rejects.toSatisfy((e) => isChainError(e, 'invalid_address'));
  });

  // null must mean "the cluster has no such transfer" and nothing else. A malformed signature is a
  // bad request (-32602), which still resolves to null; an RPC outage must throw instead, because
  // verifyUsdcTransfer turns null into "your payment does not exist".
  it('returns null for a signature no cluster has seen, and for a malformed one', async () => {
    const c = chain();
    expect(await c.getUsdcTransfer(UNKNOWN_SIG)).toBeNull();
    expect(await c.getUsdcTransfer(MALFORMED_SIG)).toBeNull();
  });

  it('serves the configured SOL price off mainnet', async () => {
    if (CLUSTER === 'mainnet-beta') return;
    expect(await chain().solPriceUsd()).toBe(FALLBACK_SOL_PRICE);
  });

  // The price source is the one place the adapter calls an API that is not an RPC node. This hits
  // Jupiter for real; it is the same code path mainnet runs.
  it('fetches a live SOL/USD price from Jupiter for mainnet', async () => {
    const price = createSolPriceSource({ cluster: 'mainnet-beta', fallbackUsd: FALLBACK_SOL_PRICE, log: silentLogger });
    const value = await price.get();
    expect(value).not.toBe(FALLBACK_SOL_PRICE);   // the fallback would mean the fetch failed
    expect(value).toBeGreaterThan(1);
    expect(value).toBeLessThan(100_000);
    expect(await price.get()).toBe(value);        // cached for 60s
  });
});

// ---------------------------------------------------------------------------
// Real devnet USDC traffic. Our own transactions are simple by construction; these read whatever
// third parties actually put on the cluster, which is what proves the parser against the real
// getParsedTransaction shape rather than against a fixture we wrote ourselves.
// ---------------------------------------------------------------------------
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const onDevnetUsdc = !!RPC_URL && CLUSTER === 'devnet' && (MINT_OVERRIDE ?? DEVNET_USDC) === DEVNET_USDC;

describe.skipIf(!onDevnetUsdc)('chain/solana against real devnet USDC traffic', () => {
  const chain = (): WalletAwareChain => chainFor();
  // Assigned by beforeAll or the whole block fails. They are deliberately NOT nullable at point of
  // use: a test that quietly returns early when discovery found nothing is a test that reports
  // success for work it never did, which is the one outcome this file exists to prevent.
  let transfer: UsdcTransfer;
  let parsed: ParsedTransactionWithMeta;

  // Discovered, not hard-coded: the public RPC only keeps a window of history, so a pinned signature
  // would rot. Every signature that touches the mint account is a USDC operation.
  beforeAll(async () => {
    const connection = new Connection(RPC_URL!, { commitment: 'confirmed' });
    const sigs = await connection.getSignaturesForAddress(new PublicKey(DEVNET_USDC), { limit: 20 }, 'confirmed');
    const c = chain();
    const tried: string[] = [];
    for (const info of sigs.filter((s) => !s.err).slice(0, 8)) {
      tried.push(info.signature);
      const found = await c.getUsdcTransfer(info.signature);
      if (!found) continue;
      const full = await connection.getParsedTransaction(info.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if (!full) continue;
      transfer = found;
      parsed = full;
      return;
    }
    // Throwing here fails every test in the block. Devnet USDC always has recent traffic, so an
    // empty result means the RPC is not answering, not that the parser is fine.
    throw new Error(`no parseable USDC transfer among ${tried.length} recent signatures on ${DEVNET_USDC}: ${tried.join(',')}`);
  }, 180_000);

  it('parses a third-party devnet transfer into sender, recipient and amount', () => {
    expect(new PublicKey(transfer.from).toBase58()).toBe(transfer.from);
    expect(new PublicKey(transfer.to).toBase58()).toBe(transfer.to);
    expect(transfer.amount).toBeGreaterThan(0);
    expect(Number.isSafeInteger(transfer.amount)).toBe(true);
    expect(transfer.ts.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
  });

  // The strongest available check on ATA derivation: devnet's own token accounts, derived locally.
  // Nothing we sign is involved — these are addresses third parties put on the cluster, and if our
  // derivation disagreed with theirs every balance read in the product would silently return 0.
  it('derives the token account addresses devnet actually used', () => {
    const usdc = extractTokenTransfers(parsed).filter((t) => t.mint === DEVNET_USDC && t.to !== t.destination);
    expect(usdc.length, 'transfer had no owner-resolved USDC leg').toBeGreaterThan(0);
    for (const leg of usdc) expect(deriveAta(leg.to, DEVNET_USDC)).toBe(leg.destination);
  });

  it('reads the recipient balance through the derived ATA', async () => {
    const balance = await chain().getUsdcBalance(transfer.to);
    expect(Number.isSafeInteger(balance)).toBe(true);
    expect(balance).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Writes. Real signed transactions, so this needs a payer with SOL and USDC.
// ---------------------------------------------------------------------------
const payerSecret = PAYER_SOURCE ? loadSecret(PAYER_SOURCE) : null;
const payerPubkey = payerSecret ? Keypair.fromSecretKey(payerSecret).publicKey.toBase58() : null;

const ACTOR_SOL = 60_000_000;      // 0.06 SOL: fees and a handful of ATA rents
const ACTOR_USDC = 20_000_000;     // $20

describe.skipIf(!RPC_URL || !payerSecret)('chain/solana against a live cluster (writes)', () => {
  // Built in beforeAll, not here: vitest still RUNS this callback to collect a skipped suite, and
  // loadConfig now refuses CHAIN_MODE=solana without an explicit SOLANA_RPC_URL — which is exactly
  // the state this file is in when it is skipped for having no endpoint.
  let chain: WalletAwareChain;
  // Every test in this file signs as `actor`, a wallet funded once from the payer, NOT as the payer
  // itself. Vitest runs test files in parallel and poller.live.test.ts draws on the same payer, so an
  // assertion about the payer's own balance would be racing another file.
  let secret: Uint8Array;
  let actor: string;

  beforeAll(async () => {
    chain = chainFor(MINT_OVERRIDE);
    const payer = payerPubkey!;
    const sol = await chain.getSolBalance(payer);
    const usdc = await chain.getUsdcBalance(payer);
    // Fail loudly rather than skip: an unfunded payer given on purpose is a broken run, not a pass.
    expect(sol, `payer ${payer} holds no SOL on ${RPC_URL} — fund it before running the write suite`).toBeGreaterThan(ACTOR_SOL * 2);
    expect(usdc, `payer ${payer} holds no ${chain.usdcMint} — fund it before running the write suite`).toBeGreaterThan(ACTOR_USDC * 2);

    const keypair = chain.newKeypair();
    secret = keypair.secret;
    actor = keypair.pubkey;
    await chain.transferSol(payerSecret!, actor, ACTOR_SOL);
    await chain.transferUsdc(payerSecret!, actor, ACTOR_USDC);
    expect(await chain.getUsdcBalance(actor)).toBe(ACTOR_USDC);
  }, 300_000);

  it('derives the same associated token account the chain itself reports', async () => {
    const derived = deriveAta(actor, chain.usdcMint);
    // getTokenBalance sums every token account the owner has for the mint, found by owner+mint;
    // getUsdcBalance reads only the locally derived ATA. They agree exactly when the derivation is
    // right — a wrong ATA would read 0 while the owner scan still found the money.
    const byOwner = await chain.getTokenBalance(actor, chain.usdcMint);
    const byAta = await chain.getUsdcBalance(actor);
    expect(byAta).toBe(byOwner);
    expect(byAta).toBeGreaterThan(0);
    expect(new PublicKey(derived).toBase58()).toBe(derived);
  }, 60_000);

  it('creates an associated token account on chain and is idempotent about it', async () => {
    const owner = chain.newKeypair().pubkey;
    const ata = deriveAta(owner, chain.usdcMint);
    expect(await chain.getUsdcBalance(owner)).toBe(0);

    await chain.ensureAta(secret, owner);
    expect(await chain.getUsdcBalance(owner)).toBe(0);      // exists now, still empty
    expect(await chain.getTokenBalance(owner, chain.usdcMint)).toBe(0);

    await chain.ensureAta(secret, owner);                    // second call must not throw
    expect(new PublicKey(ata).toBase58()).toBe(ata);
  }, 90_000);

  it('transfers SOL and the balance moves by exactly that many lamports', async () => {
    const to = chain.newKeypair().pubkey;
    const lamports = 2_000_000;
    const before = await chain.getSolBalance(to);
    const { sig } = await chain.transferSol(secret, to, lamports);
    expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{60,100}$/);
    expect(await chain.getSolBalance(to)).toBe(before + lamports);
  }, 90_000);

  it('rejects a zero or fractional transfer before it reaches the network', async () => {
    const to = chain.newKeypair().pubkey;
    await expect(chain.transferSol(secret, to, 0)).rejects.toSatisfy((e) => isChainError(e, 'invalid_amount'));
    await expect(chain.transferUsdc(secret, to, 1.5)).rejects.toSatisfy((e) => isChainError(e, 'invalid_amount'));
  });

  it('transfers USDC, creating the destination ATA on the way', async () => {
    const to = chain.newKeypair().pubkey;
    const amount = 1_250_000;                                 // $1.25
    const senderBefore = await chain.getUsdcBalance(actor);

    const { sig } = await chain.transferUsdc(secret, to, amount, 'RUNWAY integration test');
    expect(await chain.getUsdcBalance(to)).toBe(amount);
    expect(await chain.getUsdcBalance(actor)).toBe(senderBefore - amount);

    // The same transaction, read back through the parser the payment verifier uses.
    const parsed = await chain.getUsdcTransfer(sig);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ sig, from: actor, to, amount });
    expect(parsed!.ts.getTime()).toBeGreaterThan(0);
  }, 120_000);

  // The deposit poller's whole job: see money land on a fresh address and say who sent it.
  it('lists real inflows oldest-limit-first and honours the sinceSig cursor', async () => {
    const deposit = chain.newKeypair();
    expect(await chain.listUsdcInflows(deposit.pubkey, null, 10)).toEqual([]);

    const first = await chain.transferUsdc(secret, deposit.pubkey, 300_000);
    const second = await chain.transferUsdc(secret, deposit.pubkey, 700_000);

    const all = await chain.listUsdcInflows(deposit.pubkey, null, 10);
    expect(all.map((i) => i.sig)).toEqual([second.sig, first.sig]);   // newest first
    expect(all.map((i) => i.amount)).toEqual([700_000, 300_000]);
    expect(all.every((i) => i.from === actor)).toBe(true);
    expect(all[0]!.ts.getTime()).toBeGreaterThanOrEqual(all[1]!.ts.getTime());
    expect(await chain.getUsdcBalance(deposit.pubkey)).toBe(1_000_000);

    // The cursor is exclusive: advancing to the newest returned sig yields nothing new…
    expect(await chain.listUsdcInflows(deposit.pubkey, second.sig, 10)).toEqual([]);
    // …and advancing to the oldest yields exactly what came after it.
    const afterFirst = await chain.listUsdcInflows(deposit.pubkey, first.sig, 10);
    expect(afterFirst.map((i) => i.sig)).toEqual([second.sig]);

    // limit returns the OLDEST n, so a caller that walks the cursor forward never skips one.
    const oldestOne = await chain.listUsdcInflows(deposit.pubkey, null, 1);
    expect(oldestOne.map((i) => i.sig)).toEqual([first.sig]);
  }, 180_000);

  // The expiry path: the treasury pays the fees so a deposit address with zero SOL can still be
  // emptied, and one transaction splits the balance across every out.
  it('sweeps USDC out of a zero-SOL deposit address in one transaction', async () => {
    const deposit = chain.newKeypair();
    await chain.transferUsdc(secret, deposit.pubkey, 900_000);
    expect(await chain.getSolBalance(deposit.pubkey)).toBe(0);       // it has never held a lamport

    const a = chain.newKeypair().pubkey;
    const b = chain.newKeypair().pubkey;
    const { sig } = await chain.sweepUsdc(deposit.secret, secret, [
      { to: a, amount: 600_000 },
      { to: b, amount: 300_000 },
      { to: chain.newKeypair().pubkey, amount: 0 },                  // dropped, not a failed leg
    ], 'RUNWAY sweep');

    expect(sig).toBeTruthy();
    expect(await chain.getUsdcBalance(a)).toBe(600_000);
    expect(await chain.getUsdcBalance(b)).toBe(300_000);
    expect(await chain.getUsdcBalance(deposit.pubkey)).toBe(0);
    expect(await chain.getSolBalance(deposit.pubkey)).toBe(0);       // the payer covered the fee
  }, 180_000);

  it('refuses a sweep with nothing to move', async () => {
    const deposit = chain.newKeypair();
    await expect(chain.sweepUsdc(deposit.secret, secret, [{ to: actor, amount: 0 }]))
      .rejects.toSatisfy((e) => isChainError(e, 'invalid_amount'));
  });

  it('sweeps a deposit address down to its last lamport', async () => {
    const deposit = chain.newKeypair();
    await chain.transferSol(secret, deposit.pubkey, 3_000_000);
    expect(await chain.getSolBalance(deposit.pubkey)).toBe(3_000_000);

    const to = chain.newKeypair().pubkey;
    await chain.sweepSol(deposit.secret, secret, to, null);          // null = whatever it holds
    expect(await chain.getSolBalance(deposit.pubkey)).toBe(0);
    expect(await chain.getSolBalance(to)).toBe(3_000_000);
  }, 120_000);
});
