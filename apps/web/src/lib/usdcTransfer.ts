// Build + send an SPL USDC transfer with the connected wallet-adapter wallet.
// Creates the destination ATA when missing. Returns the tx signature.
import { useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Micro } from '@runway/shared';
import { useAppStore } from '../store/app';

const USDC_DECIMALS = 6;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export interface UsdcTransferParams {
  connection: Connection;
  owner: PublicKey;
  sendTransaction: WalletContextState['sendTransaction'];
  usdcMint: string;
  to: string;
  amountMicro: Micro;
  memo?: string;
}

export async function sendUsdcTransfer(p: UsdcTransferParams): Promise<string> {
  if (!Number.isInteger(p.amountMicro) || p.amountMicro <= 0) throw new Error('Amount must be a positive whole number of micro-USDC');
  const mint = new PublicKey(p.usdcMint);
  const to = new PublicKey(p.to);
  const source = getAssociatedTokenAddressSync(mint, p.owner);
  const dest = getAssociatedTokenAddressSync(mint, to, true);

  const balance = await p.connection.getTokenAccountBalance(source).catch(() => null);
  if (!balance) throw new Error('No USDC token account for this wallet');
  if (BigInt(balance.value.amount) < BigInt(p.amountMicro)) throw new Error('Insufficient USDC balance');

  const tx = new Transaction();
  const destInfo = await p.connection.getAccountInfo(dest);
  if (!destInfo) tx.add(createAssociatedTokenAccountInstruction(p.owner, dest, to, mint));
  tx.add(createTransferCheckedInstruction(source, mint, dest, p.owner, BigInt(p.amountMicro), USDC_DECIMALS));
  if (p.memo) tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(p.memo, 'utf8') }));

  const { blockhash, lastValidBlockHeight } = await p.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = p.owner;

  const signature = await p.sendTransaction(tx, p.connection);
  const conf = await p.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error(`Transaction failed: ${JSON.stringify(conf.value.err)}`);
  return signature;
}

export type UsdcSender = (to: string, amountMicro: Micro, memo?: string) => Promise<string>;

/** Hook form: binds connection, wallet and the configured USDC mint. Throws if not connected. */
export function useUsdcTransfer(): UsdcSender {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const usdcMint = useAppStore((s) => s.stats?.chain.usdcMint ?? null);

  return useCallback(
    async (to, amountMicro, memo) => {
      if (!publicKey) throw new Error('Connect a wallet first');
      if (!usdcMint) throw new Error('USDC mint not loaded yet');
      return sendUsdcTransfer({ connection, owner: publicKey, sendTransaction, usdcMint, to, amountMicro, memo });
    },
    [connection, publicKey, sendTransaction, usdcMint],
  );
}
