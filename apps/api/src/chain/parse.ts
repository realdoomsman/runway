// Pure helpers over `getParsedTransaction` payloads: SPL token transfers into an account, resolved to
// wallet owners via the transaction's token balances. No network access; unit-tested with fixtures.
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from '@solana/web3.js';
import type { Micro } from '@runway/shared';

export const USDC_DECIMALS = 6;

export interface TokenTransfer {
  destination: string;   // token account credited
  from: string;          // owner of the source token account (falls back to the signing authority, or the mint authority)
  to: string;            // owner of the destination token account, or the token account itself if unknown
  mint: string | null;   // null when the instruction carries no mint and the tx has no token balances for it
  amount: number;        // base units
}

export function deriveAta(owner: string, mint: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true).toBase58();
}

const TOKEN_PROGRAMS = new Set(['spl-token', 'spl-token-2022']);
type Info = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isParsed = (ix: ParsedInstruction | PartiallyDecodedInstruction): ix is ParsedInstruction => 'parsed' in ix;

function amountOf(info: Info): number | null {
  const tokenAmount = info.tokenAmount as Info | undefined;
  const raw = str(info.amount) ?? (tokenAmount ? str(tokenAmount.amount) : null);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// token account → { owner, mint } from pre/post token balances (post wins).
function tokenAccountIndex(tx: ParsedTransactionWithMeta): Map<string, { owner: string | null; mint: string }> {
  const keys = tx.transaction.message.accountKeys;
  const out = new Map<string, { owner: string | null; mint: string }>();
  for (const balance of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
    const key = keys[balance.accountIndex];
    if (key) out.set(key.pubkey.toBase58(), { owner: balance.owner ?? null, mint: balance.mint });
  }
  return out;
}

function allInstructions(tx: ParsedTransactionWithMeta): (ParsedInstruction | PartiallyDecodedInstruction)[] {
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions);
  return [...tx.transaction.message.instructions, ...inner];
}

// Every transfer / transferChecked / mintTo / mintToChecked in the transaction, top-level and inner.
export function extractTokenTransfers(tx: ParsedTransactionWithMeta): TokenTransfer[] {
  const accounts = tokenAccountIndex(tx);
  const out: TokenTransfer[] = [];
  for (const ix of allInstructions(tx)) {
    if (!isParsed(ix) || !TOKEN_PROGRAMS.has(ix.program)) continue;
    const parsed = ix.parsed as { type?: unknown; info?: unknown };
    const info = parsed.info;
    if (!info || typeof info !== 'object') continue;
    const amount = amountOf(info as Info);
    if (amount === null) continue;
    const type = str(parsed.type);
    const entry = type === 'transfer' || type === 'transferChecked' ? transferInfo(info as Info)
      : type === 'mintTo' || type === 'mintToChecked' ? mintInfo(info as Info)
      : null;
    if (!entry) continue;
    const account = accounts.get(entry.destination);
    const source = entry.source ? accounts.get(entry.source) : undefined;
    out.push({
      destination: entry.destination,
      from: source?.owner ?? entry.authority,           // a delegate signs for the owner; report the owner
      to: account?.owner ?? entry.destination,
      mint: entry.mint ?? account?.mint ?? source?.mint ?? null,
      amount,
    });
  }
  return out;
}

interface TransferSides { destination: string; source: string | null; authority: string; mint: string | null }

function transferInfo(info: Info): TransferSides | null {
  const destination = str(info.destination);
  const authority = str(info.authority) ?? str(info.multisigAuthority);
  return destination && authority ? { destination, source: str(info.source), authority, mint: str(info.mint) } : null;
}

function mintInfo(info: Info): TransferSides | null {
  const destination = str(info.account);
  const authority = str(info.mintAuthority);
  return destination && authority ? { destination, source: null, authority, mint: str(info.mint) } : null;
}

// Transfers credited to `ata` (an associated USDC account, so a missing mint still means USDC).
export function usdcInflowsTo(tx: ParsedTransactionWithMeta, ata: string, usdcMint: string): TokenTransfer[] {
  return extractTokenTransfers(tx).filter((t) => t.destination === ata && (t.mint === null || t.mint === usdcMint));
}

export interface ResolvedInflow { from: string; amount: Micro; senders: string[] }

/**
 * Collapses every USDC leg of ONE transaction into the single inflow the rest of the system sees.
 *
 * It has to be one row per signature: runtime/deposits.ts dedupes on `deposits_seen.sig`, so a second
 * row carrying the same signature would be dropped by the conflict clause with its money uncredited.
 * The amount is therefore the sum of all legs — which is what actually arrived — and `from` names one
 * of possibly several senders.
 *
 * It names the sender of the LARGEST leg, not the first the RPC happened to return. `from` becomes
 * `refundTo` on an underpaid purchase (payments/poller.ts), so with first-wins anyone could attach a
 * 1-micro leg to someone else's $100 deposit and have the entire refund redirected to themselves.
 * `senders` is returned so the caller can say out loud that the choice was ambiguous.
 */
export function resolveInflow(parts: readonly TokenTransfer[]): ResolvedInflow | null {
  if (parts.length === 0) return null;
  const largest = parts.reduce((a, b) => (b.amount > a.amount ? b : a));
  return {
    from: largest.from,
    amount: parts.reduce((sum, p) => sum + p.amount, 0),
    senders: [...new Set(parts.map((p) => p.from))],
  };
}

export interface UsdcTransferSummary { from: string; to: string; amount: Micro }

// The largest USDC transfer in the transaction — the one a user-submitted payment/escrow sig is about.
export function largestUsdcTransfer(tx: ParsedTransactionWithMeta, usdcMint: string): UsdcTransferSummary | null {
  const usdc = extractTokenTransfers(tx).filter((t) => t.mint === usdcMint);
  if (usdc.length === 0) return null;
  const best = usdc.reduce((a, b) => (b.amount > a.amount ? b : a));
  return { from: best.from, to: best.to, amount: best.amount };
}

export const blockTimeToDate = (blockTime: number | null | undefined): Date => new Date((blockTime ?? 0) * 1000);
