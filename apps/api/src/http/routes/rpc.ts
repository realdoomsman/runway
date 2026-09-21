// Browser-safe Solana JSON-RPC proxy. The wallet pay flow (usdcTransfer.ts) needs to read a token
// balance, send a transfer and poll its status from the browser. Public cluster RPCs
// (api.mainnet-beta.solana.com) rate-limit and 403 those calls, which surfaced to buyers as the
// false "No USDC token account for this wallet". This forwards a bounded set of methods to the
// server's own configured RPC (e.g. Helius) so the key stays server-side and the browser gets a
// reliable endpoint on the same origin. Solana mode only; the method allow-list keeps it from being
// used as an open RPC relay.
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../core/interfaces.js';

// Everything the wallet-adapter + usdcTransfer flow calls, and nothing heavy (no getProgramAccounts).
const ALLOWED_METHODS: Record<string, true> = {
  getLatestBlockhash: true, isBlockhashValid: true, getBlockHeight: true, getSlot: true, getEpochInfo: true,
  getAccountInfo: true, getMultipleAccounts: true, getBalance: true, getTokenAccountBalance: true, getTokenAccountsByOwner: true,
  getFeeForMessage: true, getMinimumBalanceForRentExemption: true, getRecentPrioritizationFees: true,
  sendTransaction: true, simulateTransaction: true, getSignatureStatuses: true, getSignatureStatus: true,
  getGenesisHash: true, getVersion: true, getHealth: true,
};

interface RpcCall { jsonrpc?: string; id?: unknown; method?: string; params?: unknown }

export async function rpcRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  if (deps.chain.mode !== 'solana') return;
  const upstream = deps.config.chain.rpcUrl;

  app.post('/rpc', async (request, reply) => {
    const body = request.body as RpcCall | RpcCall[] | null;
    const calls = Array.isArray(body) ? body : [body];
    for (const call of calls) {
      const method = call?.method;
      if (typeof method !== 'string' || ALLOWED_METHODS[method] !== true) {
        return reply.status(400).send({
          jsonrpc: '2.0', id: call?.id ?? null,
          error: { code: -32601, message: `RPC method not permitted through this proxy: ${String(method)}` },
        });
      }
    }
    let res: Response;
    try {
      res = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return reply.status(502).send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'upstream RPC unreachable' } });
    }
    const text = await res.text();
    try {
      return reply.status(res.status).send(JSON.parse(text));
    } catch {
      return reply.status(502).send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'bad upstream RPC response' } });
    }
  });
}
