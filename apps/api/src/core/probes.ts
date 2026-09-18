// The real implementations behind PreflightProbes. Kept out of preflight.ts so the rules stay
// testable without dockerode or a Connection, and so this file is the only place that reaches the
// outside world at boot.
import { Connection } from '@solana/web3.js';
import Docker from 'dockerode';
import { getProtocolWallets } from '../chain/wallets.js';
import type { Config } from '../config.js';
import type { ChainAdapter } from './interfaces.js';
import type { PreflightProbes } from './preflight.js';

export function realProbes(config: Config, chain: ChainAdapter): PreflightProbes {
  const docker = new Docker();
  return {
    dockerPing: async () => { await docker.ping(); },
    dockerImage: async (image: string) => { await docker.getImage(image).inspect(); },
    genesisHash: async (rpcUrl: string) => new Connection(rpcUrl, { commitment: 'confirmed' }).getGenesisHash(),
    treasuryLamports: async () => chain.getSolBalance(getProtocolWallets(config).treasury.pubkey),
  };
}
