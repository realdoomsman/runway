// Module contracts. SPEC-V2 §5.1, §5.6, §6.2, §7.1 (was SPEC §8.1 + AMENDMENTS A1–A4/B18/C25).
// Every module implements exactly these; the container wires them (core/container.ts).
// NOTE: this file must never import from `payments/` — the `Payments` contract is DECLARED here and
// implemented there, so the contract file has no dependency on the implementation.
import type {
  AgentDetail, AgentLiveState, AgentPublic, Bounty, BountyStatus, DecisionKind, Effort, EventKind, FeedEvent,
  GlobalStats, GraveyardEntry, GraveyardSort, LeaderboardBy, LedgerEntry, LedgerKind, ListAgentsQuery, Me, Micro,
  ModelInfo, NameAvailableResponse, OwnerKind, Pace, PurchasePath, PurchasePublic, PurchaseQuote, SeriesPoint, Service,
  StepPublic, StepTranscript, StopReason, TierId, TiersResponse, ToolName, TreasuryPublic, TreasuryTx, WsMsg, WsMsgOf,
  WsMsgType,
} from '@runway/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { AgentRow } from '../db/schema.js';
import type { Logger } from '../lib/log.js';

// ---- LLM -------------------------------------------------------------------
export interface LlmMessage { role: 'user' | 'assistant'; content: LlmContent[] }
export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'thinking'; thinking: string; signature: string }        // Anthropic 1:1; replayed verbatim; stripped from public payloads
  | { type: 'redacted_thinking'; data: string };
export interface LlmToolDef { name: string; description: string; inputSchema: Record<string, unknown> }  // JSON schema, additionalProperties:false, required listed
export interface LlmRequest {
  model: string; system: string; messages: LlmMessage[]; tools: LlmToolDef[];
  maxTokens: number;                 // default LLM_MAX_TOKENS_DEFAULT (16000)
  effort?: Effort;
  toolChoice?: 'auto' | 'none';      // default 'auto'; closing completions send the SAME tools with 'none'
  signal?: AbortSignal;
  // Milliseconds of step budget left. AMENDMENTS A6 requires the per-request timeout to be
  // min(remainingStepMs, LLM_REQUEST_TIMEOUT_MS), which an AbortSignal cannot express, and it is what
  // lets the router skip a retry it has no time for. Optional: callers outside the step loop
  // (the post-mortem epitaph) fall back to the 300s ceiling.
  remainingMs?: number;
  agentId: string;
}
export interface LlmUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costMicro: Micro }
export interface LlmResponse {
  content: LlmContent[];
  stopReason: StopReason;
  stopDetails?: { category: string | null; explanation?: string };
  usage: LlmUsage;
  model: string;
  raw?: unknown;
}
// Providers never retry (the router owns that) and bound every call by
// clamp(req.remainingMs ?? LLM_REQUEST_TIMEOUT_MS, LLM_REQUEST_TIMEOUT_MIN_MS, LLM_REQUEST_TIMEOUT_MS).
export interface LlmProvider { readonly name: ModelInfo['provider']; complete(req: LlmRequest, model: ModelInfo): Promise<LlmResponse> }
export interface LlmRouter {
  readonly mode: 'router' | 'mock';
  models(): ModelInfo[];                                   // enabled models only
  resolve(id: string): ModelInfo;                          // throws on unknown/disabled
  complete(req: LlmRequest): Promise<LlmResponse>;         // owns retries: 3× on 429/5xx/network, identical body
  cheapest(): ModelInfo;                                   // enabled model minimising estimateMicro(m, 3000, 600)
  estimateMicro(model: ModelInfo, inTok: number, outTok: number): Micro;
  refreshPricing(): Promise<void>;                         // OpenRouter boot refresh; no-op elsewhere
}

// ---- Chain -----------------------------------------------------------------
export interface UsdcInflow { sig: string; from: string; amount: Micro; ts: Date }
export interface UsdcTransfer { sig: string; from: string; to: string; amount: Micro; ts: Date }
export interface SweepOut { to: string; amount: Micro }
export interface ChainAdapter {
  readonly mode: 'memory' | 'solana'; readonly cluster: string; readonly usdcMint: string;
  newKeypair(): { pubkey: string; secret: Uint8Array };
  getUsdcBalance(pubkey: string): Promise<Micro>;
  getSolBalance(pubkey: string): Promise<number>;                       // lamports
  getTokenBalance(pubkey: string, mint: string): Promise<number>;       // base units
  transferUsdc(fromSecret: Uint8Array, to: string, amount: Micro, memo?: string): Promise<{ sig: string }>;
  transferSol(fromSecret: Uint8Array, to: string, lamports: number): Promise<{ sig: string }>;
  listUsdcInflows(pubkey: string, sinceSig: string | null, limit?: number): Promise<UsdcInflow[]>;  // newest first
  getUsdcTransfer(sig: string): Promise<UsdcTransfer | null>;           // verifies user-submitted payment/escrow txs
  ensureAta(payerSecret: Uint8Array, owner: string): Promise<void>;
  solPriceUsd(): Promise<number>;
  /** One transaction: `payerSecret` pays fees and creates missing ATAs; `fromSecret` signs the transfers. */
  sweepUsdc(fromSecret: Uint8Array, payerSecret: Uint8Array, outs: SweepOut[], memo?: string): Promise<{ sig: string }>;
  /** Moves `lamports` (or the whole balance when null) out of `fromSecret`; `payerSecret` pays fees. */
  sweepSol(fromSecret: Uint8Array, payerSecret: Uint8Array, to: string, lamports: number | null): Promise<{ sig: string }>;
  faucet?(to: string, amount: Micro, from: string): Promise<{ sig: string }>;  // memory mode only: external "customer" USDC
  faucetSol?(to: string, lamports: number): Promise<{ sig: string }>;          // memory mode only: the local payment simulator
}

// ---- Sandbox ---------------------------------------------------------------
export interface SandboxExecResult { stdout: string; stderr: string; exitCode: number; cpuMs: number; timedOut: boolean }
export interface SandboxFile { path: string; bytes: number; dir: boolean }
export interface SandboxDriver {
  readonly name: 'docker' | 'local';
  ensure(agentId: string): Promise<void>;                                 // create container/workdir if missing
  exec(agentId: string, command: string, opts: { timeoutMs: number; stdin?: string }): Promise<SandboxExecResult>;
  writeFile(agentId: string, path: string, content: string): Promise<void>;  // path relative to /work; reject '..' and absolute
  readFile(agentId: string, path: string, maxBytes: number): Promise<string>;
  listFiles(agentId: string, path: string): Promise<SandboxFile[]>;
  exportDir(agentId: string, path: string, destDir: string, maxBytes: number): Promise<{ bytes: number; files: number }>;  // for deploy
  destroy(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;                                   // sleeping/paused agents are stopped (rent discount)
  start(agentId: string): Promise<void>;
}

// ---- Search / Clock --------------------------------------------------------
export interface SearchResult { title: string; url: string; snippet: string }
export interface SearchProvider { readonly name: 'brave' | 'tavily' | 'none'; search(q: string, count: number): Promise<SearchResult[]> }
export interface Clock { now(): Date }

// ---- Tools -----------------------------------------------------------------
export interface ToolContext {
  agent: AgentRow;          // snapshot taken at step start; re-read from db for fresh balances
  stepId: number;
  round: number;
  log: Logger;
}
export interface ToolExecOpts { signal: AbortSignal; remainingMs: number }   // tool timeouts are capped by remainingMs
export interface ToolEvent { kind: EventKind; text: string; amountMicro?: Micro | null; meta?: Record<string, unknown> }
export interface ToolDecision { kind: DecisionKind; text: string; meta?: Record<string, unknown> }
export interface ToolResult {
  content: string;          // returned to the model; outside-world text already wrapped with lib/untrusted
  costMicro: Micro;         // charged by the step loop (0 for free tools)
  ledgerKind?: LedgerKind;  // default 'tool'; bash → 'compute'; call_service → 'payment'
  isError?: boolean;        // becomes tool_result.isError; never throw out of execute()
  event?: ToolEvent;        // persisted + broadcast by the step loop after the ledger post
  decision?: ToolDecision;  // e.g. set_model → 'pivot', sleep → 'sleep'
}
export interface ToolRegistry {
  defs(enabled: ToolName[]): LlmToolDef[];                // canonical (Anthropic-style) schemas, sorted by name
  execute(ctx: ToolContext, name: string, input: unknown, opts: ToolExecOpts): Promise<ToolResult>;
  parallelSafe(name: ToolName): boolean;
  summarize(name: ToolName, input: unknown): string;      // ≤160 chars for the WS 'tool' message; never secrets
}

// ---- Event bus -------------------------------------------------------------
export interface EventBus {
  emit(msg: WsMsg): void;
  on<T extends WsMsgType>(type: T, listener: (msg: WsMsgOf<T>) => void): () => void;   // returns unsubscribe
  onAny(listener: (msg: WsMsg) => void): () => void;
}

// ---- Payments (payments/ implements, http/ consumes) ----------------------
// Declared here, implemented in apps/api/src/payments/index.ts (SPEC-V2 §5.1).
export interface CreatePurchaseInput {
  amountMicro: Micro; name: string; directive: string; tools?: ToolName[];
  pace?: Pace; path: PurchasePath; forkOf?: string;
  ownerWallet?: string;            // required when path === 'wallet'
}
export interface Payments {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The plaintext claim code is returned EXACTLY ONCE, here. Never logged, never stored, never re-read. */
  createPurchase(input: CreatePurchaseInput): Promise<{ purchase: PurchasePublic; claimCode: string | null }>;
  getPurchase(id: string): Promise<PurchasePublic | null>;
  listPurchases(ownerId: string): Promise<PurchasePublic[]>;
  cancelPurchase(id: string, ownerId: string): Promise<PurchasePublic>;
  attachPayment(id: string, txSig: string): Promise<PurchasePublic>;
  simulatePay(id: string, amountMicro?: Micro, solLamports?: number): Promise<PurchasePublic>;  // memory mode only
  topUp(agentId: string, ownerId: string, amountMicro: Micro, path: PurchasePath): Promise<PurchasePublic>;
  quote(amountMicro: Micro, pace?: Pace): PurchaseQuote & { diesOn: string | null };
  tiers(): TiersResponse;
  nameAvailable(name: string): Promise<NameAvailableResponse>;
  claim(code: string): Promise<{ ownerId: string }>;   // throws INVALID_CLAIM_CODE
  pollNow(purchaseId?: string): Promise<void>;         // tests + attachPayment
}

// ---- Services (economy/ implements, http/ + tools/ consume) ---------------
// Every `ownerId` below is an OWNER ID: a base58 pubkey, or `claim_pu_…` (SPEC-V2 §6.1).
export interface SpawnInput {
  ownerWallet: string;          // an owner id
  ownerKind: OwnerKind;
  name: string; directive: string; tools: ToolName[];
  model: string; effort: Effort; heartbeatMin: number;
  fundingMicro: Micro;          // REQUIRED. What the treasury must move into the agent wallet.
  tierId: TierId | null;
  purchaseId: string | null;    // null only for the demo colony
  forkOf?: string;
  agentId?: string;             // sim + payments may supply a deterministic id. HTTP cannot set it.
}
export interface PostBountyInput {
  posterType: 'user'; posterWallet: string; title: string; description: string; rewardMicro: Micro; deadlineHours: number; escrowTxSig: string;
}
export interface StepTranscriptView { transcript: StepTranscript; ownerView: boolean }
export type ServiceBuyer =
  | { type: 'user'; wallet: string | null; paymentTxSig: string }   // wallet null for POST /svc/:id (derived from the tx)
  | { type: 'agent'; agentId: string };                             // call_service tool: paid agent→agent wallet
export interface Services {
  spawn(input: SpawnInput): Promise<AgentPublic>;
  /** The only owner check the HTTP layer may use: AgentPublic.ownerWallet is null for claim owners. */
  isOwner(agentId: string, ownerId: string): Promise<boolean>;
  withdraw(agentId: string, ownerId: string, amountMicro?: Micro, payoutWallet?: string): Promise<{ sentMicro: Micro; feeMicro: Micro; txSig: string | null }>;
  revive(agentId: string, ownerId: string): Promise<AgentPublic>;
  recapitalize(agentId: string, ownerId: string, txSig: string): Promise<AgentPublic>;
  /** Fulfilment of a `kind='topup'` purchase: treasury → agent wallet, ledger 'recapitalize', wake. */
  creditTopUp(agentId: string, purchaseId: string, amountMicro: Micro): Promise<AgentPublic>;
  pause(agentId: string, ownerId: string, paused: boolean): Promise<AgentPublic>;
  terminate(agentId: string, ownerId: string): Promise<AgentPublic>;                  // owner kills; remaining treasury withdrawable
  setShareStrategy(agentId: string, ownerId: string, share: boolean): Promise<AgentPublic>;
  setHeartbeat(agentId: string, ownerId: string, heartbeatMin: number): Promise<AgentPublic>;
  messageAgent(agentId: string, ownerId: string, text: string): Promise<void>;
  postBounty(input: PostBountyInput): Promise<Bounty>;
  reviewBounty(bountyId: string, posterWallet: string, approve: boolean, feedback: string): Promise<Bounty>;
  callService(serviceId: string, buyer: ServiceBuyer, input: unknown): Promise<{ output: unknown; status: string }>;
  getAgent(id: string, viewerOwnerId?: string | null): Promise<AgentDetail | null>;   // ownerMessages + isOwner for the owner
  listAgents(q: ListAgentsQuery): Promise<{ rows: AgentPublic[]; total: number }>;
  leaderboard(by: LeaderboardBy, limit: number): Promise<AgentPublic[]>;
  graveyard(limit: number, sort?: GraveyardSort): Promise<GraveyardEntry[]>;   // carries postmortem (D37)
  stats(): Promise<GlobalStats>;                                                       // cached 30s
  series(days: number): Promise<SeriesPoint[]>;
  events(q: { limit: number; before?: number; agentId?: string }): Promise<FeedEvent[]>;
  ledger(agentId: string, q: { limit: number; before?: number }): Promise<LedgerEntry[]>;
  steps(agentId: string, limit: number): Promise<StepPublic[]>;
  agentLive(agentId: string): Promise<AgentLiveState>;                                // the control board's THINKING NOW panel
  // null once pruned. `ownerView` says whether the viewer may see the owner-private sections (C21).
  stepTranscript(agentId: string, stepId: number, viewerOwnerId?: string | null): Promise<StepTranscriptView | null>;
  bounties(status?: BountyStatus): Promise<Bounty[]>;
  services(): Promise<Service[]>;
  treasury(): Promise<TreasuryPublic>;
  treasuryTxs(q: { limit: number; before?: number }): Promise<TreasuryTx[]>;
  me(ownerId: string): Promise<Me>;
  setPayoutWallet(ownerId: string, wallet: string): Promise<Me>;
}

// ---- Runtime / HTTP --------------------------------------------------------
export interface Runtime {
  start(): Promise<void>;                 // scheduler + jobs
  stop(): Promise<void>;                  // finishes in-flight steps (≤ STEP_TIMEOUT_MS)
  runStep(agentId: string): Promise<void>; // one heartbeat now (used by the demo seeder and tests)
}
export interface HttpServer { listen(): Promise<void>; close(): Promise<void> }

// ---- Dependency container --------------------------------------------------
// CoreDeps exist before the tool registry; Deps is the full set. `services` and `runtime` are
// attached to the SAME object after construction — read them lazily at call time, never
// destructure them in a factory body.
export interface CoreDeps {
  config: Config; db: Db; clock: Clock; chain: ChainAdapter; sandbox: SandboxDriver;
  search: SearchProvider; llm: LlmRouter; bus: EventBus; log: Logger;
}
export interface Deps extends CoreDeps {
  tools: ToolRegistry;
  services?: Services;
  runtime?: Runtime;
  payments?: Payments;
}
