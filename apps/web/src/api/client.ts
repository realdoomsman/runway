// Typed fetch wrapper: one function per route in SPEC-V2 §8.
// Every call sends cookies (credentials: 'include'); errors surface as ApiError.
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@runway/shared';
import type {
  AgentDetail,
  AgentLiveState,
  AgentPublic,
  AuthNonceResponse,
  AuthVerifyRequest,
  Bounty,
  BountiesQuery,
  CallServiceRequest,
  CustodialWallet,
  CustodialWithdrawResponse,
  CallServiceResponse,
  CreatePurchaseRequest,
  CreatePurchaseResponse,
  EventsQuery,
  FeedEvent,
  GlobalStats,
  GraveyardEntry,
  GraveyardQuery,
  HealthResponse,
  LeaderboardBy,
  LedgerEntry,
  LedgerQuery,
  ListAgentsQuery,
  ListAgentsResponse,
  Me,
  Micro,
  ModelInfo,
  NameAvailableResponse,
  Pace,
  PatchAgentRequest,
  PostBountyRequest,
  PurchasePublic,
  QuoteResponse,
  ReviewBountyRequest,
  SeriesPoint,
  Service,
  StepPublic,
  StepTranscript,
  TiersResponse,
  TopUpResponse,
  TreasuryPublic,
  TreasuryTx,
  TreasuryTxsQuery,
  WithdrawRequest,
  WithdrawResponse,
} from '@runway/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

type Query = object;

function qs(q: Query | undefined): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// The API rejects a mutating /api call without CLIENT_HEADER, which a cross-site form post cannot set.
function headersFor(method: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (hasBody) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers[CLIENT_HEADER] = CLIENT_HEADER_VALUE;
  return headers;
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: headersFor(method, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? res.statusText ?? 'Request failed');
  }
  return json as T;
}

const get = <T>(path: string, q?: Query) => request<T>('GET', `${path}${qs(q)}`);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);

/**
 * The `payments` block of `GET /api/health` (SPEC-V2 §5.9): it is what lets the Pending page offer
 * SIMULATE PAYMENT without guessing the chain mode. Read through `??` because an older API build
 * answers `/api/health` without it.
 */
export type PaymentsHealth = HealthResponse['payments'];

export const paymentsHealthOf = (h: HealthResponse | null): PaymentsHealth | null => h?.payments ?? null;

// ---- routes ----

export const api = {
  health: () => get<HealthResponse>('/api/health'),
  stats: () => get<GlobalStats>('/api/stats'),
  statsSeries: (days = 30) => get<SeriesPoint[]>('/api/stats/series', { days }),
  events: (q: EventsQuery = {}) => get<FeedEvent[]>('/api/events', q),

  agents: (q: ListAgentsQuery = {}) => get<ListAgentsResponse>('/api/agents', q),
  agent: (id: string) => get<AgentDetail>(`/api/agents/${enc(id)}`),
  agentLedger: (id: string, q: LedgerQuery = {}) => get<LedgerEntry[]>(`/api/agents/${enc(id)}/ledger`, q),
  agentSteps: (id: string, limit = 30) => get<StepPublic[]>(`/api/agents/${enc(id)}/steps`, { limit }),
  agentEvents: (id: string, limit = 50) => get<FeedEvent[]>(`/api/agents/${enc(id)}/events`, { limit }),
  agentLive: (id: string) => get<AgentLiveState>(`/api/agents/${enc(id)}/live`),
  stepTranscript: (id: string, stepId: number) => get<StepTranscript>(`/api/agents/${enc(id)}/steps/${stepId}/transcript`),

  withdraw: (id: string, body: WithdrawRequest = {}) => post<WithdrawResponse>(`/api/agents/${enc(id)}/withdraw`, body),
  revive: (id: string) => post<AgentPublic>(`/api/agents/${enc(id)}/revive`),
  pause: (id: string, paused: boolean) => post<AgentPublic>(`/api/agents/${enc(id)}/pause`, { paused }),
  /** `confirm` must equal "TERMINATE {NAME}". */
  terminate: (id: string, confirm: string) => post<AgentPublic>(`/api/agents/${enc(id)}/terminate`, { confirm }),
  updateAgent: (id: string, body: PatchAgentRequest) => patch<AgentPublic>(`/api/agents/${enc(id)}`, body),
  messageAgent: (id: string, text: string) => post<void>(`/api/agents/${enc(id)}/message`, { text }),
  recapitalize: (id: string, txSig: string) => post<AgentPublic>(`/api/agents/${enc(id)}/recapitalize`, { txSig }),
  /** Deposit-address top-up: creates a `kind:'topup'` purchase against this agent. */
  topUp: (id: string, amountMicro: Micro, path: 'deposit' | 'wallet' = 'deposit') =>
    post<TopUpResponse>(`/api/agents/${enc(id)}/topup`, { amountMicro, path }),

  graveyard: (q: GraveyardQuery = {}) => get<GraveyardEntry[]>('/api/graveyard', q),
  leaderboard: (by: LeaderboardBy, limit = 25) => get<AgentPublic[]>('/api/leaderboard', { by, limit }),

  treasury: () => get<TreasuryPublic>('/api/treasury'),
  treasuryTxs: (q: TreasuryTxsQuery = {}) => get<TreasuryTx[]>('/api/treasury/txs', q),

  // ---- purchases (SPEC-V2 §8.2) ----
  tiers: () => get<TiersResponse>('/api/tiers'),
  quote: (amountMicro: Micro, pace?: Pace) =>
    post<QuoteResponse>('/api/quote', pace ? { amountMicro, pace } : { amountMicro }),
  nameAvailable: (name: string) => get<NameAvailableResponse>('/api/purchases/name-available', { name }),
  createPurchase: (body: CreatePurchaseRequest) => post<CreatePurchaseResponse>('/api/purchases', body),
  purchase: (id: string) => get<PurchasePublic>(`/api/purchases/${enc(id)}`),
  attachPayment: (id: string, txSig: string) => post<PurchasePublic>(`/api/purchases/${enc(id)}/attach`, { txSig }),
  cancelPurchase: (id: string) => post<PurchasePublic>(`/api/purchases/${enc(id)}/cancel`),
  /** Memory chain only — the API mounts this route only when `chain.mode === 'memory'`. */
  simulatePay: (id: string, amountMicro?: Micro) =>
    post<PurchasePublic>(`/api/purchases/${enc(id)}/simulate-pay`, amountMicro === undefined ? {} : { amountMicro }),
  claim: (code: string) => post<Me>('/api/claim', { code }),

  bounties: (q: BountiesQuery = {}) => get<Bounty[]>('/api/market/bounties', q),
  postBounty: (body: PostBountyRequest) => post<Bounty>('/api/market/bounties', body),
  reviewBounty: (id: string, body: ReviewBountyRequest) => post<Bounty>(`/api/market/bounties/${enc(id)}/review`, body),
  services: () => get<Service[]>('/api/market/services'),
  callService: (id: string, body: CallServiceRequest) => post<CallServiceResponse>(`/api/market/services/${enc(id)}/call`, body),

  models: () => get<ModelInfo[]>('/api/models'),

  authNonce: (wallet: string) => get<AuthNonceResponse>('/api/auth/nonce', { wallet }),
  authVerify: (body: AuthVerifyRequest) => post<Me>('/api/auth/verify', body),
  authLogout: () => post<void>('/api/auth/logout'),
  /** Exists only when the API runs with DEMO=1. */
  authDemo: (wallet: string) => post<Me>('/api/auth/demo', { wallet }),
  me: () => get<Me>('/api/me'),
  setPayoutWallet: (wallet: string) => post<Me>('/api/me/payout-wallet', { wallet }),
  wallet: () => get<CustodialWallet>('/api/me/wallet'),
  withdrawCustodial: (to: string, amountMicro: Micro) => post<CustodialWithdrawResponse>('/api/me/withdraw', { to, amountMicro }),
};

function enc(s: string): string {
  return encodeURIComponent(s);
}
