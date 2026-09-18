// The wallet credential (SPEC §8.14, SPEC-V2 §6.1): nonce → verify → session cookie; logout; demo
// sign-in when DEMO=1. The other credential — a claim code — mints the same cookie from
// routes/purchases.ts; both resolve to an OWNER ID, which is all `Services` ever sees.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthNonceResponse, OkResponse } from '@runway/shared';
import type { Deps } from '../../core/interfaces.js';
import { isWalletAddress, type Auth } from '../auth.js';
import { servicesOf } from '../context.js';

export const AUTH_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

const walletSchema = z.string().refine(isWalletAddress, 'Invalid Solana wallet address');
const nonceQuery = z.object({ wallet: walletSchema });
const verifyBody = z.object({
  wallet: walletSchema,
  signature: z.string().min(64).max(128),
  message: z.string().min(1).max(512),
});
// Demo owners are `demo-wallet-<n>` (SPEC §8.18), not real pubkeys.
const demoBody = z.object({ wallet: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/, 'Invalid demo wallet') });

export async function authRoutes(app: FastifyInstance, deps: Deps, auth: Auth): Promise<void> {
  const limited = { config: { rateLimit: AUTH_RATE_LIMIT } };

  app.get('/api/auth/nonce', limited, async (request): Promise<AuthNonceResponse> => {
    const { wallet } = nonceQuery.parse(request.query);
    return { message: await auth.issueNonce(wallet) };
  });

  app.post('/api/auth/verify', limited, async (request, reply) => {
    const body = verifyBody.parse(request.body);
    await auth.verifySignIn(body);
    await auth.signIn(reply, body.wallet);
    return servicesOf(deps).me(body.wallet);
  });

  app.post('/api/auth/logout', async (request, reply): Promise<OkResponse> => {
    await auth.signOut(request, reply);
    return { ok: true };
  });

  if (deps.config.demo.enabled) {
    app.post('/api/auth/demo', async (request, reply) => {
      const { wallet } = demoBody.parse(request.body);
      await auth.signIn(reply, wallet);
      return servicesOf(deps).me(wallet);
    });
  }
}
