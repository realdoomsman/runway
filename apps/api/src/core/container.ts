// Composition root: builds every dependency from Config in dependency order and owns start/stop.
import { createChain } from '../chain/index.js';
import type { Config } from '../config.js';
import { assertSchema, createDb } from '../db/client.js';
import { createServices, hostingLedgerHook, hostingRefund } from '../economy/index.js';
import type { HostingDeps } from '../hosting/index.js';
import { createServer } from '../http/index.js';
import { FastClock, systemClock } from '../lib/clock.js';
import type { Logger } from '../lib/log.js';
import { createLlmRouter } from '../llm/index.js';
import { createPayments } from '../payments/index.js';
import { createRuntime } from '../runtime/index.js';
import { createSandbox } from '../sandbox/index.js';
import { createSearch } from '../search/index.js';
import { runDemo } from '../sim/index.js';
import { createToolRegistry } from '../tools/index.js';
import { createBus } from './bus.js';
import type { Clock, CoreDeps, Deps, HttpServer } from './interfaces.js';
import { toolPorts } from './ports.js';
import { assertReady, type PreflightProbes } from './preflight.js';
import { realProbes } from './probes.js';

export interface Container {
  deps: Deps;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ContainerOpts {
  /** Test seam for the boot preflight; production passes the real daemon and RPC probes. */
  probes?: PreflightProbes;
}

export async function createContainer(config: Config, log: Logger, opts: ContainerOpts = {}): Promise<Container> {
  const dbHandle = createDb(config.databaseUrl);
  const clock: Clock = config.demo.enabled ? new FastClock() : systemClock;
  const core: CoreDeps = {
    config,
    db: dbHandle.db,
    clock,
    bus: createBus(log),
    log,
    chain: await createChain(config, log.child({ mod: 'chain' }), { clock }),
    sandbox: createSandbox(config, log.child({ mod: 'sandbox' })),
    search: createSearch(config, log.child({ mod: 'search' })),
    llm: createLlmRouter(config, log.child({ mod: 'llm' })),
  };
  // `deps` is one object the late members are attached to; the ports below read it at call time,
  // so they see `services`/`runtime` once they exist.
  const deps: Deps = { ...core, tools: null as never };
  deps.tools = createToolRegistry(deps, toolPorts(deps));
  deps.services = createServices(deps);
  deps.runtime = createRuntime(deps);
  // Payments read `services` lazily at call time (fulfilment spawns through it), so the order here
  // only has to put the object in place before anything is started.
  deps.payments = createPayments(deps);
  // POST /svc charges the seller's compute and refunds a buyer whose handler run failed.
  (deps as HostingDeps).hostingLedger = hostingLedgerHook(deps);
  (deps as HostingDeps).hostingRefund = hostingRefund(deps);
  let http: HttpServer | null = null;

  return {
    deps,
    async start() {
      await assertSchema(deps.db);
      // Before anything listens or spends: refuse every configuration that would look real and not be.
      // The docker and chain probes actually call out; nothing here trusts a flag.
      await assertReady({
        config,
        log: log.child({ mod: 'preflight' }),
        probes: opts.probes ?? realProbes(config, deps.chain),
        models: deps.llm.models(),
      });
      await deps.llm.refreshPricing();
      http = await createServer(deps);
      await http.listen();
      if (config.demo.enabled) {
        log.info({ agents: config.demo.agents, days: config.demo.days, seed: config.demo.seed }, 'seeding demo colony');
        await runDemo(deps);
      }
      await deps.runtime!.start();
      await deps.payments!.start();
    },
    async stop() {
      await deps.payments?.stop();
      await deps.runtime?.stop();
      await http?.close();
      await dbHandle.close();
    },
  };
}
