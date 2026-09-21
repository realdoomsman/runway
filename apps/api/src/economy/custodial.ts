// Custodial wallets for Google owners (SPEC-V2 §6.2 extension). A Google login has no wallet of its
// own, so the server holds one for it: a Solana keypair generated on first login, its secret encrypted
// at rest in `user_keys` (same AES-256-GCM custody as agent keys) and NEVER returned by any API. The
// owner deposits USDC to the wallet's address and withdraws it to any Solana address; the treasury
// sponsors the gas and any destination-ATA rent, so the custodial wallet itself never needs SOL.
import { eq } from 'drizzle-orm';
import { Keypair } from '@solana/web3.js';
import { fmtUsd, isGoogleOwnerId, type CustodialWallet, type CustodialWithdrawResponse } from '@runway/shared';
import { wipeSecret } from '../chain/keys.js';
import { storeUserKey, withUserSecret } from '../chain/keystore.js';
import { getProtocolWallets } from '../chain/wallets.js';
import type { CoreDeps } from '../core/interfaces.js';
import { users } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { isSolanaAddress } from '../lib/solana.js';
import { loadUser } from './repo.js';

type Deps = CoreDeps;

// Idempotent: returns the existing custodial address, or generates + persists one on first call. Only a
// Google owner gets one — a wallet owner already has their own key, a claim owner is tied to one agent.
export async function ensureCustodialWallet(deps: Deps, ownerId: string): Promise<string> {
  if (!isGoogleOwnerId(ownerId)) throw badRequest('Only Google accounts have a custodial wallet');
  const existing = await loadUser(deps.db, ownerId);
  if (existing?.custodialPubkey) return existing.custodialPubkey;
  const kp = new Keypair();
  try {
    const pubkey = await storeUserKey(deps.db, deps.config.keyEncryptionKey, ownerId, kp.secretKey);
    await deps.db.update(users).set({ custodialPubkey: pubkey }).where(eq(users.wallet, ownerId));
    deps.log.info({ ownerId, pubkey }, 'custodial wallet created');
    return pubkey;
  } catch (e) {
    // A racing login/request already inserted the row — fall back to the persisted one.
    const row = await loadUser(deps.db, ownerId);
    if (row?.custodialPubkey) return row.custodialPubkey;
    throw e;
  } finally {
    wipeSecret(kp.secretKey);
  }
}

// The address to deposit to plus its live on-chain balances.
export async function custodialWallet(deps: Deps, ownerId: string): Promise<CustodialWallet> {
  const pubkey = await ensureCustodialWallet(deps, ownerId);
  const [usdcMicro, solLamports] = await Promise.all([
    deps.chain.getUsdcBalance(pubkey),
    deps.chain.getSolBalance(pubkey),
  ]);
  return { pubkey, usdcMicro, solLamports };
}

// Sends `amountMicro` USDC from the custodial wallet to any Solana address. The treasury is the fee
// payer (sweepUsdc), so the custodial wallet needs no SOL and the destination ATA is created if missing.
export async function withdrawCustodial(deps: Deps, ownerId: string, to: string, amountMicro: number): Promise<CustodialWithdrawResponse> {
  if (!isGoogleOwnerId(ownerId)) throw badRequest('Only Google accounts have a custodial wallet');
  const dest = to.trim();
  if (!isSolanaAddress(dest)) throw badRequest('That is not a Solana address');
  if (!Number.isInteger(amountMicro) || amountMicro <= 0) throw badRequest('Amount must be a positive number of micro-USDC');
  const pubkey = await ensureCustodialWallet(deps, ownerId);
  const balance = await deps.chain.getUsdcBalance(pubkey);
  if (amountMicro > balance) throw badRequest(`Balance is only ${fmtUsd(balance)}`);
  const wallets = getProtocolWallets(deps.config);
  const { sig } = await withUserSecret(deps.db, deps.config.keyEncryptionKey, ownerId, (secret) =>
    deps.chain.sweepUsdc(secret, wallets.treasury.secret, [{ to: dest, amount: amountMicro }], 'RUNWAY withdraw'));
  deps.log.info({ ownerId, to: dest, amountMicro, sig }, 'custodial withdraw');
  return { sentMicro: amountMicro, txSig: sig };
}
