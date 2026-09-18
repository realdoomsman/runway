import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { rpcEndpoint } from '../lib/mode';
import { useAppStore } from '../store/app';

/** ConnectionProvider (RPC from stats.chain) + Phantom/Solflare adapters wrapping the app. */
export function SolanaProviders({ children }: { children: ReactNode }) {
  const mode = useAppStore((s) => s.stats?.chain.mode);
  const cluster = useAppStore((s) => s.stats?.chain.cluster);
  const endpoint = useMemo(() => rpcEndpoint(mode && cluster ? { mode, cluster } : null), [mode, cluster]);
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect onError={(e) => console.warn('[wallet]', e.message)}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
