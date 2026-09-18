// Is this string a Solana address? The HTTP layer has its own copy behind the SIWS code; the economy
// needs one too, because `POST /api/me/payout-wallet` writes a destination that real money is later
// sent to and economy/ must not import from http/.
import bs58 from 'bs58';

const PUBKEY_BYTES = 32;

export function isSolanaAddress(value: string): boolean {
  try {
    return bs58.decode(value.trim()).length === PUBKEY_BYTES;
  } catch {
    return false;
  }
}
