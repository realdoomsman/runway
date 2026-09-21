// Agent token launches — the "financial layer" from the token spec. Each agent may launch exactly ONE
// official token, permanently bound to its ID (one agent = one token; no replace, no reset). The token
// is created on Pump.fun THROUGH THE AGENT'S OWN WALLET: the agent signs the create transaction, so
// Pump.fun registers the agent as the creator and its creator rewards accrue directly to the agent's
// wallet — that is the funding loop. Metadata is generated from the agent's existing identity (name,
// purpose, public page). No coin is ever created unless an owner explicitly calls launchAgentToken AND
// token launches are enabled on the deployment (config.token.launchEnabled).
import { eq } from 'drizzle-orm';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { type AgentTokenInfo, type TreasurySplit } from '@runway/shared';
import { keypairFromSecret } from '../chain/keys.js';
import { withAgentSecret } from '../chain/keystore.js';
import type { CoreDeps } from '../core/interfaces.js';
import { agents } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { addEvent } from './events.js';

const PUMPPORTAL_LOCAL = 'https://pumpportal.fun/api/trade-local';   // builds an unsigned tx for our wallet (no api key)
const PUMP_IPFS = 'https://pump.fun/api/ipfs';                        // hosts token image + metadata
const TICKER_RE = /^[A-Z0-9]{2,10}$/;

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

  const website = `${deps.config.publicUrl}/agent/${agent.id}`;
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

// Claims the agent's accumulated Pump.fun creator fees into its own wallet, then books them into the
// treasury as `creator_reward`. Signed by the agent (the creator). Called by a periodic job.
export async function claimCreatorFees(deps: CoreDeps, agentId: string): Promise<{ ok: boolean }> {
  const [agent] = await deps.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.tokenMint) return { ok: false };
  const conn = new Connection(deps.config.chain.rpcUrl, 'confirmed');
  try {
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
    return { ok: true };
  } catch (e) {
    deps.log.warn({ agentId, err: e instanceof Error ? e.message : String(e) }, 'creator-fee claim failed');
    return { ok: false };
  }
}

// Sub-treasury split for the dashboard (token spec): incoming resources are conceptually divided into
// operating, AI credits, strategy capital and a reserve (40% operating+credits / 40% strategy / 20%
// reserve). Presented against the liquid treasury so the creator sees the allocation at a glance.
export function treasurySplit(treasuryMicro: number): TreasurySplit {
  const operatingMicro = Math.round(treasuryMicro * 0.2);
  const creditsMicro = Math.round(treasuryMicro * 0.2);
  const strategyMicro = Math.round(treasuryMicro * 0.4);
  return { operatingMicro, creditsMicro, strategyMicro, reserveMicro: treasuryMicro - operatingMicro - creditsMicro - strategyMicro };
}

export const tokenInfoOf = (a: { tokenMint: string | null; tokenName: string | null; tokenTicker: string | null; tokenLaunchedAt: Date | null }): AgentTokenInfo | null =>
  a.tokenMint ? { mint: a.tokenMint, name: a.tokenName ?? '', ticker: a.tokenTicker ?? '', launchedAt: a.tokenLaunchedAt?.toISOString() ?? '', pumpUrl: pumpUrl(a.tokenMint) } : null;
