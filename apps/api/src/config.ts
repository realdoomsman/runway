// Zod-parsed environment → typed Config. SPEC-V2 §5.8 (supersedes SPEC §8.2): the $RUNWAY token, the
// holding gate and the seed are gone; purchases, the founder fee and the deposit poller take their place.
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_MAX_CONCURRENT_STEPS, FOUNDER_FEE_BPS_DEFAULT, MAX_HEARTBEAT_MIN, MAX_PURCHASE_MICRO,
  MIN_PURCHASE_MICRO, PURCHASE_TTL_HOURS, microToUsd, usd,
} from '@runway/shared';
import { REPO_ROOT } from './lib/env.js';
import { ConfigError } from './lib/errors.js';
import { AGENT_NETWORK_DEFAULT } from './sandbox/egress.js';

export const USDC_MINTS = {
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as const;

// How often the deposit poller looks at pending purchases (SPEC-V2 §5.3). Memory mode is free, so it
// ticks fast enough that a simulated payment completes inside one request; solana mode pays per RPC call.
export const DEPOSIT_POLL_MS_DEFAULT = { memory: 2_000, solana: 10_000 } as const;

export const FOUNDER_FEE_BPS_MAX = 3_000;               // 30%: refuse anything greedier at boot

// The demo colony's customers (sim/revenue.ts). They are the only "outside world" in memory mode, so
// DEMO=1 allow-lists them as external payers; on a real chain the list is whatever the operator sets.
export const DEMO_CUSTOMER_WALLETS: readonly string[] = [
  'acme-labs', 'northbridge-co', 'tinyshop', 'harbor-media', 'quiet-capital', 'fenwick-studio',
  'blue-tarp', 'oakline-devs', 'paper-route', 'seventh-street', 'lowlight-games', 'ridgeway-analytics',
];

// Insecure but deterministic dev-only defaults so `pnpm demo` works with an empty .env. They are
// PUBLIC CONSTANTS — anyone with this repository has them — so core/preflight.ts refuses to boot with
// either of them once CHAIN_MODE=solana, where they would be protecting real keys and real sessions.
export const DEV_SESSION_SECRET = 'runway-dev-session-secret-not-for-production!!';
export const DEV_KEY_ENCRYPTION_KEY = '0'.repeat(64);

const bool = z.preprocess((v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v), z.boolean());
const optional = (schema: z.ZodString) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const optionalNumber = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const list = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.string()),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:8787'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().default('postgres://localhost:5432/runway'),
  SESSION_SECRET: optional(z.string().min(32)),
  KEY_ENCRYPTION_KEY: optional(z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex chars (openssl rand -hex 32)')),
  CHAIN_MODE: z.enum(['memory', 'solana']).default('memory'),
  SOLANA_CLUSTER: z.enum(['devnet', 'mainnet-beta']).default('devnet'),
  // Empty falls through to the default so a blank line in .env gets the readable "name it out loud"
  // refusal below rather than a bare zod "Invalid URL".
  SOLANA_RPC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().default('https://api.devnet.solana.com')),
  USDC_MINT: optional(z.string()),
  TREASURY_WALLET_SECRET: optional(z.string()),
  FOUNDER_FEE_WALLET: optional(z.string()),
  FOUNDER_FEE_BPS: z.coerce.number().int().min(0).max(FOUNDER_FEE_BPS_MAX).default(FOUNDER_FEE_BPS_DEFAULT),
  PROTOCOL_FEE_WALLET: optional(z.string()),
  ESCROW_WALLET_SECRET: optional(z.string()),
  SOL_PRICE_USD: z.coerce.number().positive().default(150),
  ACCEPT_SOL_DEPOSITS: bool.default(true),
  ALLOW_MAINNET: bool.default(false),
  LLM_PROVIDER: z.enum(['router', 'mock', 'x402']).default('mock'),
  ANTHROPIC_API_KEY: optional(z.string()),
  OPENAI_API_KEY: optional(z.string()),
  OPENROUTER_API_KEY: optional(z.string()),
  LLM_ALLOWED_MODELS: list.default([]),
  // x402 mode: each agent pays an OpenAI-compatible x402 LLM gateway per call from its own Solana
  // wallet (USDC, HTTP 402). No provider API key is used. X402_MAX_PRICE_USD caps one payment.
  X402_GATEWAY_URL: optional(z.string().url()),
  X402_MAX_PRICE_USD: z.coerce.number().positive().default(0.5),
  SEARCH_PROVIDER: z.enum(['brave', 'tavily', 'none']).default('none'),
  BRAVE_API_KEY: optional(z.string()),
  TAVILY_API_KEY: optional(z.string()),
  // Sign in with Google (OAuth 2.0). Both required to enable the button; absent = feature off.
  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),
  SANDBOX_DRIVER: z.enum(['docker', 'local']).default('local'),
  SANDBOX_IMAGE: z.string().default('runway-sandbox:latest'),
  SANDBOX_NETWORK: z.string().min(1).max(60).default(AGENT_NETWORK_DEFAULT),
  SANDBOX_EGRESS_FILTERED: bool.default(false),   // the host firewall rules are installed (see sandbox/egress.ts)
  DATA_DIR: z.string().default('./data'),
  SITES_BASE_URL: optional(z.string().url()),
  MIN_PURCHASE_USD: z.coerce.number().min(1).default(microToUsd(MIN_PURCHASE_MICRO)),
  MAX_PURCHASE_USD: z.coerce.number().min(1).default(microToUsd(MAX_PURCHASE_MICRO)),
  PURCHASE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(PURCHASE_TTL_HOURS),
  DEPOSIT_POLL_MS: optionalNumber(z.coerce.number().int().min(250).max(600_000)),
  HEARTBEAT_OVERRIDE_MIN: optionalNumber(z.coerce.number().int().min(1).max(MAX_HEARTBEAT_MIN)),
  RENT_PER_HOUR_USD: z.coerce.number().min(0).default(0.005),
  EXTERNAL_PAYER_WALLETS: list.default([]),
  MAX_CONCURRENT_STEPS: z.coerce.number().int().min(1).max(64).default(DEFAULT_MAX_CONCURRENT_STEPS),
  DEMO: bool.default(false),
  DEMO_SEED: z.coerce.number().int().default(42),
  DEMO_AGENTS: z.coerce.number().int().min(0).max(500).default(36),
  DEMO_DAYS: z.coerce.number().int().min(1).max(365).default(45),
  DEMO_TREASURY_USD: z.coerce.number().min(0).default(2000),
});

type Env = z.infer<typeof envSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  version: string;
  port: number;
  host: string;
  publicUrl: string;
  apiUrl: string;
  logLevel: Env['LOG_LEVEL'];
  databaseUrl: string;
  sessionSecret: string;
  keyEncryptionKey: string;         // 64 hex chars; never log
  chain: {
    mode: Env['CHAIN_MODE'];
    cluster: Env['SOLANA_CLUSTER'];
    rpcUrl: string;
    usdcMint: string;
    treasuryWalletSecret: string | null;  // base58 or path to json keypair; never log
    founderFeeWallet: string | null;      // pubkey only: takes FOUNDER_FEE_BPS of every purchase
    protocolFeeWallet: string | null;
    escrowWalletSecret: string | null;    // never log
    solPriceUsd: number;
    acceptSolDeposits: boolean;
  };
  llm: {
    provider: Env['LLM_PROVIDER'];
    anthropicApiKey: string | null;
    openaiApiKey: string | null;
    openrouterApiKey: string | null;
    allowedModels: string[];        // empty = whole catalog
    x402: { gatewayUrl: string; maxPriceMicro: number } | null;
  };
  search: { provider: Env['SEARCH_PROVIDER']; braveApiKey: string | null; tavilyApiKey: string | null };
  auth: { google: { clientId: string; clientSecret: string } | null };
  sandbox: { driver: Env['SANDBOX_DRIVER']; image: string; network: string; egressFiltered: boolean };
  dataDir: string;                  // absolute
  sitesBaseUrl: string;
  economy: {
    minPurchaseMicro: number; maxPurchaseMicro: number; founderFeeBps: number; purchaseTtlHours: number;
    rentPerHourMicro: number; maxConcurrentSteps: number;
    // Wallets the operator has verified as genuine outside customers (a merchant of record, a
    // settlement wallet). Everything else must prove itself: see runtime/deposits.ts.
    externalPayers: string[];
    heartbeatOverrideMin: number | null;   // DEV ONLY: forces every new agent's heartbeat
    depositPollMs: number;
  };
  demo: { enabled: boolean; seed: number; agents: number; days: number; treasuryUsd: number };
  warnings: string[];               // dev fallbacks in use; logged once at boot
}

const require = createRequire(import.meta.url);
const pkgVersion = (): string => (require('../package.json') as { version: string }).version;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const warnings: string[] = [];

  const sessionSecret = e.SESSION_SECRET ?? devFallback('SESSION_SECRET', DEV_SESSION_SECRET, isProduction, warnings);
  const keyEncryptionKey = e.KEY_ENCRYPTION_KEY ?? devFallback('KEY_ENCRYPTION_KEY', DEV_KEY_ENCRYPTION_KEY, isProduction, warnings);

  if (e.SANDBOX_DRIVER === 'local' && isProduction) {
    throw new ConfigError('SANDBOX_DRIVER=local is not isolated and is refused when NODE_ENV=production; use docker');
  }
  // `bash` must not be able to reach what fetch_url refuses (cloud metadata, RFC1918, the host
  // gateway). Docker cannot express that, so production has to confirm the host rules are in place.
  if (e.SANDBOX_DRIVER === 'docker' && isProduction && !e.SANDBOX_EGRESS_FILTERED) {
    throw new ConfigError(
      'SANDBOX_EGRESS_FILTERED=1 is required in production: install the egress rules for the agent network '
      + '(see docs/OPERATIONS.md and apps/api/src/sandbox/egress.ts) before agents can run bash',
    );
  }
  if (e.CHAIN_MODE === 'solana') {
    const required = [
      ['TREASURY_WALLET_SECRET', e.TREASURY_WALLET_SECRET],
      ['ESCROW_WALLET_SECRET', e.ESCROW_WALLET_SECRET],
      ['PROTOCOL_FEE_WALLET', e.PROTOCOL_FEE_WALLET],
      ['FOUNDER_FEE_WALLET', e.FOUNDER_FEE_WALLET],
    ] as const;
    for (const [k, v] of required) {
      if (!v) throw new ConfigError(`${k} is required when CHAIN_MODE=solana`);
    }
    // The schema default is a devnet endpoint. Inheriting it while asking for a real chain is how a
    // mainnet deployment ends up quietly reading devnet, so the endpoint has to be stated out loud.
    if (!source['SOLANA_RPC_URL']) {
      throw new ConfigError(
        'SOLANA_RPC_URL is required when CHAIN_MODE=solana: name the endpoint explicitly rather than inheriting the '
        + `devnet default. Free public: https://api.${e.SOLANA_CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : e.SOLANA_CLUSTER}`
        + '.solana.com (rate limited); for anything real use a Helius or QuickNode URL.',
      );
    }
  }
  // Real money moves on mainnet: the operator has to say so out loud.
  if (e.SOLANA_CLUSTER === 'mainnet-beta' && !e.ALLOW_MAINNET) {
    throw new ConfigError(
      'SOLANA_CLUSTER=mainnet-beta moves real money: set ALLOW_MAINNET=1 to confirm you meant mainnet, '
      + 'or use SOLANA_CLUSTER=devnet',
    );
  }
  if (e.HEARTBEAT_OVERRIDE_MIN !== undefined && isProduction) {
    throw new ConfigError('HEARTBEAT_OVERRIDE_MIN is a development-only override and is refused when NODE_ENV=production');
  }
  if (e.LLM_PROVIDER === 'router' && !e.ANTHROPIC_API_KEY && !e.OPENAI_API_KEY && !e.OPENROUTER_API_KEY) {
    throw new ConfigError('LLM_PROVIDER=router needs at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY');
  }
  if (e.LLM_PROVIDER === 'x402' && !e.X402_GATEWAY_URL) {
    throw new ConfigError('LLM_PROVIDER=x402 needs X402_GATEWAY_URL: the OpenAI-compatible x402 LLM gateway each agent pays per call with USDC');
  }
  if (e.SEARCH_PROVIDER === 'brave' && !e.BRAVE_API_KEY) throw new ConfigError('SEARCH_PROVIDER=brave needs BRAVE_API_KEY');
  if (e.SEARCH_PROVIDER === 'tavily' && !e.TAVILY_API_KEY) throw new ConfigError('SEARCH_PROVIDER=tavily needs TAVILY_API_KEY');
  if (e.DEMO && (e.CHAIN_MODE !== 'memory' || e.LLM_PROVIDER !== 'mock')) {
    throw new ConfigError('DEMO=1 requires CHAIN_MODE=memory and LLM_PROVIDER=mock');
  }
  const minPurchaseMicro = usd(e.MIN_PURCHASE_USD);
  const maxPurchaseMicro = usd(e.MAX_PURCHASE_USD);
  if (maxPurchaseMicro < minPurchaseMicro) {
    throw new ConfigError(`MAX_PURCHASE_USD (${e.MAX_PURCHASE_USD}) must be at least MIN_PURCHASE_USD (${e.MIN_PURCHASE_USD})`);
  }

  return {
    env: e.NODE_ENV,
    isProduction,
    version: pkgVersion(),
    port: e.PORT,
    host: e.HOST,
    publicUrl: stripSlash(e.PUBLIC_URL),
    apiUrl: stripSlash(e.API_URL),
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    sessionSecret,
    keyEncryptionKey,
    chain: {
      mode: e.CHAIN_MODE,
      cluster: e.SOLANA_CLUSTER,
      rpcUrl: e.SOLANA_RPC_URL,
      usdcMint: e.USDC_MINT ?? USDC_MINTS[e.SOLANA_CLUSTER],
      treasuryWalletSecret: e.TREASURY_WALLET_SECRET ?? null,
      founderFeeWallet: e.FOUNDER_FEE_WALLET ?? null,
      protocolFeeWallet: e.PROTOCOL_FEE_WALLET ?? null,
      escrowWalletSecret: e.ESCROW_WALLET_SECRET ?? null,
      solPriceUsd: e.SOL_PRICE_USD,
      acceptSolDeposits: e.ACCEPT_SOL_DEPOSITS,
    },
    llm: {
      provider: e.LLM_PROVIDER,
      anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
      openaiApiKey: e.OPENAI_API_KEY ?? null,
      openrouterApiKey: e.OPENROUTER_API_KEY ?? null,
      allowedModels: e.LLM_ALLOWED_MODELS,
      x402: e.LLM_PROVIDER === 'x402' && e.X402_GATEWAY_URL
        ? { gatewayUrl: stripSlash(e.X402_GATEWAY_URL), maxPriceMicro: usd(e.X402_MAX_PRICE_USD) }
        : null,
    },
    search: { provider: e.SEARCH_PROVIDER, braveApiKey: e.BRAVE_API_KEY ?? null, tavilyApiKey: e.TAVILY_API_KEY ?? null },
    auth: {
      google: e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
        ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET }
        : null,
    },
    sandbox: {
      driver: e.SANDBOX_DRIVER, image: e.SANDBOX_IMAGE, network: e.SANDBOX_NETWORK,
      egressFiltered: e.SANDBOX_EGRESS_FILTERED,
    },
    dataDir: path.resolve(REPO_ROOT, e.DATA_DIR),
    sitesBaseUrl: stripSlash(e.SITES_BASE_URL ?? `${stripSlash(e.API_URL)}/sites`),
    economy: {
      minPurchaseMicro,
      maxPurchaseMicro,
      founderFeeBps: e.FOUNDER_FEE_BPS,
      purchaseTtlHours: e.PURCHASE_TTL_HOURS,
      rentPerHourMicro: usd(e.RENT_PER_HOUR_USD),
      maxConcurrentSteps: e.MAX_CONCURRENT_STEPS,
      // The demo colony's synthetic customers are the outside world in memory mode, so they are
      // allow-listed there and nowhere else.
      externalPayers: [...new Set(e.DEMO ? [...DEMO_CUSTOMER_WALLETS, ...e.EXTERNAL_PAYER_WALLETS] : e.EXTERNAL_PAYER_WALLETS)],
      heartbeatOverrideMin: e.HEARTBEAT_OVERRIDE_MIN ?? null,
      depositPollMs: e.DEPOSIT_POLL_MS ?? DEPOSIT_POLL_MS_DEFAULT[e.CHAIN_MODE],
    },
    demo: { enabled: e.DEMO, seed: e.DEMO_SEED, agents: e.DEMO_AGENTS, days: e.DEMO_DAYS, treasuryUsd: e.DEMO_TREASURY_USD },
    warnings,
  };
}

function devFallback(name: string, fallback: string, isProduction: boolean, warnings: string[]): string {
  if (isProduction) throw new ConfigError(`${name} is required when NODE_ENV=production`);
  warnings.push(`${name} not set: using an insecure development default`);
  return fallback;
}

const stripSlash = (u: string): string => u.replace(/\/+$/, '');

// Secret-free snapshot for the boot log.
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    env: c.env, version: c.version, port: c.port, publicUrl: c.publicUrl, apiUrl: c.apiUrl,
    chain: {
      mode: c.chain.mode, cluster: c.chain.cluster, usdcMint: c.chain.usdcMint,
      founderFeeWallet: c.chain.founderFeeWallet, acceptSolDeposits: c.chain.acceptSolDeposits,
    },
    llm: { provider: c.llm.provider, allowedModels: c.llm.allowedModels, keys: { anthropic: !!c.llm.anthropicApiKey, openai: !!c.llm.openaiApiKey, openrouter: !!c.llm.openrouterApiKey } },
    search: c.search.provider, sandbox: c.sandbox.driver, dataDir: c.dataDir, sitesBaseUrl: c.sitesBaseUrl,
    economy: { ...c.economy, founderFeeBps: c.economy.founderFeeBps }, demo: c.demo,
  };
}
