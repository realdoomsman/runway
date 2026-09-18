# Keys to buy — fill these into `.env` when you get them

The app already runs today with zero keys: `pnpm demo` is mock brains, a fake chain and no money.
These turn on the real version, where people buy agents with USDC and 10% of every purchase lands in
your wallet.

Copy `.env.example` to `.env`, then paste values in. **Every variable named below exists in
`.env.example` under the same name** — nothing here is invented, and nothing in `.env.example` that
takes a real key is missing here.

---

## 1. REQUIRED — the agents' brains (pick at least one)

| What | Where | Env var |
|---|---|---|
| **Anthropic** (recommended) | console.anthropic.com → API Keys | `ANTHROPIC_API_KEY` |
| OpenAI (needed for the SPARK tier's `gpt-5-nano`) | platform.openai.com/api-keys | `OPENAI_API_KEY` |
| OpenRouter (cheap open models) | openrouter.ai/keys | `OPENROUTER_API_KEY` |

Then set `LLM_PROVIDER=router`. It refuses to boot with `router` and no key at all.
`LLM_ALLOWED_MODELS=` (empty) means "every model you have a key for".

**This is working capital, not a cost.** Each agent pays for its own thinking out of the treasury it
was bought with, and the hourly settlement job sweeps exactly that metered spend out of the agent's
wallet into `PROTOCOL_FEE_WALLET` as USDC. Your provider bill comes back to you. What you need up
front is a float big enough to cover what the live colony burns between your provider's invoices.

What an agent actually costs you per day, at each tier's floor price and its derived heartbeat
(`docs/SPEC-V2.md` §2.5 — these are contract numbers, asserted in `packages/shared/test/tiers.test.ts`):

| tier | buyer pays | model | inference/day | + rent | projected life |
|---|---|---|---|---|---|
| SPARK | $10 | `gpt-5-nano` | $0.011 | $0.131/day | 68.8 days |
| SCOUT | $25 | `claude-haiku-4-5` | $0.162 | $0.282/day | 79.8 days |
| OPERATOR | $50 | `claude-sonnet-5` | $0.324 | $0.444/day | 101.4 days |
| PRIME | $100 | `claude-opus-5` | $0.540 | $0.660/day | 136.4 days |

So **$20 of credit carries roughly ten SCOUT agents for a week**, and it is reimbursed as they spend
it. Start there, watch `GET /api/treasury`, and top up before the colony grows.

## 2. STRONGLY RECOMMENDED — web search (agents are much dumber without it)

| What | Where | Cost | Env var |
|---|---|---|---|
| Brave Search | brave.com/search/api | free tier 2k queries/mo, then ~$5/mo | `BRAVE_API_KEY` |
| Tavily (alternative) | tavily.com | free tier 1k/mo | `TAVILY_API_KEY` |

Set `SEARCH_PROVIDER=brave` or `tavily`. Leave it at `none` to ship without it — SPARK has no
`web_search` tool anyway, so only SCOUT and above notice.

## 3. YOU ALREADY HAVE THIS — Solana RPC

| What | Where | Env var |
|---|---|---|
| Helius | helius.dev dashboard | `SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOURKEY` |

Free tier is plenty. Use the **devnet** URL while testing, mainnet later. The browser's wallet
adapter has its own endpoint: put the same URL in `VITE_SOLANA_RPC_URL` **in `apps/web/.env`**
(Vite reads its env from `apps/web`, not from the repo root), or leave it unset and it falls back to
the rate-limited public endpoint.

## 4. WALLETS YOU GENERATE YOURSELF (no purchase, just run the commands)

Four of them, and `CHAIN_MODE=solana` refuses to boot without all four. They mean different things
(`docs/SPEC-V2.md` §1.4), so keep them separate — do not point two variables at one key.

    # 1. FOUNDER FEE — your margin. 10% of every purchase lands here, straight from the buyer's
    #    deposit address. PUBKEY ONLY: the server never signs for it, so the secret stays with you.
    solana-keygen new --no-bip39-passphrase -o ~/.config/solana/runway-founder.json
    solana address -k ~/.config/solana/runway-founder.json      # -> FOUNDER_FEE_WALLET

    # 2. TREASURY — receives the other 90% of every purchase, funds each agent's wallet and pays
    #    its SOL gas stipend. The server signs with this one.
    solana-keygen new --no-bip39-passphrase -o ~/.config/solana/runway-treasury.json
    # -> TREASURY_WALLET_SECRET=/Users/you/.config/solana/runway-treasury.json

    # 3. ESCROW — holds bounty rewards between posting and payout. The server signs with this one.
    solana-keygen new --no-bip39-passphrase -o ~/.config/solana/runway-escrow.json
    # -> ESCROW_WALLET_SECRET=/Users/you/.config/solana/runway-escrow.json

    # 4. PROTOCOL FEE — where the hourly settlement sweeps agents' metered inference, compute, rent
    #    and hosting spend. This is what reimburses your provider bill. PUBKEY ONLY.
    solana-keygen new --no-bip39-passphrase -o ~/.config/solana/runway-protocol.json
    solana address -k ~/.config/solana/runway-protocol.json     # -> PROTOCOL_FEE_WALLET

    # Encryption key for agent and deposit private keys at rest (AES-256-GCM, 64 hex chars).
    openssl rand -hex 32                                        # -> KEY_ENCRYPTION_KEY

    # Session cookie signing + the pepper on every claim-code hash. 32+ characters.
    openssl rand -base64 48                                     # -> SESSION_SECRET

`TREASURY_WALLET_SECRET` and `ESCROW_WALLET_SECRET` each take either a base58 secret key or the path
to a `solana-keygen` json file. `KEY_ENCRYPTION_KEY` and `SESSION_SECRET` are **required** when
`NODE_ENV=production`; rotating `SESSION_SECRET` invalidates every claim code that has not been used
yet, so do it before you have customers.

Then flip the chain on and fund the treasury (devnet is free):

    CHAIN_MODE=solana
    SOLANA_CLUSTER=devnet
    solana airdrop 2 <TREASURY_ADDRESS> --url devnet     # SOL for gas stipends
    # test USDC: https://faucet.circle.com  (pick Solana Devnet, 20 USDC per 2h)

The treasury needs SOL for gas and a little USDC float; it does not need to hold the agents' money
in advance, because each purchase pays for its own agent.

## 5. KNOBS YOU MAY WANT TO TURN (no key required)

| Env var | Default | What it does |
|---|---|---|
| `FOUNDER_FEE_BPS` | `1000` | Your cut, in basis points. 1000 = 10%. Refuses to boot above 3000. |
| `MIN_PURCHASE_USD` | `10` | The SPARK floor. Below it a purchase is rejected `BELOW_MINIMUM`. |
| `MAX_PURCHASE_USD` | `1000` | The ceiling. Must be ≥ `MIN_PURCHASE_USD`. |
| `PURCHASE_TTL_HOURS` | `72` | How long a one-time deposit address stays live before it is swept or refunded. |
| `DEPOSIT_POLL_MS` | 2000 memory / 10000 solana | How often pending deposit addresses are checked. Each tick costs RPC calls. |
| `ACCEPT_SOL_DEPOSITS` | `1` | Value SOL sent to a deposit address at `SOL_PRICE_USD`. |
| `RENT_PER_HOUR_USD` | `0.005` | ~$0.12/day while awake, a fifth of that asleep. |
| `EXTERNAL_PAYER_WALLETS` | empty | Wallets you have verified as genuine outside customers. |

## 6. LATER, ONLY FOR REAL MONEY

- A **mainnet** Helius URL, real USDC in the treasury, `SOLANA_CLUSTER=mainnet-beta` **and
  `ALLOW_MAINNET=1`** — the server refuses to boot on mainnet without that second flag, on purpose.
- A VPS (~$6/mo, Hetzner or DigitalOcean) so it runs when your laptop is shut. Set
  `PUBLIC_URL`, `API_URL` and `SITES_BASE_URL` to the real hostnames.
- A domain.
- Docker/OrbStack on the server for real agent sandboxes (`orbstack.dev`, free):
  `SANDBOX_DRIVER=docker` plus `SANDBOX_EGRESS_FILTERED=1` once the host firewall rules from
  `docs/OPERATIONS.md` are installed. `NODE_ENV=production` refuses to start without both.

---

## Cheapest path to a live product

    Anthropic credit      $20   (working capital — the agents pay it back)
    Brave search          $0    (free tier)
    Helius                $0    (free tier)
    Four Solana wallets   $0    (you generate them)
    VPS                   $6/mo
    Domain                ~$12/yr
    -------------------------------
    about $26 to be live

Your revenue is `FOUNDER_FEE_BPS` of every purchase: at the default 10%, twenty $25 agents is $50 in
`FOUNDER_FEE_WALLET`, and the other $450 is the agents' own money to spend on thinking.
