// The one-time deposit address, as copyable text (SPEC-V2 §9.5). No QR library: a `solana:` link
// plus a big monospace address plus a COPY button is the whole surface, and it adds no dependency.
import type { Micro, PurchasePublic } from '@runway/shared';
import { fmtUsd } from '@runway/shared';
import { CopyButton } from '../CopyButton';
import { explorerAddressUrl } from '../../lib/format';

/** `solana:<pubkey>?amount=<usd>&spl-token=<mint>&label=RUNWAY` — the Solana Pay transfer URI. */
export function solanaPayUri(pubkey: string, amountMicro: Micro, usdcMint: string): string {
  const amount = (amountMicro / 1_000_000).toFixed(2);
  return `solana:${pubkey}?amount=${amount}&spl-token=${usdcMint}&label=RUNWAY`;
}

interface DepositBlockProps {
  purchase: PurchasePublic;
  /** How much still has to arrive; defaults to the quoted amount. */
  dueMicro?: Micro;
  /** Extra copy under the address; the pending page and the top-up card say different things. */
  note?: string;
}

export function DepositBlock({ purchase, dueMicro, note }: DepositBlockProps) {
  const pubkey = purchase.depositPubkey;
  if (!pubkey) {
    return <div className="alert warn">This deposit address has been swept and is no longer live.</div>;
  }
  const due = dueMicro ?? purchase.quotedMicro;
  const explorer = explorerAddressUrl(pubkey, { mode: purchase.chainMode, cluster: purchase.cluster });

  return (
    <div className="deposit-address">
      <div className="da-label">SEND USDC ON SOLANA TO</div>
      <div className="da-key">{pubkey}</div>
      <div className="da-actions">
        <CopyButton text={pubkey} label="COPY ADDRESS" />
        <a className="fbtn" href={solanaPayUri(pubkey, due, purchase.usdcMint)}>OPEN IN A WALLET</a>
        {explorer && (
          <a className="fbtn" href={explorer} target="_blank" rel="noreferrer noopener">EXPLORER ↗</a>
        )}
      </div>
      <div className="da-facts">
        <span className="daf"><span className="k">AMOUNT</span><b>{fmtUsd(due)}</b></span>
        <span className="daf"><span className="k">TOKEN</span><b>USDC</b></span>
        <span className="daf"><span className="k">NETWORK</span><b>{purchase.chainMode === 'memory' ? 'simulated' : `Solana ${purchase.cluster}`}</b></span>
        <span className="daf da-mint"><span className="k">MINT</span><b>{purchase.usdcMint}</b><CopyButton text={purchase.usdcMint} /></span>
      </div>
      <div className="note">
        {note ?? (
          <>
            Send at least {fmtUsd(due)} of USDC on Solana ({purchase.chainMode === 'memory' ? 'simulated' : purchase.cluster}) to
            this address from anywhere: an exchange withdrawal, any wallet, a friend. It stays live for 72 hours. Sending
            more upgrades the tier; sending less leaves the purchase waiting.
          </>
        )}
      </div>
    </div>
  );
}
