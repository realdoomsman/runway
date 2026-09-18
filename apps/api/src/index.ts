// Boot: .env → config → container → listen → runtime; graceful shutdown on SIGINT/SIGTERM.
import { describeConfig, loadConfig } from './config.js';
import { createContainer } from './core/container.js';
import { loadDotenv } from './lib/env.js';
import { createLogger } from './lib/log.js';

const SHUTDOWN_GRACE_MS = 9 * 60_000;   // > STEP_TIMEOUT_MS so in-flight steps can finish

async function main(): Promise<void> {
  loadDotenv();
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, pretty: !config.isProduction });
  for (const w of config.warnings) log.warn(w);
  log.info(describeConfig(config), 'runway api starting');

  const container = await createContainer(config, log);
  await container.start();
  log.info({ port: config.port, host: config.host }, 'runway api ready');

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const killer = setTimeout(() => {
      log.error('shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    killer.unref();
    container.stop().then(
      () => process.exit(0),
      (e: unknown) => {
        log.error({ err: e }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
