// Prepares a local Agave validator so the write half of solana.live.test.ts and all of
// poller.live.test.ts can run: funds the payer with SOL and creates a 6-decimal SPL mint that stands
// in for USDC, then mints a float to the payer.
//
// This exists because devnet cannot be used for the write tests. Signing anything on devnet needs SOL
// for fees, the faucet is the only free source, and it answers 429 ("reached your airdrop limit today
// or the faucet has run dry") to every request — across addresses, amounts and both the CLI and the
// raw requestAirdrop RPC. Devnet USDC is worse: the only tap is faucet.circle.com, which is an
// interactive web form. A local validator is the same Agave runtime running the same SPL Token,
// Associated Token Account and Memo programs, so the adapter code under test is identical.
//
//   solana-test-validator --reset --quiet --ledger /tmp/runway-ledger
//   pnpm --filter @runway/api exec tsx test/chain/setup-local-validator.ts
//   # then export the MINT it prints:
//   SOLANA_RPC_URL=http://127.0.0.1:8899 \
//   RUNWAY_IT_PAYER=~/.config/solana/runway-test.json \
//   RUNWAY_IT_USDC_MINT=<mint> \
//   RUNWAY_IT_DATABASE_URL=postgres://localhost:5432/runway_chain_test \
//   pnpm --filter @runway/api exec vitest run test/chain/solana.live.test.ts test/chain/poller.live.test.ts
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { loadSecret } from '../../src/chain/keys.js';

const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'http://127.0.0.1:8899';
const PAYER_SOURCE = process.env['RUNWAY_IT_PAYER'] ?? `${process.env['HOME']}/.config/solana/runway-test.json`;
const AIRDROP_SOL = 100;
const MINT_FLOAT = 5_000_000_000_000;      // $5,000,000 at 6 decimals
const USDC_DECIMALS = 6;

async function main(): Promise<void> {
  const connection = new Connection(RPC_URL, { commitment: 'confirmed' });
  const payer = Keypair.fromSecretKey(loadSecret(PAYER_SOURCE));
  process.stdout.write(`rpc    ${RPC_URL}\npayer  ${payer.publicKey.toBase58()}\n`);

  // Refuse to run against a cluster where an airdrop would be a real request to a shared faucet.
  const genesis = await connection.getGenesisHash();
  if (!/^(127\.0\.0\.1|localhost)/.test(new URL(RPC_URL).hostname)) {
    throw new Error(`refusing to seed a non-local cluster (${RPC_URL}, genesis ${genesis})`);
  }

  if (await connection.getBalance(payer.publicKey, 'confirmed') < 10 * LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(payer.publicKey, AIRDROP_SOL * LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  }
  process.stdout.write(`sol    ${await connection.getBalance(payer.publicKey, 'confirmed') / LAMPORTS_PER_SOL}\n`);

  const mint = await createMint(connection, payer, payer.publicKey, null, USDC_DECIMALS);
  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  await mintTo(connection, payer, mint, ata.address, payer, MINT_FLOAT);
  const balance = await connection.getTokenAccountBalance(ata.address, 'confirmed');
  process.stdout.write(`ata    ${ata.address.toBase58()}\ntokens ${balance.value.amount} (${balance.value.decimals} decimals)\n`);
  process.stdout.write(`\nRUNWAY_IT_USDC_MINT=${mint.toBase58()}\n`);
}

await main();
