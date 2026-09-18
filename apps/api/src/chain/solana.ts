// Real chain adapter: @solana/web3.js v1 + @solana/spl-token against devnet or mainnet (SPEC §8.1).
// USDC lives in associated token accounts; transfers create the destination ATA idempotently, confirm at
// 'confirmed' and resend on blockhash expiry. Inflow listing walks the ATA's signature history.
import {
  TokenAccountNotFoundError, TokenInvalidAccountOwnerError, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAccount,
} from '@solana/spl-token';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionExpiredBlockheightExceededError,
  TransactionInstruction, sendAndConfirmTransaction,
  type ConfirmedSignatureInfo, type ParsedAccountData,
} from '@solana/web3.js';
import type { Config } from '../config.js';
import type { UsdcInflow } from '../core/interfaces.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';
import { ChainError } from './errors.js';
import { keypairFromSecret } from './keys.js';
import { USDC_DECIMALS, blockTimeToDate, deriveAta, largestUsdcTransfer, usdcInflowsTo } from './parse.js';
import { createSolPriceSource } from './price.js';
import { getProtocolWallets, type WalletAwareChain } from './wallets.js';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SEND_ATTEMPTS = 3;
const SIGNATURE_PAGE = 1000;
const MAX_SIGNATURE_PAGES = 5;
const PARSE_BATCH = 50;
const DEFAULT_INFLOW_LIMIT = 100;
const PARSED_TX_CONFIG = { maxSupportedTransactionVersion: 0, commitment: 'confirmed' } as const;

export function createSolanaChain(config: Config, log: Logger): WalletAwareChain {
  const { cluster, rpcUrl, usdcMint } = config.chain;
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  const mint = new PublicKey(usdcMint);
  const price = createSolPriceSource({ cluster, fallbackUsd: config.chain.solPriceUsd, log });

  const ataOf = (owner: string): PublicKey => new PublicKey(deriveAta(owner, usdcMint));

  async function rpc<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new ChainError('rpc_error', `${what} failed: ${errorMessage(e)}`, { cause: e });
    }
  }

  // `signers[0]` is the fee payer. A sweep passes [payer, from] so the deposit keypair never needs SOL.
  async function send(signer: Keypair | Keypair[], instructions: TransactionInstruction[]): Promise<string> {
    const signers = Array.isArray(signer) ? signer : [signer];
    const payer = signers[0]!;
    for (let attempt = 1; ; attempt++) {
      const { blockhash, lastValidBlockHeight } = await rpc('getLatestBlockhash', () => connection.getLatestBlockhash('confirmed'));
      const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
      try {
        return await sendAndConfirmTransaction(connection, tx, dedupeSigners(signers), { commitment: 'confirmed', preflightCommitment: 'confirmed' });
      } catch (e) {
        if (e instanceof TransactionExpiredBlockheightExceededError && attempt < SEND_ATTEMPTS) {
          log.warn({ attempt, feePayer: payer.publicKey.toBase58() }, 'blockhash expired before confirmation; resending');
          continue;
        }
        throw new ChainError('tx_failed', `transaction failed: ${errorMessage(e)}`, { cause: e });
      }
    }
  }

  async function tokenAccountAmount(address: PublicKey): Promise<number> {
    try {
      return Number((await getAccount(connection, address, 'confirmed')).amount);
    } catch (e) {
      if (e instanceof TokenAccountNotFoundError || e instanceof TokenInvalidAccountOwnerError) return 0;
      throw new ChainError('rpc_error', `getAccount failed: ${errorMessage(e)}`, { cause: e });
    }
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
    async listUsdcInflows(pubkey, sinceSig, limit = DEFAULT_INFLOW_LIMIT) {
      const ata = deriveAta(pubkey, usdcMint);
      const oldestFirst = (await collectSignatures(new PublicKey(ata), sinceSig)).reverse();
      const inflows: UsdcInflow[] = [];
      for (let i = 0; i < oldestFirst.length && inflows.length < limit; i += PARSE_BATCH) {
        const batch = oldestFirst.slice(i, i + PARSE_BATCH);
        const txs = await rpc('getParsedTransactions', () => connection.getParsedTransactions(batch.map((s) => s.signature), PARSED_TX_CONFIG));
        txs.forEach((tx, j) => {
          if (!tx || tx.meta?.err) return;
          const parts = usdcInflowsTo(tx, ata, usdcMint);
          if (parts.length === 0) return;
          const info = batch[j]!;
          inflows.push({
            sig: info.signature,
            from: parts[0]!.from,
            amount: parts.reduce((sum, p) => sum + p.amount, 0),
            ts: blockTimeToDate(tx.blockTime ?? info.blockTime),
          });
        });
      }
      return inflows.slice(0, limit).reverse();
    },
    async getUsdcTransfer(sig) {
      let tx;
      try {
        tx = await connection.getParsedTransaction(sig, PARSED_TX_CONFIG);
      } catch (e) {
        log.debug({ err: e }, 'getParsedTransaction failed');
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
    solPriceUsd: () => price.get(),
  };
}

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
