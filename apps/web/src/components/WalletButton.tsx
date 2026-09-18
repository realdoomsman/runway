import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import type { WalletName } from '@solana/wallet-adapter-base';
import { shortKey } from '../lib/format';
import { useAppStore } from '../store/app';
import { useWalletStore } from '../store/wallet';

/**
 * Custom wallet control (no wallet-adapter-react-ui CSS).
 * A claim-code session wins over everything: it is a real owner identity with no wallet at all.
 * memory/demo mode → "DEMO WALLET" signs in through POST /api/auth/demo.
 * otherwise: pick Phantom/Solflare → connect → SIGN IN (nonce/sign/verify) → session.
 */
export function WalletButton() {
  const demo = useAppStore((s) => (s.stats ? s.stats.demo : null));
  const me = useAppStore((s) => s.me);
  if (me && me.ownerKind === 'claim') return <ClaimSessionButton />;
  if (demo === null) return <button type="button" className="wallet-btn" disabled>…</button>;
  return demo ? <DemoWalletButton /> : <AdapterWalletButton />;
}

function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return { open, setOpen, ref };
}

function MyAgentsLink({ onGo }: { onGo: () => void }) {
  return (
    <Link className="wm-link" to="/mine" onClick={onGo}>
      MY AGENTS
    </Link>
  );
}

/** The no-wallet identity: the claim code already minted the same session cookie. */
function ClaimSessionButton() {
  const me = useAppStore((s) => s.me);
  const { signOut } = useWalletStore();
  const { open, setOpen, ref } = useMenu();
  if (!me) return null;

  return (
    <div className="wallet-wrap" ref={ref}>
      <button type="button" className="wallet-btn connected" onClick={() => setOpen((o) => !o)}>
        CLAIM <b>{me.agents.length} AGENT{me.agents.length === 1 ? '' : 'S'}</b>
      </button>
      {open && (
        <div className="wallet-menu">
          <div className="wm-note">CLAIM-CODE IDENTITY · NO WALLET</div>
          <MyAgentsLink onGo={() => setOpen(false)} />
          <button type="button" onClick={() => { setOpen(false); void signOut(); }}>SIGN OUT</button>
        </div>
      )}
    </div>
  );
}

function DemoWalletButton() {
  const me = useAppStore((s) => s.me);
  const { status, error, signInDemo, signOut, clearError } = useWalletStore();
  const { open, setOpen, ref } = useMenu();

  if (me) {
    return (
      <div className="wallet-wrap" ref={ref}>
        <button type="button" className="wallet-btn connected" onClick={() => setOpen((o) => !o)}>
          DEMO <b>{shortKey(me.wallet ?? me.ownerId, 9, 4)}</b>
        </button>
        {open && (
          <div className="wallet-menu">
            <div className="wm-note">SIMULATED SESSION · NO KEYS</div>
            <MyAgentsLink onGo={() => setOpen(false)} />
            <button type="button" onClick={() => { setOpen(false); void signOut(); }}>SIGN OUT</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="wallet-wrap" ref={ref}>
      <button type="button" className="wallet-btn" disabled={status === 'signing'} onClick={() => { clearError(); void signInDemo(); }}>
        {status === 'signing' ? 'SIGNING…' : 'DEMO WALLET'}
      </button>
      {error && (
        <div className="wallet-menu">
          <div className="wm-note wm-err">{error}</div>
        </div>
      )}
    </div>
  );
}

function AdapterWalletButton() {
  const me = useAppStore((s) => s.me);
  const { wallets, wallet, select, connect, disconnect, connected, connecting, publicKey, signMessage } = useWallet();
  const { status, error, signIn, signOut, clearError } = useWalletStore();
  const { open, setOpen, ref } = useMenu();
  const [pendingConnect, setPendingConnect] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // After select(), connect once the adapter is attached.
  useEffect(() => {
    if (!pendingConnect || !wallet || connected || connecting) return;
    setPendingConnect(false);
    connect().catch((e: unknown) => setConnectError(e instanceof Error ? e.message : 'Connection failed'));
  }, [pendingConnect, wallet, connected, connecting, connect]);

  const pubkey = publicKey?.toBase58() ?? null;
  const sessionWallet = me?.wallet ?? null;
  const sessionMatches = sessionWallet !== null && pubkey !== null && sessionWallet === pubkey;

  const pick = (name: WalletName) => {
    setConnectError(null);
    setOpen(false);
    select(name);
    setPendingConnect(true);
  };

  const doSignIn = async () => {
    if (!pubkey || !signMessage) {
      setConnectError('This wallet cannot sign messages');
      return;
    }
    clearError();
    await signIn(pubkey, signMessage);
  };

  const doSignOut = async () => {
    setOpen(false);
    await signOut();
    await disconnect().catch(() => undefined);
  };

  const label = connecting || status === 'signing' ? (connecting ? 'CONNECTING…' : 'SIGNING…') : null;

  if (sessionMatches && sessionWallet) {
    return (
      <div className="wallet-wrap" ref={ref}>
        <button type="button" className="wallet-btn connected" onClick={() => setOpen((o) => !o)}>
          <b>{shortKey(sessionWallet)}</b>
        </button>
        {open && (
          <div className="wallet-menu">
            <div className="wm-note">{wallet?.adapter.name ?? 'WALLET'}</div>
            <MyAgentsLink onGo={() => setOpen(false)} />
            <button type="button" onClick={() => void doSignOut()}>SIGN OUT</button>
          </div>
        )}
      </div>
    );
  }

  if (connected && pubkey) {
    return (
      <div className="wallet-wrap" ref={ref}>
        <button type="button" className="wallet-btn" disabled={label !== null} onClick={() => void doSignIn()}>
          {label ?? `SIGN IN · ${shortKey(pubkey)}`}
        </button>
        <button type="button" className="wallet-btn connected" style={{ marginLeft: 6 }} onClick={() => setOpen((o) => !o)} aria-label="wallet menu">⋯</button>
        {open && (
          <div className="wallet-menu">
            <button type="button" onClick={() => { setOpen(false); void disconnect(); }}>DISCONNECT</button>
          </div>
        )}
        {(error ?? connectError) && (
          <div className="wallet-menu">
            <div className="wm-note wm-err">{error ?? connectError}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-wrap" ref={ref}>
      <button type="button" className="wallet-btn" disabled={label !== null} onClick={() => setOpen((o) => !o)}>
        {label ?? 'CONNECT WALLET'}
      </button>
      {open && (
        <div className="wallet-menu">
          {wallets.map((w) => {
            const ready = w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable;
            return ready ? (
              <button type="button" key={w.adapter.name} onClick={() => pick(w.adapter.name)}>
                <span>{w.adapter.name.toUpperCase()}</span>
                <span className="dim">{w.readyState === WalletReadyState.Installed ? 'DETECTED' : ''}</span>
              </button>
            ) : (
              <button type="button" key={w.adapter.name} onClick={() => window.open(w.adapter.url, '_blank', 'noopener')}>
                <span>{w.adapter.name.toUpperCase()}</span>
                <span className="dim">INSTALL ↗</span>
              </button>
            );
          })}
          <Link className="wm-link" to="/claim" onClick={() => setOpen(false)}>I HAVE A CLAIM CODE</Link>
          {(error ?? connectError) && <div className="wm-note wm-err">{error ?? connectError}</div>}
        </div>
      )}
    </div>
  );
}
