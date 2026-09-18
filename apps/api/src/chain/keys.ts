// Agent keypairs at rest: AES-256-GCM with KEY_ENCRYPTION_KEY (SPEC §8.3). Secrets are decrypted only
// inside chain calls, never logged, never handed to the sandbox, never returned by any API.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ChainError } from './errors.js';

export interface EncryptedSecret { enc: Buffer; iv: Buffer; tag: Buffer }

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;
export const SECRET_KEY_BYTES = 64;     // ed25519 secret key as solana-cli stores it (seed + pubkey)
const SEED_BYTES = 32;

function keyFromHex(keyHex: string): Buffer {
  if (!KEY_HEX_RE.test(keyHex)) throw new ChainError('invalid_key', 'KEY_ENCRYPTION_KEY must be 64 hex chars');
  return Buffer.from(keyHex, 'hex');
}

export function encryptSecret(secret: Uint8Array, keyHex: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFromHex(keyHex), iv);
  const enc = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { enc, iv, tag: cipher.getAuthTag() };
}

export function decryptSecret(row: EncryptedSecret, keyHex: string): Uint8Array {
  const decipher = createDecipheriv(ALGORITHM, keyFromHex(keyHex), row.iv);
  decipher.setAuthTag(row.tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(row.enc), decipher.final()]));
  } catch {
    throw new ChainError('invalid_key', 'agent key could not be decrypted (wrong KEY_ENCRYPTION_KEY or corrupt row)');
  }
}

// Zero a secret buffer once a chain call is done with it.
export function wipeSecret(secret: Uint8Array): void {
  secret.fill(0);
}

export function keypairFromSecret(secret: Uint8Array): Keypair {
  if (secret.length !== SECRET_KEY_BYTES) throw new ChainError('invalid_key', `secret key must be ${SECRET_KEY_BYTES} bytes`);
  try {
    return Keypair.fromSecretKey(secret);
  } catch {
    throw new ChainError('invalid_key', 'secret key is not a valid ed25519 keypair');
  }
}

export const pubkeyOfSecret = (secret: Uint8Array): string => keypairFromSecret(secret).publicKey.toBase58();

// Operator-supplied secret: a base58 string, a JSON byte array, or a path to a solana-cli keypair file.
// Error messages deliberately never echo the value.
export function loadSecret(source: string): Uint8Array {
  const value = source.trim();
  if (value === '') throw new ChainError('invalid_key', 'wallet secret is empty');
  const bytes = value.startsWith('[') ? parseJsonKeypair(value)
    : looksLikePath(value) ? parseJsonKeypair(readKeypairFile(value))
    : decodeBase58(value);
  if (bytes.length === SECRET_KEY_BYTES) return bytes;
  if (bytes.length === SEED_BYTES) return Keypair.fromSeed(bytes).secretKey;
  throw new ChainError('invalid_key', `wallet secret must decode to ${SECRET_KEY_BYTES} (or ${SEED_BYTES}) bytes, got ${bytes.length}`);
}

const looksLikePath = (v: string): boolean => v.endsWith('.json') || v.includes('/') || existsSync(v);

function readKeypairFile(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new ChainError('invalid_key', 'wallet keypair file could not be read');
  }
}

function parseJsonKeypair(json: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ChainError('invalid_key', 'wallet keypair file is not valid JSON');
  }
  if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new ChainError('invalid_key', 'wallet keypair JSON must be an array of bytes');
  }
  return Uint8Array.from(parsed as number[]);
}

function decodeBase58(value: string): Uint8Array {
  try {
    return bs58.decode(value);
  } catch {
    throw new ChainError('invalid_key', 'wallet secret is not valid base58');
  }
}
