// Agent token launches — the "financial layer" from the token spec. Each agent may launch exactly ONE
// official token, permanently bound to its ID (one agent = one token; no replace, no reset). The token
// is created on Pump.fun THROUGH THE AGENT'S OWN WALLET: the agent signs the create transaction, so
// Pump.fun registers the agent as the creator and its creator rewards accrue directly to the agent's
// wallet — that is the funding loop. Metadata is generated from the agent's existing identity (name,
// purpose, public page). No coin is ever created unless an owner explicitly calls launchAgentToken AND
// token launches are enabled on the deployment (config.token.launchEnabled).
import { eq, isNotNull } from 'drizzle-orm';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { type AgentTokenInfo, type TreasurySplit } from '@runway/shared';
import { keypairFromSecret } from '../chain/keys.js';
import { withAgentSecret } from '../chain/keystore.js';
import type { CoreDeps } from '../core/interfaces.js';
import { agents } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { addEvent } from './events.js';
import { post } from './ledger.js';

const PUMPPORTAL_LOCAL = 'https://pumpportal.fun/api/trade-local';   // builds an unsigned tx for our wallet (no api key)
const PUMP_IPFS = 'https://pump.fun/api/ipfs';                        // hosts token image + metadata
const TICKER_RE = /^[A-Z0-9]{2,10}$/;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const CLAIM_GAS_KEEP_LAMPORTS = 6_000_000;   // ~0.006 SOL the agent keeps for its own gas
const MIN_CLAIM_LAMPORTS = 2_000_000;        // don't bother converting a claim smaller than ~0.002 SOL
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// A real SPL mint account is owned by one of these programs (classic SPL Token or Token-2022).
const TOKEN_PROGRAM_IDS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

export const pumpUrl = (mint: string): string => `https://pump.fun/${mint}`;
const defaultTicker = (name: string): string => (name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10) || 'AGENT');

// Launch (or refuse to relaunch) the agent's one official token. Owner-only; permanent.
export async function launchAgentToken(deps: CoreDeps, agentId: string, ownerId: string, tickerInput?: string): Promise<AgentTokenInfo> {
  if (!deps.config.token.launchEnabled) throw badRequest('Token launches are not enabled on this deployment.');
  const [agent] = await deps.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) throw notFound('Agent');
  if (agent.ownerWallet !== ownerId) throw forbidden("Only the agent's creator can launch its token.");
  if (agent.tokenMint) throw conflict('CONFLICT', 'This agent already has an official token — one agent, one token.');

  const ticker = tickerInput?.trim().toUpperCase() || defaultTicker(agent.name);
  if (!TICKER_RE.test(ticker)) throw badRequest('Ticker must be 2-10 letters or digits.');

  const website = `${deps.config.publicUrl}/a/${agent.id}`;
  const description = (agent.summary || agent.directive || `Autonomous agent ${agent.name}`).slice(0, 400);

  // 1) Upload the token's image + metadata to IPFS (identity reused from the agent).
  const form = new FormData();
  // Pump.fun's IPFS endpoint requires an image file; agents have no avatar, so generate a stable one.
  const avatarRes = await fetch(`https://api.dicebear.com/9.x/shapes/png?seed=${encodeURIComponent(agent.id)}&size=512`);
  const avatar = new Uint8Array(await avatarRes.arrayBuffer());
  form.append('file', new Blob([avatar], { type: 'image/png' }), `${ticker}.png`);
  form.append('name', agent.name);
  form.append('symbol', ticker);
  form.append('description', description);
  form.append('website', website);
  form.append('showName', 'true');
  const ipfs = await fetch(PUMP_IPFS, { method: 'POST', body: form });
  if (!ipfs.ok) throw badRequest(`token metadata upload failed (${ipfs.status})`);
  const meta = (await ipfs.json()) as { metadataUri?: string };
  if (!meta.metadataUri) throw badRequest('IPFS returned no metadata URI');

  // 2) Build the create tx for the AGENT's wallet, 3) sign with the agent + mint keys, 4) send it.
  const mint = Keypair.generate();
  const conn = new Connection(deps.config.chain.rpcUrl, 'confirmed');
  await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agentId, async (secret) => {
    const agentKp = keypairFromSecret(secret);
    const built = await fetch(PUMPPORTAL_LOCAL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicKey: agentKp.publicKey.toBase58(), action: 'create',
        tokenMetadata: { name: agent.name, symbol: ticker, uri: meta.metadataUri },
        mint: mint.publicKey.toBase58(), denominatedInSol: 'true', amount: 0, slippage: 10, priorityFee: 0.0005, pool: 'pump',
      }),
    });
    if (!built.ok) throw badRequest(`token create build failed (${built.status})`);
    const tx = VersionedTransaction.deserialize(new Uint8Array(await built.arrayBuffer()));
    tx.sign([mint, agentKp]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    await conn.confirmTransaction(sig, 'confirmed');
    return sig;
  });

  const now = deps.clock.now();
  const mintStr = mint.publicKey.toBase58();
  await deps.db.update(agents)
    .set({ tokenMint: mintStr, tokenTicker: ticker, tokenName: agent.name, tokenLaunchedAt: now })
    .where(eq(agents.id, agentId));
  await addEvent(deps, deps.db, { kind: 'update', agentId, agentName: agent.name, text: `${agent.name} launched its official token $${ticker}`, meta: { mint: mintStr, ticker } });
  deps.log.info({ agentId, mint: mintStr, ticker }, 'agent token launched');
  return { mint: mintStr, name: agent.name, ticker, launchedAt: now.toISOString(), pumpUrl: pumpUrl(mintStr) };
}

// Link an externally-created Pump.fun token to the agent (owner-only, permanent) — for owners who mint
// the coin themselves on pump.fun instead of through launchAgentToken. Same binding (one agent = one
// token). The creator-fee claim loop only actually collects fees when the token's on-chain creator is
// THIS agent's wallet, so to keep the funding loop the coin must be minted from (or have its fee
// recipient set to) the agent wallet shown on the agent page.
export async function linkAgentToken(deps: CoreDeps, agentId: string, ownerId: string, mintInput: string, tickerInput?: string): Promise<AgentTokenInfo> {
  if (!deps.config.token.launchEnabled) throw badRequest('Token launches are not enabled on this deployment.');
  const [agent] = await deps.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) throw notFound('Agent');
  if (agent.ownerWallet !== ownerId) throw forbidden("Only the agent's creator can link its token.");
  if (agent.tokenMint) throw conflict('CONFLICT', 'This agent already has an official token — one agent, one token.');

  const mintStr = mintInput.trim();
  if (!MINT_RE.test(mintStr)) throw badRequest('That is not a valid token mint address.');
  const ticker = tickerInput?.trim().toUpperCase() || defaultTicker(agent.name);
  if (!TICKER_RE.test(ticker)) throw badRequest('Ticker must be 2-10 letters or digits.');

  // Verify the mint exists on-chain and is a real SPL token mint (not a wallet or a typo).
  const info = await new Connection(deps.config.chain.rpcUrl, 'confirmed').getAccountInfo(new PublicKey(mintStr), 'confirmed');
  if (!info) throw badRequest('No account exists at that mint address on-chain.');
  if (!TOKEN_PROGRAM_IDS.has(info.owner.toBase58())) throw badRequest('That address is not an SPL token mint.');

  const now = deps.clock.now();
  await deps.db.update(agents)
    .set({ tokenMint: mintStr, tokenTicker: ticker, tokenName: agent.name, tokenLaunchedAt: now })
    .where(eq(agents.id, agentId));
  await addEvent(deps, deps.db, { kind: 'update', agentId, agentName: agent.name, text: `${agent.name} linked its official token $${ticker}`, meta: { mint: mintStr, ticker, linked: true } });
  deps.log.info({ agentId, mint: mintStr, ticker }, 'agent token linked');
  return { mint: mintStr, name: agent.name, ticker, launchedAt: now.toISOString(), pumpUrl: pumpUrl(mintStr) };
}

// Claims the agent's accumulated Pump.fun creator fees (paid in SOL) into its own wallet, converts the
// proceeds to USDC and books them into the treasury as `creator_reward`. Signed by the agent (the
// creator). Returns how much USDC was booked. Run by the periodic `creator_fees` job.
export async function claimCreatorFees(deps: CoreDeps, agentId: string): Promise<{ ok: boolean; bookedMicro: number }> {
  const [agent] = await deps.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.tokenMint) return { ok: false, bookedMicro: 0 };
  const conn = new Connection(deps.config.chain.rpcUrl, 'confirmed');
  try {
    const solBefore = await deps.chain.getSolBalance(agent.walletPubkey);
    await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agentId, async (secret) => {
      const agentKp = keypairFromSecret(secret);
      const built = await fetch(PUMPPORTAL_LOCAL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: agentKp.publicKey.toBase58(), action: 'collectCreatorFee', priorityFee: 0.0005 }),
      });
      if (!built.ok) throw new Error(`claim build failed (${built.status})`);
      const tx = VersionedTransaction.deserialize(new Uint8Array(await built.arrayBuffer()));
      tx.sign([agentKp]);
      const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      await conn.confirmTransaction(sig, 'confirmed');
      return sig;
    });
    // Fees land as SOL. Convert everything above the gas reserve to USDC and book it as revenue.
    const solAfter = await deps.chain.getSolBalance(agent.walletPubkey);
    const gained = solAfter - solBefore;                       // fees received minus the gas this claim cost
    const swappable = Math.min(gained, Math.max(0, solAfter - CLAIM_GAS_KEEP_LAMPORTS));
    if (swappable < MIN_CLAIM_LAMPORTS) return { ok: true, bookedMicro: 0 };
    const { outAmount } = await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agentId, (secret) =>
      deps.chain.swap(secret, SOL_MINT, deps.chain.usdcMint, swappable, deps.config.trading.slippageBps));
    if (outAmount > 0) {
      await post(deps, deps.db, { agentId, kind: 'creator_reward', amountMicro: outAmount, memo: 'creator fees claimed' });
      await addEvent(deps, deps.db, { kind: 'revenue', agentId, agentName: agent.name, text: `${agent.name} claimed $${(outAmount / 1e6).toFixed(2)} in creator fees from $${agent.tokenTicker ?? ''}`, amountMicro: outAmount });
    }
    return { ok: true, bookedMicro: outAmount };
  } catch (e) {
    deps.log.warn({ agentId, err: e instanceof Error ? e.message : String(e) }, 'creator-fee claim failed');
    return { ok: false, bookedMicro: 0 };
  }
}

// The periodic job: claim + book creator fees for every tokenized agent. No-op while no agent has a token.
export async function claimAllCreatorFees(deps: CoreDeps): Promise<void> {
  const rows = await deps.db.select({ id: agents.id }).from(agents).where(isNotNull(agents.tokenMint));
  for (const { id } of rows) {
    if (deps.clock) { /* serialise: one claim at a time keeps RPC + gas sane */ }
    await claimCreatorFees(deps, id);
  }
}

// Treasury breakdown for the dashboard — REAL numbers, not a cosmetic split: the reserve is the liquid
// floor the trading engine will never spend below, and the rest is deployable capital the agent can put
// to work (trades, tools, ops). `open` is the marked-to-market value of positions it currently holds.
export function treasurySplit(treasuryMicro: number, minReserveMicro: number, openPositionsMicro = 0): TreasurySplit {
  const reserveMicro = Math.min(treasuryMicro, minReserveMicro);
  const deployableMicro = Math.max(0, treasuryMicro - reserveMicro);
  return { reserveMicro, deployableMicro, openPositionsMicro };
}

export const tokenInfoOf = (a: { tokenMint: string | null; tokenName: string | null; tokenTicker: string | null; tokenLaunchedAt: Date | null }): AgentTokenInfo | null =>
  a.tokenMint ? { mint: a.tokenMint, name: a.tokenName ?? '', ticker: a.tokenTicker ?? '', launchedAt: a.tokenLaunchedAt?.toISOString() ?? '', pumpUrl: pumpUrl(a.tokenMint) } : null;
