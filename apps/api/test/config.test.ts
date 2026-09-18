import { describe, expect, it } from 'vitest';
import { FOUNDER_FEE_BPS_DEFAULT, MAX_PURCHASE_MICRO, MIN_PURCHASE_MICRO, PURCHASE_TTL_HOURS } from '@runway/shared';
import { DEPOSIT_POLL_MS_DEFAULT, loadConfig, USDC_MINTS, describeConfig } from '../src/config.js';

const base = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

/** Everything CHAIN_MODE=solana requires, so a test can break exactly one thing at a time. */
const solanaEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...base,
  CHAIN_MODE: 'solana', SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  TREASURY_WALLET_SECRET: 't', ESCROW_WALLET_SECRET: 'e', PROTOCOL_FEE_WALLET: 'p', FOUNDER_FEE_WALLET: 'f',
  ...over,
});

describe('loadConfig', () => {
  it('applies dev defaults and warns about insecure fallbacks', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8787);
    expect(c.chain.mode).toBe('memory');
    expect(c.chain.usdcMint).toBe(USDC_MINTS.devnet);
    expect(c.chain.founderFeeWallet).toBeNull();
    expect(c.chain.acceptSolDeposits).toBe(true);
    expect(c.llm.provider).toBe('mock');
    expect(c.sandbox.driver).toBe('local');
    expect(c.economy.minPurchaseMicro).toBe(MIN_PURCHASE_MICRO);
    expect(c.economy.maxPurchaseMicro).toBe(MAX_PURCHASE_MICRO);
    expect(c.economy.founderFeeBps).toBe(FOUNDER_FEE_BPS_DEFAULT);
    expect(c.economy.purchaseTtlHours).toBe(PURCHASE_TTL_HOURS);
    expect(c.economy.rentPerHourMicro).toBe(5_000);          // $0.12/day: the v2 survival tuning
    expect(c.economy.heartbeatOverrideMin).toBeNull();
    expect(c.economy.depositPollMs).toBe(DEPOSIT_POLL_MS_DEFAULT.memory);
    expect(c.demo.treasuryUsd).toBe(2000);
    expect(c.sitesBaseUrl).toBe('http://localhost:8787/sites');
    expect(c.dataDir).toMatch(/\/data$/);
    expect(c.warnings).toHaveLength(2);
  });

  it('parses lists, booleans and cluster-specific mints', () => {
    const c = loadConfig({ ...base, LLM_ALLOWED_MODELS: 'a, b ,,c', DEMO: '1', SOLANA_CLUSTER: 'mainnet-beta', ALLOW_MAINNET: '1' });
    expect(c.llm.allowedModels).toEqual(['a', 'b', 'c']);
    expect(c.demo.enabled).toBe(true);
    expect(c.chain.usdcMint).toBe(USDC_MINTS['mainnet-beta']);
  });

  it('polls the chain less often when the RPC costs money', () => {
    expect(loadConfig(solanaEnv()).economy.depositPollMs).toBe(DEPOSIT_POLL_MS_DEFAULT.solana);
    expect(loadConfig(solanaEnv({ DEPOSIT_POLL_MS: '4000' })).economy.depositPollMs).toBe(4000);
  });

  // The schema default for SOLANA_RPC_URL is a devnet endpoint. Inheriting it while asking for a real
  // chain is how a mainnet deployment quietly reads devnet, so solana mode has to name the endpoint.
  it('refuses CHAIN_MODE=solana that never named an RPC endpoint', () => {
    const { SOLANA_RPC_URL: _omitted, ...withoutRpc } = solanaEnv();
    expect(() => loadConfig(withoutRpc)).toThrow(/SOLANA_RPC_URL is required when CHAIN_MODE=solana/);
    expect(loadConfig(solanaEnv()).chain.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(loadConfig(base).chain.rpcUrl).toBe('https://api.devnet.solana.com');   // memory mode never reads it
  });

  it('refuses the local sandbox in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), KEY_ENCRYPTION_KEY: 'a'.repeat(64), SANDBOX_DRIVER: 'local' }))
      .toThrow(/SANDBOX_DRIVER=local/);
  });

  it('requires secrets in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SANDBOX_DRIVER: 'docker' })).toThrow(/SESSION_SECRET is required/);
  });

  it('requires all four wallets for solana mode and keys for the router', () => {
    expect(() => loadConfig({ ...base, CHAIN_MODE: 'solana' })).toThrow(/TREASURY_WALLET_SECRET/);
    expect(() => loadConfig({ ...base, CHAIN_MODE: 'solana', TREASURY_WALLET_SECRET: 't', ESCROW_WALLET_SECRET: 'e', PROTOCOL_FEE_WALLET: 'p' }))
      .toThrow(/FOUNDER_FEE_WALLET/);
    expect(() => loadConfig({ ...base, LLM_PROVIDER: 'router' })).toThrow(/at least one of/);
    expect(() => loadConfig({ ...base, DEMO: '1', LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k' })).toThrow(/DEMO=1 requires/);
  });

  it('refuses mainnet without ALLOW_MAINNET, and says why', () => {
    expect(() => loadConfig({ ...base, SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(/ALLOW_MAINNET=1/);
    expect(() => loadConfig({ ...base, SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(/real money/);
  });

  it('refuses a heartbeat override in production and an absurd founder fee anywhere', () => {
    const prod = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), KEY_ENCRYPTION_KEY: 'a'.repeat(64), SANDBOX_DRIVER: 'docker', SANDBOX_EGRESS_FILTERED: '1' };
    expect(() => loadConfig({ ...prod, HEARTBEAT_OVERRIDE_MIN: '5' })).toThrow(/HEARTBEAT_OVERRIDE_MIN/);
    expect(loadConfig({ ...base, HEARTBEAT_OVERRIDE_MIN: '5' }).economy.heartbeatOverrideMin).toBe(5);
    expect(() => loadConfig({ ...base, FOUNDER_FEE_BPS: '3001' })).toThrow(/FOUNDER_FEE_BPS/);
    expect(loadConfig({ ...base, FOUNDER_FEE_BPS: '0' }).economy.founderFeeBps).toBe(0);
  });

  it('refuses a purchase range that cannot be satisfied', () => {
    expect(() => loadConfig({ ...base, MIN_PURCHASE_USD: '100', MAX_PURCHASE_USD: '50' })).toThrow(/MAX_PURCHASE_USD/);
    expect(() => loadConfig({ ...base, MIN_PURCHASE_USD: '0.5' })).toThrow(/MIN_PURCHASE_USD/);
  });

  it('validates the encryption key shape', () => {
    expect(() => loadConfig({ ...base, KEY_ENCRYPTION_KEY: 'nothex' })).toThrow(/64 hex/);
  });

  it('never prints a secret in the boot snapshot', () => {
    const c = loadConfig({ ...base, TREASURY_WALLET_SECRET: 'super-secret-base58', FOUNDER_FEE_WALLET: 'FounderPubkey111' });
    const printed = JSON.stringify(describeConfig(c));
    expect(printed).not.toContain('super-secret-base58');
    expect(printed).not.toContain(c.sessionSecret);
    expect(printed).not.toContain(c.keyEncryptionKey);
    expect(printed).toContain('FounderPubkey111');
    expect(printed).toContain('"founderFeeBps":1000');
  });
});
