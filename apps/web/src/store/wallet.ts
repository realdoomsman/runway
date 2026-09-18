// Session state + the Sign-In-With-Solana flow (SPEC §8.14).
// The connected adapter lives in wallet-adapter-react; this store only owns
// the server session (`me` in the app store) and the sign-in status.
import { create } from 'zustand';
import bs58 from 'bs58';
import { api, isApiError } from '../api/client';
import { useAppStore } from './app';

export type SessionStatus = 'anon' | 'signing' | 'signed';
export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

interface WalletState {
  status: SessionStatus;
  error: string | null;
  /** Wallet-adapter sign-in: nonce → signMessage → verify. */
  signIn: (wallet: string, signMessage: SignMessage) => Promise<boolean>;
  /** Demo sign-in (DEMO=1 only): a fake wallet persisted in localStorage. */
  signInDemo: () => Promise<boolean>;
  /** Claim-code sign-in (the no-wallet path): mints the same `rw_session` cookie. */
  claim: (code: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  /** Re-read /api/me; a 401 simply means signed out. */
  refreshMe: () => Promise<void>;
  clearError: () => void;
}

const DEMO_WALLET_KEY = 'rw_demo_wallet';

function demoWallet(): string {
  try {
    const cur = localStorage.getItem(DEMO_WALLET_KEY);
    if (cur) return cur;
    const fresh = `demo-user-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEMO_WALLET_KEY, fresh);
    return fresh;
  } catch {
    return `demo-user-${Math.random().toString(36).slice(2, 10)}`;
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : 'Sign-in failed');

export const useWalletStore = create<WalletState>()((set) => ({
  status: 'anon',
  error: null,

  signIn: async (wallet, signMessage) => {
    set({ status: 'signing', error: null });
    try {
      const { message } = await api.authNonce(wallet);
      const signature = await signMessage(new TextEncoder().encode(message));
      const me = await api.authVerify({ wallet, signature: bs58.encode(signature), message });
      useAppStore.getState().setMe(me);
      set({ status: 'signed' });
      return true;
    } catch (e) {
      set({ status: 'anon', error: errText(e) });
      return false;
    }
  },

  signInDemo: async () => {
    set({ status: 'signing', error: null });
    try {
      const me = await api.authDemo(demoWallet());
      useAppStore.getState().setMe(me);
      set({ status: 'signed' });
      return true;
    } catch (e) {
      set({ status: 'anon', error: errText(e) });
      return false;
    }
  },

  // A claim identity is an owner id, not a pubkey: the session cookie and every owner route behave
  // identically once it is minted, so the store keeps a single `signed` status for both paths.
  claim: async (code) => {
    set({ status: 'signing', error: null });
    try {
      const me = await api.claim(code);
      useAppStore.getState().setMe(me);
      set({ status: 'signed' });
      return true;
    } catch (e) {
      set({ status: 'anon', error: isApiError(e) ? e.message : 'That claim code is not valid.' });
      return false;
    }
  },

  signOut: async () => {
    try {
      await api.authLogout();
    } finally {
      useAppStore.getState().setMe(null);
      set({ status: 'anon', error: null });
    }
  },

  refreshMe: async () => {
    try {
      const me = await api.me();
      useAppStore.getState().setMe(me);
      set({ status: 'signed' });
    } catch (e) {
      if (isApiError(e) && (e.status === 401 || e.status === 403)) {
        useAppStore.getState().setMe(null);
        set({ status: 'anon' });
      }
      // Network / 5xx: keep whatever session state we had.
    }
  },

  clearError: () => set({ error: null }),
}));
