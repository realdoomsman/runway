// Real chain adapter: @solana/web3.js v1 + @solana/spl-token against devnet or mainnet (SPEC §8.1).
// USDC lives in associated token accounts; transfers create the destination ATA idempotently, confirm at
// 'confirmed' and resend on blockhash expiry. Inflow listing walks the ATA's signature history.
import {
  TokenAccountNotFoundError, TokenInvalidAccountOwnerError, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAccount,
} from '@solana/spl-token';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionExpiredBlockheightExceededError,
  TransactionInstruction, VersionedTransaction,
  type ConfirmedSignatureInfo, type ParsedAccountData,
} from '@solana/web3.js';
import type { Config } from '../config.js';
import type { UsdcInflow } from '../core/interfaces.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';
import { ChainError } from './errors.js';
import { keypairFromSecret } from './keys.js';
import { USDC_DECIMALS, blockTimeToDate, deriveAta, largestUsdcTransfer, resolveInflow, usdcInflowsTo } from './parse.js';
import { createSolPriceSource } from './price.js';
import { getProtocolWallets, type WalletAwareChain } from './wallets.js';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SEND_ATTEMPTS = 3;
export const SIGNATURE_PAGE = 1000;
export const MAX_SIGNATURE_PAGES = 5;
// Ceiling on transactions parsed in one listUsdcInflows call. MAX_SIGNATURE_PAGES × SIGNATURE_PAGE is
// 5000 signatures, and parsing them one by one on a throttled RPC would take hours; in practice
// `sinceSig` keeps the real number at zero or one.
export const MAX_SCAN_TXS = 500;
const DEFAULT_INFLOW_LIMIT = 100;
const PARSED_TX_CONFIG = { maxSupportedTransactionVersion: 0, commitment: 'confirmed' } as const;
// Public RPC endpoints rate-limit and restart constantly. Every read is idempotent, so a transient
// failure is retried with exponential backoff before it becomes a ChainError.
export const RPC_ATTEMPTS = 4;
const RPC_BACKOFF_MS = 400;
const RPC_BACKOFF_MAX_MS = 3_200;
const JSON_RPC_INVALID_PARAMS = -32602;

export function createSolanaChain(config: Config, log: Logger): WalletAwareChain {
  const { cluster, rpcUrl, usdcMint } = config.chain;
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  const mint = new PublicKey(usdcMint);
  const price = createSolPriceSource({ cluster, fallbackUsd: config.chain.solPriceUsd, log });

  const ataOf = (owner: string): PublicKey => new PublicKey(deriveAta(owner, usdcMint));

  // Every call routed through here is a READ, so retrying one can never move money twice.
  async function rpc<T>(what: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        // Our own validation (an address that is not base58, an amount that is not a positive
        // integer) runs inside these callbacks. It is already the right error and it will never
        // succeed on a retry, so it passes straight through rather than being relabelled rpc_error.
        if (e instanceof ChainError) throw e;
        if (attempt >= RPC_ATTEMPTS || !isTransientRpcError(e)) {
          throw new ChainError('rpc_error', `${what} failed: ${errorMessage(e)}`, { cause: e });
        }
        const waitMs = Math.min(RPC_BACKOFF_MS * 2 ** (attempt - 1), RPC_BACKOFF_MAX_MS);
        log.warn({ what, attempt, waitMs, err: errorMessage(e) }, 'rpc call failed; retrying');
        await nap(waitMs);
      }
    }
  }

  // `signers[0]` is the fee payer. A sweep passes [payer, from] so the deposit keypair never needs SOL.
  async function send(signer: Keypair | Keypair[], instructions: TransactionInstruction[]): Promise<string> {
    const signers = dedupeSigners(Array.isArray(signer) ? signer : [signer]);
    const payer = signers[0]!;
    for (let attempt = 1; ; attempt++) {
      const { blockhash, lastValidBlockHeight } = await rpc('getLatestBlockhash', () => connection.getLatestBlockhash('confirmed'));
      const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
      tx.sign(...signers);
      try {
        // Sent as a pre-signed wire transaction, NOT through sendAndConfirmTransaction. For a legacy
        // Transaction, web3.js's Connection.sendTransaction unconditionally calls
        // _blockhashWithExpiryBlockHeight and OVERWRITES recentBlockhash/lastValidBlockHeight with its
        // own 30s-cached value — so the blockhash fetched above was thrown away, the expiry we retry on
        // was one we never chose, and every transfer paid for a second getLatestBlockhash round trip on
        // the same public RPC whose throttling the retry machinery above exists to survive.
        const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
        const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        // Landing is not succeeding: a transaction can be included and still fail, and the money did
        // not move. sendAndConfirmTransaction used to raise this for us.
        if (value.err) throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(value.err)}`);
        return signature;
      } catch (e) {
        if (e instanceof TransactionExpiredBlockheightExceededError) {
          // An expired blockhash normally means the transaction can never be included, so resending is
          // safe. "Normally" is not good enough on a money path: confirmTransaction races the block
          // height against the signature subscription and can give up on a transaction that landed in
          // the last valid block. Ask the cluster before paying twice.
          //
          // This runs on EVERY expiry, including the last attempt. It used to be guarded by
          // `attempt < SEND_ATTEMPTS`, so the final expiry threw tx_failed without ever asking — and a
          // sweep that really landed came back as a failure, leaving poller.ts to mark the purchase
          // `spawnError: sweep failed` and re-poll an address it had already emptied.
          const landed = await landedSignature(e.signature);
          if (landed) {
            log.warn({ attempt, sig: landed }, 'blockhash expired but the transaction had already landed');
            return landed;
          }
          if (attempt < SEND_ATTEMPTS) {
            log.warn({ attempt, feePayer: payer.publicKey.toBase58() }, 'blockhash expired before confirmation; resending');
            continue;
          }
        }
        throw new ChainError('tx_failed', `transaction failed: ${errorMessage(e)}`, { cause: e });
      }
    }
  }

  // The signature of a transaction that is on the cluster and did not fail, or null.
  async function landedSignature(sig: string | undefined): Promise<string | null> {
    if (!sig) return null;
    try {
      const { value } = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
      if (!value || value.err) return null;
      return value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized' ? sig : null;
    } catch (e) {
      log.warn({ sig, err: errorMessage(e) }, 'could not check whether the expired transaction landed');
      return null;
    }
  }

  // getUsdcBalance is the most frequently issued read in the product — the deposit poller asks it for
  // every pending purchase on every tick, and it is what decides that a purchase has been paid. It
  // used to be the ONE read that did not go through `rpc()`, so a single 429 from a public endpoint
  // became an immediate rpc_error and stalled that purchase until the next tick, on exactly the call
  // most likely to be throttled.
  async function tokenAccountAmount(address: PublicKey): Promise<number> {
    return rpc('getAccount', async () => {
      try {
        return Number((await getAccount(connection, address, 'confirmed')).amount);
      } catch (e) {
        // "There is no such token account" is an answer, not a failure: it is the state of every
        // deposit address that has not been paid yet, and retrying it would be pointless.
        if (e instanceof TokenAccountNotFoundError || e instanceof TokenInvalidAccountOwnerError) return 0;
        throw e;
      }
    });
  }

  async function collectSignatures(address: PublicKey, sinceSig: string | null): Promise<ConfirmedSignatureInfo[]> {
    const all: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
      const batch = await rpc('getSignaturesForAddress', () =>
        connection.getSignaturesForAddress(address, { until: sinceSig ?? undefined, before, limit: SIGNATURE_PAGE }, 'confirmed'));
      all.push(...batch);
      if (batch.length < SIGNATURE_PAGE) break;
      before = batch[batch.length - 1]!.signature;
      // A full page on the LAST allowed iteration means history continues past the ceiling and this
      // call is returning a truncated view. Silence here would look identical to "nothing older
      // exists", which is how an old deposit stops being seen without anyone finding out.
      if (page === MAX_SIGNATURE_PAGES - 1) {
        log.warn(
          { address: address.toBase58(), pages: MAX_SIGNATURE_PAGES, signatures: all.length, oldestSeen: before },
          'signature history hit the page ceiling: this address has more transactions than one scan can list, '
          + 'so anything older than the oldest signature above is NOT included — reconcile it with a cursor',
        );
      }
    }
    return all.filter((s) => !s.err);
  }

  return {
    mode: 'solana',
    cluster,
    usdcMint,
    wallets: getProtocolWallets(config),
    newKeypair() {
      const kp = Keypair.generate();
      return { pubkey: kp.publicKey.toBase58(), secret: kp.secretKey };
    },
    getUsdcBalance(pubkey) {
      return tokenAccountAmount(ataOf(pubkey));
    },
    getSolBalance(pubkey) {
      return rpc('getBalance', () => connection.getBalance(publicKey(pubkey), 'confirmed'));
    },
    async getTokenBalance(pubkey, mintAddress) {
      // By owner + mint rather than the ATA: covers Token-2022 mints and non-associated accounts.
      const res = await rpc('getParsedTokenAccountsByOwner', () =>
        connection.getParsedTokenAccountsByOwner(publicKey(pubkey), { mint: publicKey(mintAddress) }, 'confirmed'));
      return res.value.reduce((sum, { account }) => sum + parsedTokenAmount(account.data), 0);
    },
    async transferUsdc(fromSecret, to, amount, memo) {
      assertAmount(amount);
      const from = keypairFromSecret(fromSecret);
      const toPk = publicKey(to);
      const destAta = ataOf(to);
      const instructions = [
        createAssociatedTokenAccountIdempotentInstruction(from.publicKey, destAta, toPk, mint),
        createTransferCheckedInstruction(ataOf(from.publicKey.toBase58()), mint, destAta, from.publicKey, amount, USDC_DECIMALS),
      ];
      if (memo) instructions.push(memoInstruction(memo));
      return { sig: await send(from, instructions) };
    },
    async transferSol(fromSecret, to, lamports) {
      assertAmount(lamports);
      const from = keypairFromSecret(fromSecret);
      const ix = SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: publicKey(to), lamports });
      return { sig: await send(from, [ix]) };
    },
    // One transaction for the whole purchase split (SPEC-V2 §5.4): the payer (treasury) funds the fees
    // and creates any missing destination ATA, the deposit keypair authorises each transfer. Outs of
    // zero are dropped so a fee leg that rounds to nothing does not cost a transaction.
    async sweepUsdc(fromSecret, payerSecret, outs, memo) {
      const legs = outs.filter((o) => o.amount !== 0);
      for (const out of legs) assertAmount(out.amount);
      if (legs.length === 0) throw new ChainError('invalid_amount', 'sweepUsdc needs at least one non-zero out');
      const from = keypairFromSecret(fromSecret);
      const payer = keypairFromSecret(payerSecret);
      const fromAta = ataOf(from.publicKey.toBase58());
      const instructions: TransactionInstruction[] = [];
      for (const out of legs) {
        const toPk = publicKey(out.to);
        const destAta = ataOf(out.to);
        instructions.push(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destAta, toPk, mint));
        instructions.push(createTransferCheckedInstruction(fromAta, mint, destAta, from.publicKey, out.amount, USDC_DECIMALS));
      }
      if (memo) instructions.push(memoInstruction(memo));
      return { sig: await send([payer, from], instructions) };
    },
    // Moves `lamports` (or everything the account holds) out of the deposit address. The payer covers
    // the network fee, so the deposit address can be emptied to the last lamport.
    async sweepSol(fromSecret, payerSecret, to, lamports) {
      const from = keypairFromSecret(fromSecret);
      const payer = keypairFromSecret(payerSecret);
      const amount = lamports ?? await rpc('getBalance', () => connection.getBalance(from.publicKey, 'confirmed'));
      assertAmount(amount);
      const ix = SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: publicKey(to), lamports: amount });
      return { sig: await send([payer, from], [ix]) };
    },
    // Inflows newer than `sinceSig`, newest first. When more than `limit` exist the OLDEST `limit` are
    // returned, so a caller that advances its cursor to the newest returned sig never skips one.
    //
    // Transactions are fetched ONE AT A TIME, not with getParsedTransactions: that call ships a
    // JSON-RPC batch, and every public endpoint meters getTransaction per sub-call and answers the
    // batch with 429 "Too many requests for a specific RPC call". Measured against
    // api.devnet.solana.com, batches of 5 and of 2 both failed while 19 of 20 sequential singles were
    // served — and a single is retryable, where a half-429'd batch is not. Singles cost more round
    // trips on a paid RPC; `sinceSig` is what keeps the count near zero in steady state.
    async listUsdcInflows(pubkey, sinceSig, limit = DEFAULT_INFLOW_LIMIT) {
      const ata = deriveAta(pubkey, usdcMint);
      const oldestFirst = (await collectSignatures(new PublicKey(ata), sinceSig)).reverse();
      const inflows: UsdcInflow[] = [];
      let scanned = 0;
      for (const info of oldestFirst) {
        if (inflows.length >= limit) break;
        if (scanned >= MAX_SCAN_TXS) {
          log.warn({ ata, scanned, found: inflows.length }, 'inflow scan hit its transaction budget; older inflows need a wider cursor');
          break;
        }
        scanned++;
        const tx = await rpc('getParsedTransaction', () => connection.getParsedTransaction(info.signature, PARSED_TX_CONFIG));
        if (!tx || tx.meta?.err) continue;
        // One inflow per SIGNATURE (see resolveInflow): deposits_seen is keyed by signature, so a
        // second row for the same one would be dropped with its money uncredited.
        const resolved = resolveInflow(usdcInflowsTo(tx, ata, usdcMint));
        if (!resolved) continue;
        if (resolved.senders.length > 1) {
          log.error(
            { ata, sig: info.signature, senders: resolved.senders, amount: resolved.amount, chosen: resolved.from },
            'one transaction credited this address from more than one sender: the refund destination is ambiguous and '
            + 'was resolved to the largest leg; reconcile by hand before refunding',
          );
        }
        inflows.push({
          sig: info.signature,
          from: resolved.from,
          amount: resolved.amount,
          ts: blockTimeToDate(tx.blockTime ?? info.blockTime),
        });
      }
      return inflows.reverse();
    },
    // null means "the cluster has no such USDC transfer". An RPC that is rate-limited or down is NOT
    // that answer and must not be reported as one: verifyUsdcTransfer turns null into "no confirmed
    // USDC transfer found", and telling a buyer their real payment does not exist is unrecoverable.
    // A signature the node rejects outright (-32602) is a malformed request, so that one is a null.
    async getUsdcTransfer(sig) {
      let tx;
      try {
        tx = await rpc('getParsedTransaction', () => connection.getParsedTransaction(sig, PARSED_TX_CONFIG));
      } catch (e) {
        if (!isInvalidParams(e)) throw e;
        log.debug({ err: e }, 'getParsedTransaction rejected the signature as malformed');
        return null;
      }
      if (!tx || tx.meta?.err) return null;
      const transfer = largestUsdcTransfer(tx, usdcMint);
      return transfer ? { sig, ...transfer, ts: blockTimeToDate(tx.blockTime) } : null;
    },
    async ensureAta(payerSecret, owner) {
      const payer = keypairFromSecret(payerSecret);
      const ata = ataOf(owner);
      if (await rpc('getAccountInfo', () => connection.getAccountInfo(ata, 'confirmed'))) return;
      await send(payer, [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, publicKey(owner), mint)]);
    },
    // Swap `amountBaseUnits` of inputMint into outputMint from the agent's own wallet via Jupiter. The
    // agent signs and pays gas (it must hold a little SOL). Slippage is capped; a missing route throws.
    async swap(fromSecret, inputMint, outputMint, amountBaseUnits, slippageBps) {
      assertAmount(amountBaseUnits);
      const kp = keypairFromSecret(fromSecret);
      const quote = await jupFetch(`${JUP_HOST}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountBaseUnits}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`);
      if (!quote || quote.outAmount === undefined) throw new ChainError('tx_failed', 'no swap route for that pair/size');
      const swapRes = await jupFetch(`${JUP_HOST}/swap`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }),
      });
      if (!swapRes?.swapTransaction) throw new ChainError('tx_failed', 'Jupiter returned no transaction');
      const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
      tx.sign([kp]);
      let sig: string;
      try {
        sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5, preflightCommitment: 'confirmed' });
        const conf = await connection.confirmTransaction(sig, 'confirmed');
        if (conf.value.err) throw new Error(JSON.stringify(conf.value.err));
      } catch (e) {
        throw new ChainError('tx_failed', `swap failed: ${errorMessage(e)}`, { cause: e });
      }
      return { sig, inAmount: Number(quote.inAmount), outAmount: Number(quote.outAmount) };
    },
    // Current USDC value (in micro) of holding `amountBaseUnits` of `mint`, i.e. what selling it now
    // would yield. Used to mark open positions to market for unrealized P&L. Zero when no route.
    async quoteUsdcOut(mint, amountBaseUnits) {
      if (mint === usdcMint) return amountBaseUnits;
      if (!Number.isSafeInteger(amountBaseUnits) || amountBaseUnits <= 0) return 0;
      try {
        const q = await jupFetch(`${JUP_HOST}/quote?inputMint=${mint}&outputMint=${usdcMint}&amount=${amountBaseUnits}&slippageBps=100&restrictIntermediateTokens=true`);
        return q && q.outAmount !== undefined ? Number(q.outAmount) : 0;
      } catch {
        return 0;
      }
    },
    solPriceUsd: () => price.get(),
  };
}

const nap = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// Jupiter's public lite host — used for the token swap and for marking positions to market (quote).
export const JUP_HOST = 'https://lite-api.jup.ag/swap/v1';
async function jupFetch(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) throw new ChainError('rpc_error', `Jupiter ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
  return res.json();
}

// What a public RPC endpoint answers with when it is busy, restarting or behind a flaky socket —
// never a statement about the chain, always worth one more attempt.
const TRANSIENT_RPC_RE = /too many requests|rate.?limit|429\b|too many concurrent|503\b|502\b|504\b|bad gateway|service unavailable|gateway time|timed? ?out|fetch failed|socket hang up|econnreset|econnrefused|epipe|enotfound|eai_again|network|connection (reset|closed|refused)|node is (behind|unhealthy)|blockstore error/i;

function jsonRpcCode(e: unknown): number | null {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'number' ? code : null;
}

export function isTransientRpcError(e: unknown): boolean {
  const code = jsonRpcCode(e);
  if (code === 429 || code === 502 || code === 503 || code === 504) return true;
  if (code === -32005 || code === -32004 || code === -32014 || code === -32016) return true;   // node behind / block not available / long-term storage
  return TRANSIENT_RPC_RE.test(errorMessage(e));
}

export const isInvalidParams = (e: unknown): boolean =>
  jsonRpcCode(e) === JSON_RPC_INVALID_PARAMS || /invalid param/i.test(errorMessage(e));

function publicKey(address: string): PublicKey {
  try {
    return new PublicKey(address);
  } catch {
    throw new ChainError('invalid_address', `not a valid Solana address: ${address}`);
  }
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ChainError('invalid_amount', `amount must be a positive integer, got ${amount}`);
}

// sendAndConfirmTransaction rejects a duplicate signer; a sweep where the payer is also the source
// (never in production, but possible in a test fixture) must still work.
function dedupeSigners(signers: Keypair[]): Keypair[] {
  const seen = new Set<string>();
  return signers.filter((s) => {
    const key = s.publicKey.toBase58();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function memoInstruction(memo: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(memo, 'utf8') });
}

function parsedTokenAmount(data: ParsedAccountData): number {
  const info = (data.parsed as { info?: { tokenAmount?: { amount?: unknown } } } | undefined)?.info;
  const raw = info?.tokenAmount?.amount;
  const n = typeof raw === 'string' ? Number(raw) : 0;
  return Number.isSafeInteger(n) ? n : 0;
}
