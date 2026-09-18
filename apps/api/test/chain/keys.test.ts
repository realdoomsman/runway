import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret, encryptSecret, keypairFromSecret, loadSecret, pubkeyOfSecret, wipeSecret,
} from '../../src/chain/keys.js';
import { isChainError } from '../../src/chain/errors.js';
import { TEST_KEY_HEX } from './helpers.js';

const OTHER_KEY_HEX = 'cd'.repeat(32);

describe('chain/keys', () => {
  it('round-trips an agent secret through AES-256-GCM', () => {
    const kp = Keypair.generate();
    const row = encryptSecret(kp.secretKey, TEST_KEY_HEX);
    expect(row.iv).toHaveLength(12);
    expect(row.tag).toHaveLength(16);
    expect(Buffer.from(kp.secretKey).equals(row.enc)).toBe(false);   // ciphertext, not the key
    expect(Array.from(decryptSecret(row, TEST_KEY_HEX))).toEqual(Array.from(kp.secretKey));
  });

  it('uses a fresh iv per encryption', () => {
    const secret = Keypair.generate().secretKey;
    const a = encryptSecret(secret, TEST_KEY_HEX);
    const b = encryptSecret(secret, TEST_KEY_HEX);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.enc.equals(b.enc)).toBe(false);
  });

  it('refuses the wrong key and tampered ciphertext', () => {
    const row = encryptSecret(Keypair.generate().secretKey, TEST_KEY_HEX);
    expect(() => decryptSecret(row, OTHER_KEY_HEX)).toThrowError(/could not be decrypted/);
    const tampered = { ...row, enc: Buffer.concat([row.enc.subarray(0, row.enc.length - 1), Buffer.from([row.enc[row.enc.length - 1]! ^ 0xff])]) };
    expect(() => decryptSecret(tampered, TEST_KEY_HEX)).toThrowError(/could not be decrypted/);
  });

  it('rejects a malformed KEY_ENCRYPTION_KEY', () => {
    const secret = Keypair.generate().secretKey;
    expect(() => encryptSecret(secret, 'too-short')).toThrowError(/64 hex chars/);
    expect(() => encryptSecret(secret, 'zz'.repeat(32))).toThrowError(/64 hex chars/);
    expect(() => decryptSecret(encryptSecret(secret, TEST_KEY_HEX), '')).toThrowError(/64 hex chars/);
  });

  it('loads an operator secret from base58, a byte array, a 32-byte seed and a file', () => {
    const kp = Keypair.generate();
    const expected = Array.from(kp.secretKey);
    expect(Array.from(loadSecret(bs58.encode(kp.secretKey)))).toEqual(expected);
    expect(Array.from(loadSecret(JSON.stringify(expected)))).toEqual(expected);
    expect(Array.from(loadSecret(` ${bs58.encode(kp.secretKey)} `))).toEqual(expected);

    const seed = kp.secretKey.slice(0, 32);
    expect(pubkeyOfSecret(loadSecret(bs58.encode(seed)))).toBe(kp.publicKey.toBase58());

    const file = path.join(mkdtempSync(path.join(tmpdir(), 'runway-keys-')), 'pool.json');
    writeFileSync(file, JSON.stringify(expected));
    expect(Array.from(loadSecret(file))).toEqual(expected);
  });

  it('never echoes the secret in its errors', () => {
    const bad = 'not-base58-!!!-supersecret';
    try {
      loadSecret(bad);
      expect.unreachable('loadSecret should have thrown');
    } catch (e) {
      expect(isChainError(e, 'invalid_key')).toBe(true);
      expect((e as Error).message).not.toContain('supersecret');
    }
    expect(() => loadSecret('')).toThrowError(/empty/);
    expect(() => loadSecret(bs58.encode(Buffer.alloc(10)))).toThrowError(/must decode to 64/);
    expect(() => loadSecret('/no/such/keypair.json')).toThrowError(/could not be read/);
  });

  it('derives the pubkey from a secret and wipes buffers', () => {
    const kp = Keypair.generate();
    expect(pubkeyOfSecret(kp.secretKey)).toBe(kp.publicKey.toBase58());
    expect(() => keypairFromSecret(new Uint8Array(31))).toThrowError(/64 bytes/);
    const copy = Uint8Array.from(kp.secretKey);
    wipeSecret(copy);
    expect(copy.every((b) => b === 0)).toBe(true);
  });
});
