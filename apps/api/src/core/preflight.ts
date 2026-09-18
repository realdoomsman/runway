// Boot preflight: the server refuses to start in any configuration where the operator would think
// he is running for real and is not.
//
// `config.ts` parses the environment and refuses what is internally contradictory. This file refuses
// what is *externally* contradictory — a key that is set but will never be used, a real chain behind
// scripted agents, a docker driver with no daemon, an RPC that is not the cluster it claims to be.
// Nothing here reads a flag and believes it: the docker and chain checks actually call out.
//
// Every problem carries a remedy naming the exact variable to change. `assertReady` throws one error
// listing all of them at once, so a misconfigured .env is fixed in one pass rather than five boots.
import { TIERS, resolveTierModel, type ModelInfo } from '@runway/shared';
import type { Config } from '../config.js';
import { DEV_KEY_ENCRYPTION_KEY, DEV_SESSION_SECRET } from '../config.js';
import { ConfigError, errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';

/** Real genesis hashes. This is how the boot knows SOLANA_RPC_URL points where you think it does. */
export const GENESIS_HASHES: Record<string, string> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};

export const PREFLIGHT_TIMEOUT_MS = { docker: 20_000, rpc: 20_000 } as const;

export interface PreflightProblem {
  /** Stable id so a test can name the rule it is asserting. */
  id: string;
  /** What is wrong, in the operator's terms. */
  problem: string;
  /** The exact change that fixes it. */
  remedy: string;
}

export interface PreflightResult { problems: PreflightProblem[]; warnings: string[] }

/** Injectable probes so preflight is testable without a daemon or a cluster. */
export interface PreflightProbes {
  /** Resolves when the Docker daemon answers; rejects otherwise. */
  dockerPing?: () => Promise<void>;
  /** Resolves when the sandbox image exists locally; rejects otherwise. */
  dockerImage?: (image: string) => Promise<void>;
  /** The cluster's genesis hash, read from SOLANA_RPC_URL. */
  genesisHash?: (rpcUrl: string) => Promise<string>;
  /** Treasury SOL in lamports. Warning-only: an unfunded treasury cannot pay a single fee. */
  treasuryLamports?: () => Promise<number>;
}

/** Below this the treasury cannot create token accounts or pay gas stipends. */
export const MIN_TREASURY_LAMPORTS = 50_000_000;   // 0.05 SOL

// ---------------------------------------------------------------------------
// Static contradictions — no network, so these are also what the tests assert
// ---------------------------------------------------------------------------

/**
 * Configurations that are internally consistent but mean the opposite of what the operator intends.
 * DEMO=1 is the one explicit opt-in to the whole simulated stack, so it is exempt from the
 * "you set a key but it is not being used" family: `pnpm demo` must work with a full .env.
 */
export function configContradictions(config: Config): PreflightProblem[] {
  const out: PreflightProblem[] = [];
  const demo = config.demo.enabled;

  // 1. Keys bought and pasted in, then never used, because the mode switch was missed. This is the
  //    single most likely way to think you are running real models when every agent is a script.
  if (!demo && config.llm.provider === 'mock') {
    const set = ([
      ['ANTHROPIC_API_KEY', config.llm.anthropicApiKey],
      ['OPENAI_API_KEY', config.llm.openaiApiKey],
      ['OPENROUTER_API_KEY', config.llm.openrouterApiKey],
    ] as const).filter(([, v]) => v !== null).map(([k]) => k);
    if (set.length > 0) {
      out.push({
        id: 'llm.key-set-but-mock',
        problem: `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set, but LLM_PROVIDER=mock — every agent would `
          + 'think with a canned script and the key would never be called',
        remedy: 'Set LLM_PROVIDER=router in .env to use the key, or remove the key if you meant to stay on the mock. '
          + '`pnpm demo` forces the mock deliberately and is exempt from this check.',
      });
    }
  }

  // 2. Same mistake, the money half: wallets configured, chain still simulated.
  if (!demo && config.chain.mode === 'memory') {
    const set = ([
      ['TREASURY_WALLET_SECRET', config.chain.treasuryWalletSecret],
      ['ESCROW_WALLET_SECRET', config.chain.escrowWalletSecret],
      ['FOUNDER_FEE_WALLET', config.chain.founderFeeWallet],
      ['PROTOCOL_FEE_WALLET', config.chain.protocolFeeWallet],
    ] as const).filter(([, v]) => v !== null).map(([k]) => k);
    if (set.length > 0) {
      out.push({
        id: 'chain.wallets-set-but-memory',
        problem: `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set, but CHAIN_MODE=memory — deposit addresses `
          + 'are fake, no USDC moves and no founder fee is ever paid',
        remedy: 'Set CHAIN_MODE=solana in .env to use those wallets, or clear them if you meant to stay in the '
          + 'simulator. `pnpm demo` forces the simulator deliberately and is exempt from this check.',
      });
    }
  }

  // 3. And the search half.
  if (!demo && config.search.provider === 'none') {
    const set = ([
      ['BRAVE_API_KEY', config.search.braveApiKey],
      ['TAVILY_API_KEY', config.search.tavilyApiKey],
    ] as const).filter(([, v]) => v !== null).map(([k]) => k);
    if (set.length > 0) {
      out.push({
        id: 'search.key-set-but-none',
        problem: `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set, but SEARCH_PROVIDER=none — the web_search `
          + 'tool returns nothing and agents cannot look anything up',
        remedy: `Set SEARCH_PROVIDER=${config.search.braveApiKey ? 'brave' : 'tavily'} in .env, or remove the key.`,
      });
    }
  }

  // 4. Real wallets encrypted with a key that is printed in this repository. Every agent secret and
  //    every deposit key in the database would be readable by anyone who has the source.
  if (config.chain.mode === 'solana') {
    if (config.keyEncryptionKey === DEV_KEY_ENCRYPTION_KEY) {
      out.push({
        id: 'secrets.dev-kek-on-real-chain',
        problem: 'KEY_ENCRYPTION_KEY is the development default, which is a public constant in this repository, '
          + 'but CHAIN_MODE=solana stores real agent and deposit keys encrypted with it',
        remedy: 'Put a real key in .env BEFORE any wallet is stored — it cannot be changed afterwards without '
          + 'losing every stored secret:  openssl rand -hex 32',
      });
    }
    if (config.sessionSecret === DEV_SESSION_SECRET) {
      out.push({
        id: 'secrets.dev-session-on-real-chain',
        problem: 'SESSION_SECRET is the development default, which is a public constant in this repository, but '
          + 'CHAIN_MODE=solana means those sessions own real money',
        remedy: 'Put a real secret in .env:  openssl rand -base64 48',
      });
    }
  }

  // 5. Unisolated bash next to real money. `local` runs agent commands as the API user on this host.
  if (config.chain.mode === 'solana' && config.sandbox.driver === 'local') {
    out.push({
      id: 'sandbox.local-on-real-chain',
      problem: 'SANDBOX_DRIVER=local runs agent bash directly on this machine as the API user — no container, no '
        + 'memory limit, no network boundary — and CHAIN_MODE=solana means those agents hold real keys',
      remedy: 'Set SANDBOX_DRIVER=docker in .env and build the image once:  docker build -t '
        + `${config.sandbox.image} docker/sandbox`,
    });
  }

  // 6. Real money, scripted minds. The purchases would be real and the agents would be theatre.
  if (config.chain.cluster === 'mainnet-beta' && config.chain.mode === 'solana' && config.llm.provider === 'mock') {
    out.push({
      id: 'llm.mock-on-mainnet',
      problem: 'SOLANA_CLUSTER=mainnet-beta takes real money for agents that would run on the mock provider',
      remedy: 'Set LLM_PROVIDER=router and add at least one provider key before selling anything on mainnet.',
    });
  }

  // 7. An RPC URL that names a different cluster than SOLANA_CLUSTER. The genesis probe below proves
  //    this properly, but the URL alone catches the copy-paste before a single packet leaves.
  if (config.chain.mode === 'solana') {
    const named = clusterNamedInUrl(config.chain.rpcUrl);
    if (named !== null && named !== config.chain.cluster) {
      out.push({
        id: 'chain.rpc-url-cluster-mismatch',
        problem: `SOLANA_CLUSTER=${config.chain.cluster} but SOLANA_RPC_URL names ${named} (${config.chain.rpcUrl})`,
        remedy: `Set SOLANA_CLUSTER=${named}, or point SOLANA_RPC_URL at a ${config.chain.cluster} endpoint. `
          + 'Getting this wrong sends real purchases to a chain nobody is watching.',
      });
    }
  }

  // 8. The seeded demo colony on a production deploy: 36 invented agents and a faucetted treasury,
  //    presented to real visitors as the real thing.
  if (demo && config.isProduction) {
    out.push({
      id: 'demo.on-production',
      problem: 'DEMO=1 seeds an invented colony with a faucetted treasury, and NODE_ENV=production means real '
        + 'visitors would be shown it as real',
      remedy: 'Remove DEMO=1 from the production environment. `pnpm demo` is for showing the product locally.',
    });
  }

  return out;
}

/**
 * Models with a condition attached that is not visible in the catalog. Nothing here blocks a boot;
 * each one is a first-call 400 waiting to happen if the operator does not know about it.
 */
export const MODEL_CAVEATS: Record<string, string> = {
  'claude-fable-5-1': 'claude-fable-5-1 requires 30-day data retention on the Anthropic organisation. '
    + 'A zero-data-retention org gets a 400 invalid_request_error on EVERY call to it.',
};

/** Things worth saying out loud at boot that are not, by themselves, reasons to refuse. */
export function configWarnings(config: Config): string[] {
  const out: string[] = [];
  for (const id of config.llm.allowedModels) {
    const caveat = MODEL_CAVEATS[id.trim()];
    if (caveat) out.push(caveat);
  }
  if (config.sandbox.driver === 'docker' && !config.sandbox.egressFiltered) {
    out.push(
      'SANDBOX_EGRESS_FILTERED=0: the host firewall half of the egress boundary is not installed, so agent bash '
      + 'can reach private addresses the fetch_url tool refuses. Container-to-container isolation also depends on '
      + 'the runtime honouring enable_icc=false, which OrbStack on macOS does NOT — verify it on the Linux host.',
    );
  }
  return out;
}

/** The host in SOLANA_RPC_URL names a cluster, or null when it names none (a private Helius/QuickNode URL). */
export function clusterNamedInUrl(rpcUrl: string): string | null {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.includes('devnet')) return 'devnet';
  if (host.includes('testnet')) return 'testnet';
  if (host.includes('mainnet')) return 'mainnet-beta';
  return null;
}

// ---------------------------------------------------------------------------
// Live probes — these actually call out
// ---------------------------------------------------------------------------

export async function livePreflight(config: Config, probes: PreflightProbes): Promise<PreflightResult> {
  const problems: PreflightProblem[] = [];
  const warnings: string[] = [];

  if (config.sandbox.driver === 'docker') {
    const ping = probes.dockerPing;
    if (ping) {
      try {
        await withTimeout('Docker daemon', PREFLIGHT_TIMEOUT_MS.docker, ping);
        const image = probes.dockerImage;
        if (image) {
          try {
            await withTimeout('Docker image', PREFLIGHT_TIMEOUT_MS.docker, () => image(config.sandbox.image));
          } catch (e) {
            problems.push({
              id: 'sandbox.image-missing',
              problem: `SANDBOX_DRIVER=docker but the image "${config.sandbox.image}" is not on this machine `
                + `(${errorMessage(e)}) — every agent's first bash call would fail`,
              remedy: `Build it once:  docker build -t ${config.sandbox.image} docker/sandbox`,
            });
          }
        }
      } catch (e) {
        problems.push({
          id: 'sandbox.daemon-unreachable',
          problem: `SANDBOX_DRIVER=docker but the Docker daemon did not answer (${errorMessage(e)})`,
          remedy: 'Start Docker (OrbStack or Docker Desktop) and check `docker info`, or set SANDBOX_DRIVER=local '
            + 'for an unisolated development run.',
        });
      }
    }
  }

  if (config.chain.mode === 'solana' && probes.genesisHash) {
    const read = probes.genesisHash;
    try {
      const genesis = await withTimeout('Solana RPC', PREFLIGHT_TIMEOUT_MS.rpc, () => read(config.chain.rpcUrl));
      const expected = GENESIS_HASHES[config.chain.cluster];
      if (expected !== undefined && genesis !== expected) {
        const actual = Object.entries(GENESIS_HASHES).find(([, h]) => h === genesis)?.[0] ?? `an unknown cluster (${genesis})`;
        problems.push({
          id: 'chain.wrong-cluster',
          problem: `SOLANA_CLUSTER=${config.chain.cluster} but SOLANA_RPC_URL really is ${actual}`,
          remedy: `Either set SOLANA_CLUSTER to match the endpoint, or point SOLANA_RPC_URL at a `
            + `${config.chain.cluster} endpoint. The USDC mint is chosen from SOLANA_CLUSTER, so this mismatch `
            + 'makes every deposit unreadable.',
        });
      }
    } catch (e) {
      problems.push({
        id: 'chain.rpc-unreachable',
        problem: `CHAIN_MODE=solana but SOLANA_RPC_URL (${config.chain.rpcUrl}) did not answer: ${errorMessage(e)}`,
        remedy: 'Check this machine is online. https://api.devnet.solana.com is free but heavily rate limited; '
          + 'for anything real put a Helius or QuickNode URL in SOLANA_RPC_URL.',
      });
    }
  }

  if (config.chain.mode === 'solana' && probes.treasuryLamports) {
    const read = probes.treasuryLamports;
    try {
      const lamports = await withTimeout('Treasury balance', PREFLIGHT_TIMEOUT_MS.rpc, read);
      if (lamports < MIN_TREASURY_LAMPORTS) {
        warnings.push(
          `treasury holds ${(lamports / 1e9).toFixed(6)} SOL, below the ${(MIN_TREASURY_LAMPORTS / 1e9).toFixed(2)} SOL `
          + 'needed to create token accounts and pay gas: the first purchase will fail until it is funded',
        );
      }
    } catch (e) {
      warnings.push(`could not read the treasury SOL balance: ${errorMessage(e)}`);
    }
  }

  return { problems, warnings };
}

// ---------------------------------------------------------------------------
// Non-blocking honesty warnings
// ---------------------------------------------------------------------------

/**
 * SPEC-V2 §2.3 lets a tier substitute a model when the one it is sold with is unavailable. That is
 * deliberate and the substitute is shown on /api/tiers, but it must never be quiet in the log: a
 * PRIME buyer paying for claude-opus-5 and getting a cheap open model is the thing to notice.
 */
export function tierSubstitutions(models: readonly ModelInfo[]): string[] {
  const out: string[] = [];
  for (const tier of TIERS) {
    const resolved = resolveTierModel(tier, models);
    if (resolved === null) {
      out.push(`tier ${tier.id} is sold with ${tier.modelId} and NO model is available to run it`);
    } else if (resolved.id !== tier.modelId) {
      out.push(`tier ${tier.id} is sold with ${tier.modelId} but will run ${resolved.id} — buyers are shown the substitute on /api/tiers`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface AssertReadyInput {
  config: Config;
  log: Logger;
  probes?: PreflightProbes;
  /** The router's enabled catalog, for the tier-substitution warning. */
  models?: readonly ModelInfo[];
}

/** Throws one error naming every problem, or logs the warnings and returns. */
export async function assertReady(input: AssertReadyInput): Promise<void> {
  const { config, log } = input;
  const problems = configContradictions(config);
  const live = await livePreflight(config, input.probes ?? {});
  problems.push(...live.problems);

  const warnings = [...configWarnings(config), ...live.warnings];
  if (input.models) warnings.push(...tierSubstitutions(input.models));
  if (config.llm.provider === 'mock') {
    warnings.push('LLM_PROVIDER=mock: every agent thinks with a canned script, not a real model');
  }
  if (config.chain.mode === 'memory') {
    warnings.push('CHAIN_MODE=memory: deposit addresses are simulated and no USDC moves');
  }
  for (const w of warnings) log.warn({ preflight: true }, w);

  if (problems.length === 0) {
    log.info({ checks: describeChecks(config) }, 'preflight passed');
    return;
  }
  throw new ConfigError(renderProblems(problems));
}

export function renderProblems(problems: readonly PreflightProblem[]): string {
  const body = problems
    .map((p, i) => `  ${i + 1}. ${p.problem}\n     FIX: ${p.remedy}`)
    .join('\n\n');
  return `RUNWAY refuses to start. ${problems.length} configuration `
    + `${problems.length === 1 ? 'problem' : 'problems'} would make it look like it was running for real when it is not:\n\n`
    + `${body}\n\nRun \`pnpm ready\` for the full report.`;
}

function describeChecks(config: Config): Record<string, string> {
  return {
    chain: config.chain.mode === 'solana' ? `solana:${config.chain.cluster} (reachable, genesis verified)` : 'memory (simulated)',
    llm: config.llm.provider === 'router' ? 'router (real provider keys)' : 'mock (scripted)',
    sandbox: config.sandbox.driver === 'docker' ? 'docker (daemon up, image present)' : 'local (unisolated)',
    demo: config.demo.enabled ? 'DEMO=1 (seeded colony, simulated everything)' : 'off',
  };
}

async function withTimeout<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
