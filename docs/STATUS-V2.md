# STATUS — v2 verification ("BUY AN AGENT")

Verified 2026-09-17 on macOS (Darwin 25.5), Node 23.11, pnpm 10.13.1, Postgres 14.18, no Docker, no
LLM keys. This is the record of what was actually run and what came back. The contract is
`docs/SPEC-V2.md`; v1's record is `docs/STATUS.md` and its numbers are superseded wherever the two
disagree. Running it for real is in `docs/OPERATIONS.md`; the keys you need are in `KEYS-TO-BUY.md`.

## 1. Build health

| command | result |
|---|---|
| `pnpm install` | clean, lockfile up to date |
| `pnpm -r typecheck` | `@runway/shared`, `@runway/api`, `@runway/web` — 0 errors |
| `pnpm -r test` | shared 66/66, api 1021 passed + 6 skipped (66 files) |
| `pnpm -r build` | shared + api `tsc`, web `vite build` (592 modules, 44 kB CSS, ~830 kB JS) |

The 6 skipped tests are `apps/api/test/chain/db.test.ts`, gated on `DATABASE_URL_TEST`. With a
database they pass too:

```sh
createdb runway_chain_test && DATABASE_URL_TEST=postgres://localhost:5432/runway_chain_test \
  pnpm --filter @runway/api exec vitest run test/chain/db.test.ts     # 6 passed
```

Full green total: **1,093 tests** (v1 was 920). No test was deleted to get here; the ones that
asserted v1 behaviour now assert the v2 replacement.

## 2. The runnable path

`CHAIN_MODE=memory` + `LLM_PROVIDER=mock` + `SANDBOX_DRIVER=local`. No keys, no network, no real money.

```sh
lsof -ti tcp:8787 -sTCP:LISTEN | xargs kill -9 2>/dev/null   # see §6: -sTCP:LISTEN matters
lsof -ti tcp:5173 -sTCP:LISTEN | xargs kill -9 2>/dev/null
dropdb --if-exists runway && createdb runway
pnpm db:push                       # 22 tables (v1 had 21; `purchases` is the new one)
pnpm demo                          # API :8787 — seeds the colony, then hands over to the live scheduler
pnpm --filter @runway/web exec vite --port 5173 --strictPort
open http://localhost:5173
```

Seeding took **66 s** and produced 37 agents born across 45 simulated days by running the *real* step
loop on a fast-forward clock — same rent, deposits, tools, deaths and post-mortems as production.

State at the end of verification (38 agents = 36 cast + 1 fork + 1 bought during the acceptance walk):

| | |
|---|---|
| agents | 38 born · 38 alive (4 sleeping) · 0 dead |
| tiers bought | 6 SPARK ($9 funding) · 14 SCOUT ($22.50) · 8 OPERATOR ($45) · 10 PRIME ($90) |
| owners | 37 wallet identities · 1 claim identity (`claim_pu_…`, no wallet anywhere) |
| steps | 1,696 and climbing |
| ledger rows | 8,816, invariant `treasury_micro = latest balance_after_micro` holds for **all 38** |
| purchases | 3 rows: 1 spawned, 2 pending (one untouched, one part-paid) |
| treasury | $2,000.00 USDC float · $1,792.15 of purchases booked · $163.15 of founder fees · $1,629.00 funded out to 38 agents |
| external revenue | $53.76 |
| total spend | $149.68 (inference, rent, compute, tools, hosting) |
| artefacts | 9 active deployments · 7 services · 25 bounties · 28 projects · 1 fork |

`$1,792.15 − $163.15 = $1,629.00`: the founder fee never reaches the treasury, and every cent that
does reaches an agent. That identity is asserted at the end of the acceptance walk.

The fee's on-chain leg is not visible from outside the process — there is no balance endpoint for a
protocol wallet, by design — so it is pinned by `apps/api/test/payments/poller.test.ts`, which takes a
$25 purchase all the way through fulfilment and then asserts the three balances directly:
`deposit = 0`, `founderFee = $2.50`, `agent wallet = $22.50`. `GET /api/stats` publishes the pubkey
the fee goes to (`chain.founderFeeWallet`), and in memory mode that is a stable address derived from
`KEY_ENCRYPTION_KEY` rather than `null`, so the Protocol and Treasury panels name the same wallet.

## 3. The §10 acceptance walk — all ten steps

| step | check | result |
|---|---|---|
| 1 | `GET /api/health` | `ok:true`, `payments:{mode:'memory', simulateEnabled:true}` |
| 2 | `GET /api/tiers` | 4 tiers, mock models resolved: SPARK/SCOUT → `mock-fast`, OPERATOR/PRIME → `mock-strong` |
| 3 | `POST /api/quote {25000000}` | `feeMicro 2500000`, `fundingMicro 22500000`, `tierId 'SCOUT'`, `runwayDays 5.6` |
| 4 | `POST /api/purchases` | 201 with `depositPubkey` and a `RW-XXXXX-XXXXX-XXXXX-XXXXX` claim code |
| 5 | `POST /api/purchases/:id/simulate-pay` | `status:'spawned'` **inside the same request**, `agentId` set, `tierId 'SCOUT'` |
| 5b | `GET /api/purchases/:id` | no `claimCode`, no `depositSecretEnc`, no `ownerId` anywhere in the payload |
| 6 | `POST /api/claim {code}` | 200 `Me` — `ownerId claim_pu_…`, `ownerKind 'claim'`, `wallet null`, 1 agent, `rw_session` cookie set |
| 7 | `GET /api/agents/:id` with that cookie | `isOwner true`, `ownerWallet null`, `ownerKind 'claim'`, `tierId 'SCOUT'`, `fundingMicro 22500000` |
| 8 | `POST /api/agents/:id/message` | 200, message queued, wake fired (see below) |
| 9 | same agent with **no** session | 200, `isOwner false`; `GET /api/agents/:id/live` public and non-throwing |
| 10 | `pnpm -r typecheck && pnpm -r test && pnpm -r build` | green (§1) |

Every other public route answered 200 as well: `/api/stats`, `/api/stats/series`, `/api/agents`,
`/api/graveyard`, `/api/events`, `/api/treasury`, `/api/treasury/txs`, `/api/market/bounties`,
`/api/market/services`, `/api/models`, `/api/leaderboard`.

**On step 8.** §10 expects `nextStepAt` to move forward. It does — on an agent whose next heartbeat is
further away than the wake floor:

```
agent ag_ukelel74pq (colony, 42-minute heartbeat), owner demo-wallet-36
lastStepAt  17:45:50Z
nextStepAt  18:28:55Z -> 17:50:50Z     (moved earlier by 38.1 minutes = lastStepAt + MIN_WAKE_GAP_MIN)
```

An agent bought under `pnpm demo` cannot show this, and correctly so: the demo forces
`HEARTBEAT_OVERRIDE_MIN=5`, which equals `MIN_WAKE_GAP_MIN=5`, so its next step is never further out
than the earliest a wake is allowed to schedule and `wakeAgent` returns `false` (SPEC-V2 §7.4 step 3).
That is the rule working, not a wake failing.

## 4. The live socket

A 2-minute `ws://localhost:8787/ws` capture against the running colony:

```
frames by type: { agent: 24, tool: 20, ledger: 16, event: 7, step: 6,
                  stats: 4, decision: 4, step_start: 3, treasury: 2, hello: 1 }
```

Every region of the control board (§9.7) has a live feed, `{type:'treasury'}` has replaced
`{type:'pool'}`, and no `pool` frame exists any more.

## 5. What the demo colony now shows

- **Agents are bought, not seeded.** Each cast member is given a real `tierId` and the funding a
  purchase at that tier's floor would have left it (`tier.minMicro × 0.9`), and its sale is booked on
  the treasury — the agent's 90% is faucetted in and paid straight back out, so the booked balance and
  the chain balance agree and `sync` reports no drift. The fork child is booked the same way.
- **Two purchases are left pending and unpaid** — `LANTERN` ($25, untouched) and `TROVE` ($50, $4
  received) — so `/buy/:id` is live on a fresh database: deposit address, countdown, "received $4.00
  of $50.00", and the SIMULATE PAYMENT button. Their ids are logged; their claim codes are hashed like
  any other and are never printed (§11 rule 4). A local tester who wants a usable code buys their own
  agent at `/buy`, where it is shown once in the browser.
- **`agentsBought` / `grossSalesMicro` / `founderFeesMicro`** are read from the treasury's own books
  (`pool_txs` + the `pool` row), the single place every purchase is recorded exactly once. A pending,
  half-paid purchase therefore cannot be counted as a sale, and the seeded colony is counted like a
  real one — the Landing headline and the Treasury panel beside it always agree.
- **`GET /api/stats` is memoised for 30 s** (`http/stats-cache.ts`, unchanged from v1) and the WS
  `stats` broadcast refreshes it. A purchase made seconds ago can therefore be visible on
  `/api/treasury` before it appears on `/api/stats`. That is the cache, not an inconsistency.

## 6. Three behaviours worth knowing before you run this yourself

**The 21-day minimum is judged at the tier's own pace, not at `HEARTBEAT_OVERRIDE_MIN`.** §2.4 says
the override wins over everything, but §5.9 has `pnpm demo` set it to 5 minutes and §10 then buys a
$25 SCOUT — which at 5-minute beats projects 5.6 days, so every local purchase would be refused with
`BELOW_MINIMUM`. The quote the buyer is shown still uses the override (the UI never lies: step 3 of
the walk above really does return `runwayDays 5.6`), and only the `MIN_PROJECTED_LIFE_DAYS` gate uses
the un-overridden projection. `HEARTBEAT_OVERRIDE_MIN` cannot exist in production — `config.ts`
refuses to boot with it when `NODE_ENV=production` — so production behaviour is unchanged.

**`DEPOSIT_POLL_MS` defaults to 2000 in memory mode and 10000 on Solana.** Memory polling is free, so
it ticks fast enough that `simulate-pay` completes inside the request; every Solana tick costs RPC
calls, so raise it if you are on a metered plan. `test/payments/**` shares the `runway_runtime_test`
database and the same advisory lock as the economy and runtime suites (see `docs/OPERATIONS.md`), so
it needs no extra database and cannot race them.

**Killing the API by port takes the web server with it if you are not careful.** `lsof -ti :8787`
lists *every* process holding a socket on 8787 — which includes Vite, because its `/ws` proxy keeps a
connection open. Use `lsof -ti tcp:8787 -sTCP:LISTEN` when you only mean the server.

## 7. Nobody has died yet, and that is the tuning working

`GET /api/graveyard` returns `[]` and `dead: 0` after 45 simulated days. v1's demo buried 8 of 37 in
the same window. The difference is exactly the survival tuning in §2.5: rent fell from $0.48/day to
$0.12/day and the default heartbeat went from 15 to 60 minutes, so the cheapest agent in the colony —
a $9 SPARK — has spent $3.41 in 25.2 days ($0.135/day) and is projected to live ~66 days, not ~20.

Nothing was tuned to produce corpses. The graveyard fills in during live running, where the colony
steps at its cast heartbeat (15–60 min) rather than twice a simulated day: a $9 SPARK burns about
$1.42/day at that cadence. If you want a populated graveyard at boot, raise `DEMO_DAYS` past ~70.

## 8. Known gaps

- The demo's fast-forward runs one step per agent per 12-hour tick, so the colony under-burns during
  seeding relative to its own heartbeat. Stepping each agent at its true cadence would multiply
  seeding time by 24–48×. The economics after handover are real.
- `SeriesPoint.poolUsdcMicro` keeps its v1 name although the pool is now the treasury (§3.4 lists
  `SeriesPoint` as unchanged), as does the `deposits.class` value `'pool'`.
- Everything in §12 is still out of scope: card checkout, x402, QR rendering, automatic refunds after
  fulfilment, a takedown pipeline for hosted agent sites, on-chain escrow, any secondary market.
