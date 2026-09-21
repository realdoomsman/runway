// Sessions (SPEC-V2 §6, §8.4). Two credentials mint the same `rw_session` cookie:
//   - Sign-In With Solana: nonce message → ed25519 signature → session for the wallet pubkey.
//   - A claim code (POST /api/claim, routes/purchases.ts): session for `claim_pu_…`.
// Either way the session subject is an OWNER ID, exposed as `request.ownerId`.
import { createHash, randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { DAY_MS, ownerKindOf, purchaseOfClaimOwnerId, type OwnerKind } from '@runway/shared';
import type { Config } from '../config.js';
import { ApiError, unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    ownerId: string | null;   // set by optionalAuth / requireAuth; a base58 pubkey or `claim_pu_…`
  }
}

export const SESSION_COOKIE = 'rw_session';
export const NONCE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 30 * DAY_MS;

const PUBKEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

const MESSAGE_RE =
  /^SCALE wants you to sign in\.\nWallet: ([1-9A-HJ-NP-Za-km-z]{32,44})\nNonce: ([A-Za-z0-9_-]{16,64})\nIssued: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\nThis signature does not send a transaction\.$/;

export function buildSignInMessage(wallet: string, nonce: string, issued: Date): string {
  return `SCALE wants you to sign in.\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${issued.toISOString()}\nThis signature does not send a transaction.`;
}

export function parseSignInMessage(message: string): { wallet: string; nonce: string; issued: string } | null {
  const m = MESSAGE_RE.exec(message);
  return m ? { wallet: m[1]!, nonce: m[2]!, issued: m[3]! } : null;
}

export function isWalletAddress(value: string): boolean {
  return decode(value)?.length === PUBKEY_BYTES;
}

export function verifyWalletSignature(message: string, signatureB58: string, wallet: string): boolean {
  const pubkey = decode(wallet);
  const signature = decode(signatureB58);
  if (pubkey?.length !== PUBKEY_BYTES || signature?.length !== SIGNATURE_BYTES) return false;
  return nacl.sign.detached.verify(new TextEncoder().encode(message), signature, pubkey);
}

function decode(b58: string): Uint8Array | null {
  try {
    return bs58.decode(b58);
  } catch {
    return null;
  }
}

// Cookies carry the raw token; the store only ever sees its hash.
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface AuthStore {
  putNonce(wallet: string, nonce: string, expiresAt: Date): Promise<void>;
  consumeNonce(wallet: string, nonce: string, now: Date): Promise<boolean>;   // removes it; true iff it matched and was unexpired
  // Insert, or bump last_login_at. `kind`/`purchaseId` are only written on insert: an existing
  // identity never changes shape (SPEC-V2 §8.4).
  touchUser(ownerId: string, kind: OwnerKind, purchaseId: string | null, now: Date): Promise<void>;
  createSession(tokenHash: string, ownerId: string, now: Date, expiresAt: Date): Promise<void>;
  findSession(tokenHash: string, now: Date): Promise<string | null>;         // owner id, or null when missing/expired
  deleteSession(tokenHash: string): Promise<void>;
}

export interface Auth {
  optionalAuth: preHandlerAsyncHookHandler;   // sets request.ownerId when a valid session cookie is present
  requireAuth: preHandlerAsyncHookHandler;    // 401 without one
  issueNonce(wallet: string): Promise<string>;                                             // returns the message to sign
  verifySignIn(input: { wallet: string; signature: string; message: string }): Promise<void>;  // 401 on any mismatch
  signIn(reply: FastifyReply, ownerId: string): Promise<void>;                             // wallet pubkey OR claim_pu_…
  signOut(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export function ownerIdOf(request: FastifyRequest): string {
  if (!request.ownerId) throw unauthorized();
  return request.ownerId;
}

// Rate-limit key for authenticated routes. Rate limiting runs in `onRequest`, before the auth
// preHandler resolves an owner, so the session cookie (hashed, never stored raw) stands in for it
// and one signed-in user cannot spend everyone else's budget behind a shared IP.
export function sessionRateKey(request: FastifyRequest): string {
  const raw = request.cookies[SESSION_COOKIE];
  const unsigned = raw ? request.unsignCookie(raw) : null;
  return unsigned?.valid ? `s:${hashToken(unsigned.value)}` : `ip:${request.ip}`;
}

export function createAuth(config: Config, store: AuthStore): Auth {
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    signed: true,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  } as const;

  async function sessionOwner(request: FastifyRequest): Promise<string | null> {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid) return null;
    return store.findSession(hashToken(unsigned.value), new Date());
  }

  const optionalAuth: preHandlerAsyncHookHandler = async (request) => {
    request.ownerId = await sessionOwner(request);
  };

  const requireAuth: preHandlerAsyncHookHandler = async (request) => {
    request.ownerId = await sessionOwner(request);
    if (!request.ownerId) throw unauthorized();
  };

  return {
    optionalAuth,
    requireAuth,

    async issueNonce(wallet) {
      const now = new Date();
      const nonce = randomBytes(24).toString('base64url');
      await store.putNonce(wallet, nonce, new Date(now.getTime() + NONCE_TTL_MS));
      return buildSignInMessage(wallet, nonce, now);
    },

    async verifySignIn({ wallet, signature, message }) {
      const parsed = parseSignInMessage(message);
      if (!parsed || parsed.wallet !== wallet) throw invalidSignature('Message is not a SCALE sign-in message for this wallet');
      if (!verifyWalletSignature(message, signature, wallet)) throw invalidSignature('Signature verification failed');
      if (!(await store.consumeNonce(wallet, parsed.nonce, new Date()))) throw invalidSignature('Nonce expired or already used');
    },

    async signIn(reply, ownerId) {
      const now = new Date();
      const token = randomBytes(32).toString('base64url');
      // A claim identity records the purchase it was minted from in `users.purchase_id`.
      await store.touchUser(ownerId, ownerKindOf(ownerId), purchaseOfClaimOwnerId(ownerId), now);
      await store.createSession(hashToken(token), ownerId, now, new Date(now.getTime() + SESSION_TTL_MS));
      reply.setCookie(SESSION_COOKIE, token, cookieOptions);
    },

    async signOut(request, reply) {
      const raw = request.cookies[SESSION_COOKIE];
      if (raw) {
        const unsigned = request.unsignCookie(raw);
        if (unsigned.valid) await store.deleteSession(hashToken(unsigned.value));
      }
      reply.clearCookie(SESSION_COOKIE, { path: cookieOptions.path });
    },
  };
}

const invalidSignature = (message: string) => new ApiError(401, 'INVALID_SIGNATURE', message);
