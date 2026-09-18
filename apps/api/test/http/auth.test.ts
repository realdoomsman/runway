import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Me } from '@runway/shared';
import { buildSignInMessage, parseSignInMessage, verifyWalletSignature } from '../../src/http/auth.js';
import { buildTestApp, cookieHeader, json, PROD_ENV, web, type TestApp } from './helpers/app.js';
import { purchaseOfClaimOwnerId } from '@runway/shared';
import { CLAIM_CODE, CLAIM_OWNER, PAYOUT_WALLET, PURCHASE_ID } from './helpers/fixtures.js';

const keypair = nacl.sign.keyPair();
const wallet = bs58.encode(keypair.publicKey);
const sign = (message: string, kp = keypair) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));

let t: TestApp;
afterEach(async () => { await t?.close(); });

async function nonce(app: TestApp['app'], w = wallet): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/api/auth/nonce?wallet=${w}` });
  expect(res.statusCode).toBe(200);
  return json<{ message: string }>(res).message;
}

describe('SIWS message helpers', () => {
  it('round-trips the exact message format', () => {
    const issued = new Date('2026-09-16T12:00:00.000Z');
    const message = buildSignInMessage(wallet, 'abcdefghijklmnopqrstuvwx', issued);
    expect(message).toBe(`RUNWAY wants you to sign in.\nWallet: ${wallet}\nNonce: abcdefghijklmnopqrstuvwx\nIssued: 2026-09-16T12:00:00.000Z\nThis signature does not send a transaction.`);
    expect(parseSignInMessage(message)).toEqual({ wallet, nonce: 'abcdefghijklmnopqrstuvwx', issued: '2026-09-16T12:00:00.000Z' });
    expect(parseSignInMessage(`${message}\nextra`)).toBeNull();
  });

  it('verifies ed25519 signatures and rejects malformed input', () => {
    const message = 'hello';
    expect(verifyWalletSignature(message, sign(message), wallet)).toBe(true);
    expect(verifyWalletSignature('tampered', sign(message), wallet)).toBe(false);
    expect(verifyWalletSignature(message, sign(message, nacl.sign.keyPair()), wallet)).toBe(false);
    expect(verifyWalletSignature(message, 'not-base58!', wallet)).toBe(false);
    expect(verifyWalletSignature(message, sign(message), 'short')).toBe(false);
  });
});

describe('sign-in flow', () => {
  it('nonce → sign → verify → cookie → /api/me', async () => {
    t = await buildTestApp();
    const message = await nonce(t.app);
    expect(message.startsWith('RUNWAY wants you to sign in.\nWallet: ')).toBe(true);

    const verify = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet, signature: sign(message), message } }));
    expect(verify.statusCode).toBe(200);
    expect(json<Me>(verify).wallet).toBe(wallet);
    const setCookie = String(verify.headers['set-cookie']);
    expect(setCookie).toMatch(/^rw_session=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure');
    expect(t.store.users.get(wallet)).toMatchObject({ kind: 'wallet', purchaseId: null });

    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieHeader(verify) } });
    expect(me.statusCode).toBe(200);
    expect(json<Me>(me).wallet).toBe(wallet);

    const anonymous = await t.app.inject({ method: 'GET', url: '/api/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(json<ApiErrorBody>(anonymous).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a reused nonce', async () => {
    t = await buildTestApp();
    const message = await nonce(t.app);
    const payload = { wallet, signature: sign(message), message };
    expect((await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload }))).statusCode).toBe(200);
    const again = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload }));
    expect(again.statusCode).toBe(401);
    expect(json<ApiErrorBody>(again).error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects the wrong signer, a tampered message and a foreign wallet', async () => {
    t = await buildTestApp();
    const message = await nonce(t.app);
    const wrongSigner = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet, signature: sign(message, nacl.sign.keyPair()), message } }));
    expect(wrongSigner.statusCode).toBe(401);

    const tampered = message.replace('does not send', 'sends');
    const tamperedRes = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet, signature: sign(tampered), message: tampered } }));
    expect(tamperedRes.statusCode).toBe(401);

    const other = nacl.sign.keyPair();
    const otherWallet = bs58.encode(other.publicKey);
    const foreign = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet: otherWallet, signature: sign(message, other), message } }));
    expect(foreign.statusCode).toBe(401);
    expect(t.store.nonces.has(wallet)).toBe(true);   // failed attempts do not burn the nonce
  });

  it('rejects an expired nonce', async () => {
    t = await buildTestApp();
    const message = await nonce(t.app);
    t.store.nonces.get(wallet)!.expiresAt = new Date(Date.now() - 1);
    const res = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet, signature: sign(message), message } }));
    expect(res.statusCode).toBe(401);
  });

  it('validates the wallet address', async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/nonce?wallet=not-a-pubkey' });
    expect(res.statusCode).toBe(400);
    expect(json<ApiErrorBody>(res).error.code).toBe('BAD_REQUEST');
  });

  it('logout clears the cookie and invalidates the session', async () => {
    t = await buildTestApp();
    const cookie = await t.signIn('demo-wallet-9');
    const out = await t.app.inject(web({ method: 'POST', url: '/api/auth/logout', headers: { cookie } }));
    expect(out.statusCode).toBe(200);
    expect(json(out)).toEqual({ ok: true });
    expect(String(out.headers['set-cookie'])).toMatch(/^rw_session=;/);
    expect(t.store.sessions.size).toBe(0);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('marks the session cookie Secure in production', async () => {
    t = await buildTestApp({ env: PROD_ENV });
    const message = await nonce(t.app);
    const verify = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet, signature: sign(message), message } }));
    expect(verify.statusCode).toBe(200);
    const setCookie = String(verify.headers['set-cookie']);
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('ignores a cookie whose signature does not match', async () => {
    t = await buildTestApp();
    const cookie = await t.signIn('demo-wallet-9');
    const forged = cookie.replace(/\.[^.]+$/, '.forged');
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: forged } })).statusCode).toBe(401);
  });
});

// SPEC-V2 §6.1: the claim code is the second credential, and it mints the SAME cookie.
describe('claim-code sign-in', () => {
  it('derives the owner kind and the purchase behind a claim session', () => {
    expect(purchaseOfClaimOwnerId(CLAIM_OWNER)).toBe(PURCHASE_ID);
    expect(purchaseOfClaimOwnerId(wallet)).toBeNull();
  });

  it('produces a session indistinguishable from a wallet session', async () => {
    t = await buildTestApp();
    const claimed = await t.app.inject(web({ method: 'POST', url: '/api/claim', payload: { code: CLAIM_CODE } }));
    expect(claimed.statusCode).toBe(200);
    const setCookie = String(claimed.headers['set-cookie']);
    expect(setCookie).toMatch(/^rw_session=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(t.store.users.get(CLAIM_OWNER)).toMatchObject({ kind: 'claim', purchaseId: PURCHASE_ID });

    const cookie = cookieHeader(claimed);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);

    // And it signs out through exactly the same route.
    await t.app.inject(web({ method: 'POST', url: '/api/auth/logout', headers: { cookie } }));
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('demo sign-in', () => {
  it('exists only when DEMO=1', async () => {
    t = await buildTestApp({ env: { DEMO: '0' } });
    const res = await t.app.inject(web({ method: 'POST', url: '/api/auth/demo', payload: { wallet: 'demo-wallet-1' } }));
    expect(res.statusCode).toBe(404);
    await t.close();

    t = await buildTestApp({ env: { DEMO: '1' } });
    const ok = await t.app.inject(web({ method: 'POST', url: '/api/auth/demo', payload: { wallet: 'demo-wallet-1' } }));
    expect(ok.statusCode).toBe(200);
    expect(json<Me>(ok).wallet).toBe('demo-wallet-1');
    expect(String(ok.headers['set-cookie'])).toMatch(/^rw_session=/);
  });
});

describe('rate limit', () => {
  it('allows 20 nonce requests per minute per IP, then 429s with the error envelope', async () => {
    t = await buildTestApp();
    for (let i = 0; i < 20; i++) {
      expect((await t.app.inject({ method: 'GET', url: `/api/auth/nonce?wallet=${wallet}` })).statusCode).toBe(200);
    }
    const blocked = await t.app.inject({ method: 'GET', url: `/api/auth/nonce?wallet=${wallet}` });
    expect(blocked.statusCode).toBe(429);
    expect(json<ApiErrorBody>(blocked).error.code).toBe('RATE_LIMITED');
    // Other IPs and other routes are unaffected.
    expect((await t.app.inject({ method: 'GET', url: `/api/auth/nonce?wallet=${wallet}`, remoteAddress: '10.0.0.7' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  // The per-session limiter (sessionRateKey) still works after the owner-id rename: two different
  // sessions behind one IP each get their own budget.
  it('limits /api/me/payout-wallet to 10 per minute per session', async () => {
    t = await buildTestApp();
    const cookie = await t.signIn('demo-wallet-1');
    const other = await t.signIn('demo-wallet-2');
    const payload = { wallet: PAYOUT_WALLET };
    for (let i = 0; i < 10; i++) {
      expect((await t.app.inject(web({ method: 'POST', url: '/api/me/payout-wallet', payload, headers: { cookie } }))).statusCode).toBe(200);
    }
    expect((await t.app.inject(web({ method: 'POST', url: '/api/me/payout-wallet', payload, headers: { cookie } }))).statusCode).toBe(429);
    expect((await t.app.inject(web({ method: 'POST', url: '/api/me/payout-wallet', payload, headers: { cookie: other } }))).statusCode).toBe(200);
    expect(t.services.callsTo('setPayoutWallet')).toHaveLength(11);
  });
});
