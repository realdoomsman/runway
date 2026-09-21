// x402 provider (SPEC-V2 crypto-native inference). Each agent pays the LLM gateway PER CALL from its
// OWN custodied Solana wallet using the x402 protocol: the gateway answers the first request with
// `402 Payment Required`, the client signs a USDC payment authorization with the agent's key, retries
// with `PAYMENT-SIGNATURE`, and the settlement lands in `PAYMENT-RESPONSE`. There is no provider API
// key — authentication IS payment. The gateway is an OpenAI-compatible Chat Completions endpoint, so
// the OpenAI SDK drives the request and a payment-aware `fetch` settles the 402 out of band.
//
// The real USDC leaves the agent's wallet during the call (the facilitator sponsors gas, so the agent
// needs no SOL), so the step books it as `inference_paid` — already settled, never swept — using the
// on-chain receipt for the amount and signature. `setSpendControls` caps a single payment so a gateway
// that quotes an absurd price can never drain a wallet.
//
// The 402 -> pay -> retry loop, the receipt decode and the cost/usage mapping are exercised by
// test/llm/x402.test.ts against a local mock gateway. A live payment additionally needs a funded
// Solana wallet and a running x402 LLM gateway — the one step this machine cannot run itself.
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import type { KeyPairSigner } from '@solana/kit';
import OpenAI from 'openai';
import type { ModelInfo } from '@runway/shared';
import type { SettleResponse } from '@x402/core/types';
import type { LlmProvider, LlmResponse } from '../../core/interfaces.js';
import { errorMessage } from '../../lib/errors.js';
import type { Logger } from '../../lib/log.js';
import { LlmCallError } from '../errors.js';
import { requestTimeoutMs } from '../timeout.js';
import { buildChatRequest, mapChatResponse } from './chat.js';

// Resolves the Solana signer for one agent, decrypting its custodied key transiently. The signer is
// self-contained (a non-extractable WebCrypto key), so the raw secret is discarded once it returns.
export type SvmSignerResolver = (agentId: string) => Promise<KeyPairSigner>;

export interface X402ProviderOpts {
  gatewayUrl: string;           // OpenAI-compatible base URL of the x402 LLM gateway
  maxPriceMicro: number;        // hard cap on a single 402 payment (micro-USD)
  resolveSigner: SvmSignerResolver;
  log: Logger;
  fetchImpl?: typeof fetch;
}

const PAYMENT_RESPONSE_HEADER = 'payment-response';
// The gateway speaks whatever Solana network its 402 challenge declares; a wildcard registration lets
// the same build serve devnet and mainnet without a second config knob.
const SOLANA_ANY = 'solana:*';

export function createX402Provider(opts: X402ProviderOpts): LlmProvider {
  const baseFetch = opts.fetchImpl ?? fetch;
  const maxAmountPerPayment = `$${(opts.maxPriceMicro / 1_000_000).toFixed(6)}`;
  return {
    // The gateway fans out to arbitrary upstreams, so the request is built in the OpenRouter dialect
    // (`max_tokens` is the only output cap proven to bind through such a gateway — see chat.ts). The
    // real model is kept for pricing and labels.
    name: 'openrouter' satisfies ModelInfo['provider'],
    async complete(req, model): Promise<LlmResponse> {
      const signer = await opts.resolveSigner(req.agentId);
      const client = new x402Client()
        .register(SOLANA_ANY, new ExactSvmScheme(signer))
        .setSpendControls({ maxAmountPerPayment });

      const paidFetch = wrapFetchWithPayment(baseFetch, client);
      const captured: { settle?: SettleResponse } = {};
      const fetchAndCapture: typeof fetch = async (input, init) => {
        const res = await paidFetch(input, init);
        const header = res.headers.get(PAYMENT_RESPONSE_HEADER);
        if (header) {
          try { captured.settle = decodePaymentResponseHeader(header); }
          catch (e) { opts.log.warn({ agentId: req.agentId, err: errorMessage(e) }, 'x402 settlement header could not be decoded'); }
        }
        return res;
      };

      const oa = new OpenAI({ baseURL: opts.gatewayUrl, apiKey: 'x402', fetch: fetchAndCapture, maxRetries: 0 });
      const params = buildChatRequest(req, { ...model, provider: 'openrouter' });
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await oa.chat.completions.create(params, { signal: req.signal, timeout: requestTimeoutMs(req.remainingMs) });
      } catch (e) {
        throw toX402CallError(e);
      }

      const res = mapChatResponse(completion, model, { costFromUsage: true, providerName: 'openrouter' });
      const settle = captured.settle;
      if (settle?.success) applyPaymentReceipt(res, settle);
      // x402 mode expects every call to settle a payment. No receipt means the gateway did not charge
      // (misconfigured or a free tier); fall back to the token estimate and say so.
      else opts.log.warn({ agentId: req.agentId, model: model.id }, 'x402 call returned no payment receipt; billing from token usage');
      return res;
    },
  };
}

// Applies an on-chain settlement receipt to a mapped response: records the payment for the ledger and,
// when the receipt names the amount, makes it authoritative over the token-based estimate.
export function applyPaymentReceipt(res: LlmResponse, settle: SettleResponse): void {
  const paidMicro = amountMicroOf(settle);
  res.payment = {
    txSig: settle.transaction,
    network: String(settle.network),
    payTo: null,                                  // the recipient is not carried in the settle receipt
    amountMicro: paidMicro ?? res.usage.costMicro,
  };
  if (paidMicro !== null) res.usage.costMicro = paidMicro;
}

// USDC settles in atomic units of 1e-6 (6 decimals), which is exactly one micro-dollar, so the atomic
// amount maps 1:1 to Micro. `amount` is present for `upto`; for `exact` the receipt may omit it and we
// fall back to the metered token cost.
export function amountMicroOf(settle: Pick<SettleResponse, 'amount'>): number | null {
  if (typeof settle.amount !== 'string' || settle.amount.length === 0) return null;
  const n = Number(settle.amount);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toX402CallError(e: unknown): LlmCallError {
  if (e instanceof LlmCallError) return e;
  const msg = errorMessage(e);
  // Transport failures are worth another attempt; a spend-control rejection or a signing failure is not.
  const retryable = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|fetch failed|\b(429|500|502|503|504)\b/i.test(msg);
  return new LlmCallError('openrouter', `x402 gateway call failed: ${msg}`, { retryable });
}
