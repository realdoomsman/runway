import { Keypair, PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  blockTimeToDate, deriveAta, extractTokenTransfers, largestUsdcTransfer, usdcInflowsTo,
} from '../../src/chain/parse.js';

const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const OTHER_MINT = 'So11111111111111111111111111111111111111112';

const addr = (): string => Keypair.generate().publicKey.toBase58();
const buyer = addr();
const agent = addr();
const buyerAta = addr();
const agentAta = addr();

interface Ix { program: string; type: string; info: Record<string, unknown> }
interface TxSpec {
  instructions?: Ix[];
  inner?: Ix[];
  balances?: { account: string; owner: string | null; mint: string }[];
  blockTime?: number | null;
  raw?: Ix[];      // instructions with no `parsed` payload (e.g. a compiled program call)
}

// Minimal getParsedTransaction payload: only the fields chain/parse.ts reads.
function parsedTx(spec: TxSpec): ParsedTransactionWithMeta {
  const accounts = spec.balances ?? [];
  const accountKeys = accounts.map((b) => ({ pubkey: new PublicKey(b.account), signer: false, writable: true }));
  const toIx = (ix: Ix) => ({ program: ix.program, programId: new PublicKey(OTHER_MINT), parsed: { type: ix.type, info: ix.info } });
  return {
    blockTime: spec.blockTime === undefined ? 1_760_000_000 : spec.blockTime,
    slot: 42,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys,
        instructions: [...(spec.instructions ?? []).map(toIx), ...(spec.raw ?? []).map((ix) => ({ programId: new PublicKey(OTHER_MINT), accounts: [], data: ix.type }))],
        recentBlockhash: '',
      },
    },
    meta: {
      err: null, fee: 5000, preBalances: [], postBalances: [],
      preTokenBalances: [],
      postTokenBalances: accounts.map((b, i) => ({
        accountIndex: i, mint: b.mint, owner: b.owner ?? undefined,
        uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
      })),
      innerInstructions: spec.inner ? [{ index: 0, instructions: spec.inner.map(toIx) }] : [],
      logMessages: [],
    },
  } as unknown as ParsedTransactionWithMeta;
}

const usdcBalances = [
  { account: buyerAta, owner: buyer, mint: USDC_MAINNET },
  { account: agentAta, owner: agent, mint: USDC_MAINNET },
];

const transferIx = (amount: string, extra: Record<string, unknown> = {}): Ix => ({
  program: 'spl-token', type: 'transfer',
  info: { source: buyerAta, destination: agentAta, authority: buyer, amount, ...extra },
});

describe('chain/parse', () => {
  it('derives the associated token account for a wallet and mint', () => {
    const owner = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    expect(deriveAta(owner, USDC_MAINNET)).toBe('FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B');
    expect(deriveAta(owner, USDC_DEVNET)).toBe('HwpBSwuyVKJi7d9kqqNexc54MS9i4BEDKDVDLeUVjZm8');
    expect(deriveAta(agent, USDC_MAINNET)).not.toBe(deriveAta(buyer, USDC_MAINNET));
  });

  it('extracts a plain SPL transfer and resolves owners from token balances', () => {
    const [t, ...rest] = extractTokenTransfers(parsedTx({ instructions: [transferIx('2500000')], balances: usdcBalances }));
    expect(rest).toEqual([]);
    expect(t).toEqual({ destination: agentAta, from: buyer, to: agent, mint: USDC_MAINNET, amount: 2_500_000 });
  });

  it('reads transferChecked (tokenAmount) and mintTo instructions', () => {
    const checked = parsedTx({
      instructions: [{
        program: 'spl-token', type: 'transferChecked',
        info: { source: buyerAta, destination: agentAta, authority: buyer, mint: USDC_MAINNET, tokenAmount: { amount: '1000000', decimals: 6 } },
      }],
      balances: usdcBalances,
    });
    expect(extractTokenTransfers(checked)[0]).toMatchObject({ to: agent, amount: 1_000_000, mint: USDC_MAINNET });

    const minted = parsedTx({
      instructions: [{ program: 'spl-token', type: 'mintTo', info: { account: agentAta, mintAuthority: buyer, mint: USDC_MAINNET, amount: '7000000' } }],
      balances: usdcBalances,
    });
    expect(extractTokenTransfers(minted)[0]).toMatchObject({ from: buyer, to: agent, amount: 7_000_000 });
  });

  it('includes inner instructions and ignores everything else', () => {
    const tx = parsedTx({
      instructions: [{ program: 'system', type: 'transfer', info: { source: buyer, destination: agent, lamports: 1 } }],
      inner: [transferIx('500000'), { program: 'spl-token', type: 'closeAccount', info: { account: buyerAta } }],
      raw: [{ program: 'x', type: 'deadbeef', info: {} }],
      balances: usdcBalances,
    });
    expect(extractTokenTransfers(tx)).toEqual([{ destination: agentAta, from: buyer, to: agent, mint: USDC_MAINNET, amount: 500_000 }]);
  });

  it('reports the source account owner, not a delegate that signed for it', () => {
    const delegate = addr();
    const tx = parsedTx({ instructions: [transferIx('300000', { authority: delegate })], balances: usdcBalances });
    expect(extractTokenTransfers(tx)[0]).toMatchObject({ from: buyer, to: agent });
  });

  it('falls back to the token account when its owner is unknown, keeping the mint from the source side', () => {
    const tx = parsedTx({ instructions: [transferIx('100')], balances: [{ account: buyerAta, owner: buyer, mint: USDC_MAINNET }] });
    expect(extractTokenTransfers(tx)[0]).toMatchObject({ to: agentAta, mint: USDC_MAINNET });
    const blind = parsedTx({ instructions: [transferIx('100')], balances: [] });
    expect(extractTokenTransfers(blind)[0]).toMatchObject({ from: buyer, to: agentAta, mint: null });
  });

  it('filters inflows to one ATA and one mint', () => {
    const tx = parsedTx({
      instructions: [
        transferIx('1000000'),
        { program: 'spl-token', type: 'transfer', info: { source: buyerAta, destination: buyerAta, authority: agent, amount: '9' } },
      ],
      balances: usdcBalances,
    });
    expect(usdcInflowsTo(tx, agentAta, USDC_MAINNET).map((t) => t.amount)).toEqual([1_000_000]);
    expect(usdcInflowsTo(tx, agentAta, USDC_DEVNET)).toEqual([]);   // wrong mint for this cluster
    expect(usdcInflowsTo(tx, buyerAta, USDC_MAINNET).map((t) => t.amount)).toEqual([9]);
  });

  it('picks the largest USDC transfer and ignores other mints', () => {
    const wsolAta = addr();
    const tx = parsedTx({
      instructions: [
        transferIx('250000'),
        transferIx('4000000'),
        { program: 'spl-token', type: 'transfer', info: { source: wsolAta, destination: wsolAta, authority: buyer, amount: '99999999', mint: OTHER_MINT } },
      ],
      balances: [...usdcBalances, { account: wsolAta, owner: agent, mint: OTHER_MINT }],
    });
    expect(largestUsdcTransfer(tx, USDC_MAINNET)).toEqual({ from: buyer, to: agent, amount: 4_000_000 });
    expect(largestUsdcTransfer(parsedTx({ balances: usdcBalances }), USDC_MAINNET)).toBeNull();
  });

  it('converts block times, treating a missing one as the epoch', () => {
    expect(blockTimeToDate(1_760_000_000).toISOString()).toBe('2025-10-09T08:53:20.000Z');
    expect(blockTimeToDate(null).getTime()).toBe(0);
  });
});
