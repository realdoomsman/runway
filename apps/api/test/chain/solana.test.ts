// The Solana adapter's failure handling, driven by a real HTTP server that answers like a throttled
// RPC node. No network and no cluster: the point is the behaviour the public endpoints forced on us.
//
// Public RPC nodes meter getTransaction per call and answer with a JSON-RPC error carrying code 429,
// inside an HTTP 200. Nothing retried it, so listUsdcInflows — and with it the deposit poller and the
// agent deposit scan — failed outright on the default endpoint. Everything below pins that shut.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isChainError } from '../../src/chain/errors.js';
import {
  MAX_SCAN_TXS, MAX_SIGNATURE_PAGES, RPC_ATTEMPTS, SIGNATURE_PAGE, createSolanaChain, isInvalidParams,
  isTransientRpcError,
} from '../../src/chain/solana.js';
import type { WalletAwareChain } from '../../src/chain/wallets.js';
import { loadConfig, type Config } from '../../src/config.js';
import { silentLogger, type Logger } from '../../src/lib/log.js';

type Responder = (method: string, params: unknown[]) => unknown;

interface RpcCall { method: string; params: unknown[] }

interface FakeRpc {
  url: string;
  calls: string[];
  requests: RpcCall[];
  respond(fn: Responder): void;
  close(): Promise<void>;
}

// An error object is returned as a JSON-RPC error; anything else as the result.
interface RpcReq { id: number; method: string; params?: unknown[] }

async function startFakeRpc(): Promise<FakeRpc> {
  let responder: Responder = () => null;
  const calls: string[] = [];
  const requests: RpcCall[] = [];

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      const parsed = JSON.parse(body) as RpcReq | RpcReq[];
      const one = (r: RpcReq): unknown => {
        const params = r.params ?? [];
        calls.push(r.method);
        requests.push({ method: r.method, params });
        const value = responder(r.method, params);
        const isError = !!value && typeof value === 'object' && 'code' in (value as object) && 'message' in (value as object);
        return isError ? { jsonrpc: '2.0', id: r.id, error: value } : { jsonrpc: '2.0', id: r.id, result: value };
      };
      const payload = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    requests,
    respond(fn) { responder = fn; },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

const RATE_LIMITED = { code: 429, message: 'Too many requests for a specific RPC call' };
const INVALID_PARAM = { code: -32602, message: 'failed to get transaction: Invalid param: Invalid' };
const balanceResult = (lamports: number) => ({ context: { slot: 1 }, value: lamports });

const solanaConfig = (url: string): Config => loadConfig({
  NODE_ENV: 'test',
  KEY_ENCRYPTION_KEY: 'ab'.repeat(32),
  SESSION_SECRET: 'fake-rpc-session-secret-long-enough',
  CHAIN_MODE: 'solana',
  SOLANA_RPC_URL: url,
  TREASURY_WALLET_SECRET: JSON.stringify([...Keypair.generate().secretKey]),
  ESCROW_WALLET_SECRET: JSON.stringify([...Keypair.generate().secretKey]),
  PROTOCOL_FEE_WALLET: Keypair.generate().publicKey.toBase58(),
  FOUNDER_FEE_WALLET: Keypair.generate().publicKey.toBase58(),
});

/** A Logger that keeps every warn message, for the checks that assert the adapter said something. */
function capturingLogger(warnings: string[]): Logger {
  const self = {
    level: 'warn',
    warn: (a: unknown, b?: string) => { warnings.push(typeof a === 'string' ? a : (b ?? '')); },
    info: () => undefined, error: () => undefined, debug: () => undefined,
    trace: () => undefined, fatal: () => undefined, silent: () => undefined,
    child: () => self,
  };
  return self as unknown as Logger;
}

let rpc: FakeRpc;
let chain: WalletAwareChain;

beforeEach(async () => {
  rpc = await startFakeRpc();
  chain = createSolanaChain(solanaConfig(rpc.url), silentLogger);
});

afterEach(async () => { await rpc.close(); });

const someone = (): string => Keypair.generate().publicKey.toBase58();

describe('chain/solana rate-limit handling', () => {
  it('retries a throttled read and returns the answer', async () => {
    let seen = 0;
    rpc.respond((method) => {
      if (method !== 'getBalance') return null;
      seen += 1;
      return seen < 3 ? RATE_LIMITED : balanceResult(7_000_000);
    });

    expect(await chain.getSolBalance(someone())).toBe(7_000_000);
    expect(seen).toBe(3);
  });

  it('gives up as an rpc_error once the attempts are spent, and names the call', async () => {
    let seen = 0;
    rpc.respond((method) => { if (method === 'getBalance') seen += 1; return RATE_LIMITED; });

    await expect(chain.getSolBalance(someone())).rejects.toSatisfy(
      (e) => isChainError(e, 'rpc_error') && (e as Error).message.startsWith('getBalance failed:'),
    );
    expect(seen).toBe(RPC_ATTEMPTS);
  });

  // The regression that mattered: this used to return null, and verifyUsdcTransfer turns null into
  // "no confirmed USDC transfer found for your payment".
  it('never reports a throttled getUsdcTransfer as a missing transfer', async () => {
    rpc.respond(() => RATE_LIMITED);
    await expect(chain.getUsdcTransfer('4'.repeat(87))).rejects.toSatisfy((e) => isChainError(e, 'rpc_error'));
  });

  it('does report a malformed signature as a missing transfer, without retrying it', async () => {
    let seen = 0;
    rpc.respond((method) => { if (method === 'getTransaction') seen += 1; return INVALID_PARAM; });

    expect(await chain.getUsdcTransfer('not-a-signature')).toBeNull();
    expect(seen).toBe(1);
  });

  it('does not retry, or relabel, an address that was never valid', async () => {
    rpc.respond(() => balanceResult(1));
    await expect(chain.getSolBalance('not-base58')).rejects.toSatisfy((e) => isChainError(e, 'invalid_address'));
    expect(rpc.calls).toHaveLength(0);
  });

  it('reads inflows one transaction at a time, never as a batch', async () => {
    rpc.respond((method) => {
      if (method === 'getSignaturesForAddress') {
        return [{ signature: 'a'.repeat(88), slot: 2, err: null, memo: null, blockTime: 1 },
          { signature: 'b'.repeat(88), slot: 1, err: null, memo: null, blockTime: 0 }];
      }
      return null;      // getTransaction: not found, which is fine — we only care how it was asked
    });

    expect(await chain.listUsdcInflows(someone(), null, 10)).toEqual([]);
    // getTransactions (plural, a JSON-RPC batch) is what the public endpoints 429 on.
    expect(rpc.calls.filter((m) => m === 'getTransaction')).toHaveLength(2);
    expect(rpc.calls).not.toContain('getTransactions');
  });
});

describe('chain/solana error classification', () => {
  it('treats a throttle, an outage and a dropped socket as worth retrying', () => {
    expect(isTransientRpcError({ code: 429, message: 'Too many requests for a specific RPC call' })).toBe(true);
    expect(isTransientRpcError(new Error('failed to get transactions: Too many requests for a specific RPC call'))).toBe(true);
    expect(isTransientRpcError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientRpcError(new Error('fetch failed'))).toBe(true);
    expect(isTransientRpcError(new Error('socket hang up'))).toBe(true);
    expect(isTransientRpcError({ code: -32005, message: 'Node is behind by 200 slots' })).toBe(true);
  });

  it('treats a real answer from a healthy node as final', () => {
    expect(isTransientRpcError(new Error('Invalid param: WrongSize'))).toBe(false);
    expect(isTransientRpcError({ code: -32602, message: 'Invalid param' })).toBe(false);
    expect(isTransientRpcError(new Error('insufficient funds for rent'))).toBe(false);
    expect(isTransientRpcError(null)).toBe(false);
  });

  it('recognises the malformed-request code', () => {
    expect(isInvalidParams({ code: -32602, message: 'whatever' })).toBe(true);
    expect(isInvalidParams(new Error('failed to get transaction: Invalid param: Invalid'))).toBe(true);
    expect(isInvalidParams({ code: 429, message: 'Too many requests' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The blockhash-expiry path in `send`. Neither devnet nor a local validator will expire a blockhash
// on demand — confirmation there takes under a second — so the only way to execute this code is to
// drive it from an RPC that reports the block height already past `lastValidBlockHeight`. That is
// what this does: real signing, real serialization, real sendAndConfirmTransaction, real
// TransactionExpiredBlockheightExceededError.
// ---------------------------------------------------------------------------
const ZERO_BLOCKHASH = '1'.repeat(32);            // 32 base58 zero bytes: a structurally valid blockhash
// web3.js decodes and length-checks every signature it is handed, so these have to be real base58 of
// real 64-byte arrays — not a repeated string.
const sigFor = (n: number): string => bs58.encode(Buffer.alloc(64, n));

interface ExpiryOpts { landsOn: number | null }

// Answers every call `send` makes. `landsOn` is the 1-based attempt whose signature the cluster
// admits to having, or null for "none of them ever landed".
function expiringRpc(rpc: FakeRpc, { landsOn }: ExpiryOpts): { sends: () => number } {
  let sends = 0;
  rpc.respond((method) => {
    switch (method) {
      case 'getLatestBlockhash':
        return { context: { slot: 1 }, value: { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 100 } };
      case 'sendTransaction':
        sends += 1;
        return sigFor(sends);
      // Already past lastValidBlockHeight, so confirmTransaction gives up immediately.
      case 'getBlockHeight':
        return 5_000;
      case 'getSignatureStatuses': {
        const landed = landsOn !== null && sends === landsOn;
        return {
          context: { slot: 2 },
          value: [landed ? { slot: 2, confirmations: null, err: null, confirmationStatus: 'confirmed' } : null],
        };
      }
      default:
        return null;
    }
  });
  return { sends: () => sends };
}

describe('chain/solana blockhash expiry', () => {
  const to = (): string => Keypair.generate().publicKey.toBase58();
  const secret = (): Uint8Array => Keypair.generate().secretKey;

  it('resends on an expired blockhash and gives up as tx_failed once the attempts are spent', async () => {
    const { sends } = expiringRpc(rpc, { landsOn: null });

    await expect(chain.transferSol(secret(), to(), 1_000)).rejects.toSatisfy((e) => isChainError(e, 'tx_failed'));
    // A fresh blockhash per attempt, so each resend is a genuinely different transaction.
    expect(sends()).toBe(3);
    expect(rpc.calls.filter((m) => m === 'getLatestBlockhash')).toHaveLength(3);
  }, 30_000);

  // The money bug. confirmTransaction races the block-height check against the signature
  // subscription, so it can report expiry for a transaction that was included in the last valid
  // block. Returning the landed signature is the difference between "swept" and a purchase row that
  // says `sweep failed` over an address that has already been emptied.
  it('returns the signature of a transaction that expired but had in fact landed', async () => {
    const { sends } = expiringRpc(rpc, { landsOn: 1 });

    const { sig } = await chain.transferSol(secret(), to(), 1_000);
    expect(sig).toBe(sigFor(1));
    expect(sends()).toBe(1);                       // it never resent
  }, 30_000);

  // The same check has to run on the LAST attempt too. It used to be guarded by
  // `attempt < SEND_ATTEMPTS`, so the final expiry threw tx_failed without ever asking the cluster.
  it('still checks whether the final attempt landed before calling it a failure', async () => {
    const { sends } = expiringRpc(rpc, { landsOn: 3 });

    const { sig } = await chain.transferSol(secret(), to(), 1_000);
    expect(sig).toBe(sigFor(3));
    expect(sends()).toBe(3);
  }, 30_000);

  // A landed-but-failed transaction is not a success: the lamports never moved, so the caller must
  // see tx_failed and be free to retry.
  it('does not mistake a transaction that landed with an error for a successful one', async () => {
    rpc.respond((method) => {
      if (method === 'getLatestBlockhash') return { context: { slot: 1 }, value: { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 100 } };
      if (method === 'sendTransaction') return sigFor(9);
      if (method === 'getBlockHeight') return 5_000;
      if (method === 'getSignatureStatuses') {
        return { context: { slot: 2 }, value: [{ slot: 2, confirmations: null, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] };
      }
      return null;
    });

    await expect(chain.transferSol(secret(), to(), 1_000)).rejects.toSatisfy((e) => isChainError(e, 'tx_failed'));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Signature pagination and the scan budget. A deposit address in the live tests has two or three
// transactions, so neither the `before` cursor nor MAX_SCAN_TXS is reachable there — but an agent
// wallet that has been trading for a month reaches both, and a cursor bug there silently loses
// deposits. Driven from a fake RPC because a thousand real transactions is not a test.
// ---------------------------------------------------------------------------
const sigAt = (n: number): string => bs58.encode(Buffer.alloc(64, 0).fill(n % 251, 0, 8));

const sigInfo = (sig: string, slot: number) => ({ signature: sig, slot, err: null, memo: null, blockTime: slot });

describe('chain/solana signature pagination', () => {
  const owner = (): string => Keypair.generate().publicKey.toBase58();

  // getSignaturesForAddress returns newest first and caps each page, so a full page means "there may
  // be more" and the next request has to walk backwards with `before`.
  it('walks a full page backwards with the before cursor and stops on a short page', async () => {
    const page1 = Array.from({ length: SIGNATURE_PAGE }, (_, i) => sigInfo(sigAt(i), 10_000 - i));
    const page2 = [sigInfo(sigAt(9_001), 1), sigInfo(sigAt(9_002), 0)];
    rpc.respond((method, params) => {
      if (method !== 'getSignaturesForAddress') return null;
      const opts = (params[1] ?? {}) as { before?: string };
      return opts.before === undefined ? page1 : page2;
    });

    await chain.listUsdcInflows(owner(), null, 10);

    const asked = rpc.requests.filter((r) => r.method === 'getSignaturesForAddress');
    expect(asked).toHaveLength(2);                       // a short second page ends it
    expect((asked[0]!.params[1] as { limit: number }).limit).toBe(SIGNATURE_PAGE);
    // The second page resumes strictly after the oldest signature of the first.
    expect((asked[1]!.params[1] as { before: string }).before).toBe(page1[SIGNATURE_PAGE - 1]!.signature);
  }, 60_000);

  // The 5000-signature ceiling. Left unbounded, one busy address makes a single poll walk history
  // forever on a metered endpoint; left silent, a truncated walk is indistinguishable from "nothing
  // older exists". Both halves are pinned here: it stops at exactly MAX_SIGNATURE_PAGES, and it says so.
  it('stops listing at the page ceiling and warns that the view is truncated', async () => {
    const full = Array.from({ length: SIGNATURE_PAGE }, (_, i) => sigInfo(sigAt(i), 10_000 - i));
    // Every page is full, so the walk would never end on its own.
    rpc.respond((method) => (method === 'getSignaturesForAddress' ? full : null));

    const warnings: string[] = [];
    const loud = createSolanaChain(solanaConfig(rpc.url), capturingLogger(warnings));

    await loud.listUsdcInflows(owner(), null, 1);

    expect(rpc.calls.filter((m) => m === 'getSignaturesForAddress')).toHaveLength(MAX_SIGNATURE_PAGES);
    expect(warnings.join('\n')).toContain('signature history hit the page ceiling');
  }, 120_000);

  it('passes sinceSig to the node as an exclusive `until` rather than filtering locally', async () => {
    const cursor = sigAt(77);
    rpc.respond((method) => (method === 'getSignaturesForAddress' ? [] : null));

    await chain.listUsdcInflows(owner(), cursor, 10);

    const asked = rpc.requests.find((r) => r.method === 'getSignaturesForAddress');
    expect((asked!.params[1] as { until: string }).until).toBe(cursor);
  });

  // Signatures are cheap to list and expensive to parse. Without a ceiling, one busy address would
  // make a single poll issue thousands of getTransaction calls against a metered endpoint.
  it('stops parsing at the scan budget instead of fetching every transaction it listed', async () => {
    const page1 = Array.from({ length: SIGNATURE_PAGE }, (_, i) => sigInfo(sigAt(i), 10_000 - i));
    rpc.respond((method, params) => {
      if (method === 'getSignaturesForAddress') {
        const opts = (params[1] ?? {}) as { before?: string };
        return opts.before === undefined ? page1 : [];
      }
      return null;                                        // every parse is a miss; only the count matters
    });

    expect(await chain.listUsdcInflows(owner(), null, 100)).toEqual([]);
    expect(rpc.calls.filter((m) => m === 'getTransaction')).toHaveLength(MAX_SCAN_TXS);
  }, 120_000);
});

describe('chain/solana deposit balance reads', () => {
  const someone2 = (): string => Keypair.generate().publicKey.toBase58();

  // The poller calls this for every pending purchase on every tick, so it is the read most exposed to
  // throttling. It used to bypass the retry helper entirely.
  it('retries a throttled getUsdcBalance instead of failing the poll', async () => {
    let seen = 0;
    rpc.respond((method) => {
      if (method !== 'getAccountInfo') return null;
      seen += 1;
      return seen < 3 ? RATE_LIMITED : { context: { slot: 1 }, value: null };
    });

    expect(await chain.getUsdcBalance(someone2())).toBe(0);
    expect(seen).toBe(3);
  }, 30_000);

  it('still reports a throttle that never clears as an rpc_error, not as a zero balance', async () => {
    rpc.respond(() => RATE_LIMITED);
    // Zero here would tell the poller the buyer never paid.
    await expect(chain.getUsdcBalance(someone2())).rejects.toSatisfy((e) => isChainError(e, 'rpc_error'));
  }, 30_000);
});
