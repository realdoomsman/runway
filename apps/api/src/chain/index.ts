// Chain module: the ChainAdapter (memory simulator or real Solana), the protocol wallets and key
// custody, the treasury service and transaction verification.
import type { Config } from '../config.js';
import type { ChainAdapter, Clock } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import { createMemoryChain } from './memory.js';
import { createSolanaChain } from './solana.js';

// CHAIN_MODE=memory → in-process simulator (funds the treasury float, exposes faucet); solana → devnet/mainnet.
// SPEC-V2 §5.6, §5.7. The treasury itself is one instance per container: economy/treasury.ts builds it
// from createTreasuryService + createTreasuryStore.
// `clock` only reaches the simulator, which stamps its transactions with it so demo history is dated
// by the fast-forward clock rather than by wall time.
export async function createChain(config: Config, log: Logger, opts: { clock?: Clock } = {}): Promise<ChainAdapter> {
  const chain = config.chain.mode === 'memory' ? createMemoryChain(config, log, opts) : createSolanaChain(config, log);
  log.info(
    { mode: chain.mode, cluster: chain.cluster, usdcMint: chain.usdcMint, treasury: chain.wallets.treasury.pubkey },
    'chain ready',
  );
  return chain;
}

export { ChainError, isChainError, type ChainErrorCode } from './errors.js';
export {
  decryptSecret, encryptSecret, keypairFromSecret, loadSecret, pubkeyOfSecret, wipeSecret, type EncryptedSecret,
} from './keys.js';
export { loadAgentSecret, storeAgentKey, withAgentSecret } from './keystore.js';
export { createMemoryChain, type MemoryChain } from './memory.js';
export {
  TREASURY_SYNC_INTERVAL_MS, createTreasuryService,
  type FundAgentOpts, type FundingPayout, type GasTopUp, type RecordPurchaseInput, type TreasuryAgentRef,
  type TreasuryInflowKind, type TreasuryService,
} from './pool.js';
export { TREASURY_ROW_ID, createTreasuryStore, type TreasuryStore, type TreasuryTxInsert } from './poolStore.js';
export { deriveAta, extractTokenTransfers, largestUsdcTransfer, usdcInflowsTo, type TokenTransfer } from './parse.js';
export { createSolPriceSource, lamportsToMicro, type SolPriceSource } from './price.js';
export { createSolanaChain } from './solana.js';
export { invalidTx, shortAddr, verifyUsdcTransfer, type VerifyUsdcOpts } from './verify.js';
export { getProtocolWallets, type ProtocolWallets, type Signer, type WalletAwareChain } from './wallets.js';
