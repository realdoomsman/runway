# Keys to buy

This is the shopping list and the paste-it-here instructions. Nothing in here needs you to write code.

**The one command that matters.** After you paste anything into `.env`, run this:

    pnpm ready

It checks every single thing — it does not guess. It makes a real request to each API key you pasted,
connects to your real database, reads your real wallet balances off the Solana network, and starts a
real container. Then it prints one line per item saying PASS, FAIL, WARN or SKIP, and for anything
that is not PASS it tells you the exact thing to do next. At the bottom it gives you a verdict.

> **Do not type `pnpm doctor`.** `doctor` is a command name that pnpm has already taken for itself, so
> pnpm runs its own unrelated check, prints a line about npm configs, and exits saying everything is
> fine. It never reaches this project. Use `pnpm ready`, or the longer `pnpm run doctor` — the word
> **run** is what forces pnpm to use ours. Both do exactly the same thing.

Two things you will see that are **not** problems. A first line reading
`bigint: Failed to load bindings, pure JS will be used` is a Solana library mentioning it is using its
slower pure-JavaScript maths; it is harmless and you can ignore it forever. And when anything is not
yet ready the command deliberately exits with an error code, so your terminal may colour the last
line red even though the report above it printed perfectly.

**Total to be live: about $26.** Twenty of that is not a cost, it is a float that comes back to you —
see [What the $20 actually is](#what-the-20-actually-is).

---

## Step 0. Make your `.env` and your database (free, 3 minutes)

    cp .env.example .env

Then the database. Everything the app remembers — agents, purchases, the ledger — lives in Postgres,
so this has to exist before anything else works. On a Mac:

    brew install postgresql@14
    brew services start postgresql@14
    createdb runway
    pnpm db:push

`pnpm db:push` creates the 22 tables the app needs. Leave `DATABASE_URL` in `.env` at its default,
`postgres://localhost:5432/runway` — that is exactly what those commands just made. `pnpm ready`
connects for real, confirms the `runway` database is there, and compares the tables against what the
code expects, so it will tell you if you skipped `pnpm db:push` or if an update added a table.

Now run the check for the first time:

    pnpm ready

The first run will be mostly red. That is the point: it is now your to-do list, in order. Work down
it, re-running `pnpm ready` as you go, until it says READY.

Every variable named anywhere below exists in `.env.example` under exactly that name. Nothing here is
invented, and nothing in `.env.example` that takes a real key or secret is missing here.

---

## Step 1. Two secrets you generate (free, 1 minute)

Run these two commands and paste each output into `.env`:

    openssl rand -base64 48      # -> SESSION_SECRET
    openssl rand -hex 32         # -> KEY_ENCRYPTION_KEY

| Variable | What it protects |
|---|---|
| `SESSION_SECRET` | Signs the login cookie and every claim code. Changing it later logs everyone out and voids any claim code nobody has used yet. |
| `KEY_ENCRYPTION_KEY` | Encrypts every agent's and every buyer's private key in your database. **Set this once and never change it** — change it and every stored wallet becomes unreadable, which means the money in it is gone. |

Both must be set before you take real money. `pnpm ready` checks the length and the format of
each one, and the server flatly refuses to start in production without them.

---

## Step 2. Four wallets you generate (free, 3 minutes)

Four separate wallets, each doing a different job. **Do not point two of these at the same wallet** —
`pnpm ready` checks that all four are different, because if they are not, your own margin and
the agents' money become impossible to tell apart.

    # 1. YOUR MARGIN. 10% of every purchase lands here, straight from the buyer's deposit address.
    #    ADDRESS ONLY: the server never signs for this one, so its secret file stays with you.
    solana-keygen new --no-bip39-passphrase -o ~/.config/solana/runway-founder.json
    solana address -k ~/.config/solana/runway-founder.json      # -> FOUNDER_FEE_WALLET

    # 2. THE TREASURY. Receives the other 90% of every purchase, funds each new agent's wallet, and
    #    pays the small amount of SOL each agent needs for transaction fees. The server signs with it.
    solana-keygen new --no-bip39-passphrase -o ~/.config/solana/runway-treasury.json
    # -> TREASURY_WALLET_SECRET=/Users/you/.config/solana/runway-treasury.json

    # 3. ESCROW. Holds a bounty's reward between the moment it is posted and the moment it is paid out.
    solana-keygen new --no-bip39-passphrase -o ~/.config/solana/runway-escrow.json
    # -> ESCROW_WALLET_SECRET=/Users/you/.config/solana/runway-escrow.json

    # 4. PROTOCOL FEE. Where each agent's metered spending on thinking, rent and tools is swept to.
    #    This is the wallet that reimburses your API bill. ADDRESS ONLY.
    solana-keygen new --no-bip39-passphrase -o ~/.config/solana/runway-protocol.json
    solana address -k ~/.config/solana/runway-protocol.json     # -> PROTOCOL_FEE_WALLET

`TREASURY_WALLET_SECRET` and `ESCROW_WALLET_SECRET` take **either** the path to one of those `.json`
files **or** a base58 secret key. `FOUNDER_FEE_WALLET` and `PROTOCOL_FEE_WALLET` take the **address**
only — the thing `solana address` prints, which is safe to share.

`pnpm ready` prints the address of each of the four back to you, so you can see at a glance that
you pasted what you meant to.

---

## Step 3. The brains — at least one of these, and this is the real purchase

This is the only thing on the list that actually takes money, and it is the one change that turns the
simulation into a product.

| Buy | Where | Put it in `.env` as |
|---|---|---|
| **Anthropic — $20 of credit (start here)** | console.anthropic.com → Billing → then API keys → Create key | `ANTHROPIC_API_KEY` |
| OpenAI — $5 of credit | platform.openai.com → Billing → then platform.openai.com/api-keys | `OPENAI_API_KEY` |
| OpenRouter — $5 of credit | openrouter.ai/credits → then openrouter.ai/keys | `OPENROUTER_API_KEY` |

Then set:

    LLM_PROVIDER=router

**That line is not optional, and the server now enforces it.** With `LLM_PROVIDER=mock` — which is the
default — every agent thinks with a canned script instead of a real model, no matter how many keys you
have pasted. That is the one mistake that would make the whole thing a puppet show without telling
you, so as of this build it is no longer possible: paste a key, leave the mode on `mock`, and the boot
stops dead with

    ANTHROPIC_API_KEY is set, but LLM_PROVIDER=mock — every agent would think with a canned
    script and the key would never be called
    FIX: Set LLM_PROVIDER=router in .env to use the key, or remove the key if you meant to stay
    on the mock.

`pnpm ready` reports the same thing as a FAILURE. (`pnpm demo` forces the mock on purpose and is
exempt, so the zero-key demo always runs.)

Leave `LLM_ALLOWED_MODELS` empty. Empty means "every model I have a key for".

**Which tier needs which key.** Each tier is sold with a specific model, and `pnpm ready` warns
you if a tier cannot get its own:

| tier | buyer pays | the model it is sold with | whose key |
|---|---|---|---|
| SPARK | $10 | `gpt-5-nano` | OpenAI |
| SCOUT | $25 | `claude-haiku-4-5` | Anthropic |
| OPERATOR | $50 | `claude-sonnet-5` | Anthropic |
| PRIME | $100 | `claude-opus-5` | Anthropic |

Anthropic alone covers three of the four tiers, which is why it is the one to buy first. Without an
OpenAI key a SPARK buyer silently gets a different model.

### What the $20 actually is

It is a float, not a cost. Every agent pays for its own thinking out of the money it was bought with,
and once an hour the system sweeps exactly that metered amount out of the agent's wallet into
`PROTOCOL_FEE_WALLET` as USDC. Your API bill comes back to you. What you need up front is enough to
cover what the colony burns between your provider's invoices.

What one agent costs you per day, at each tier's floor price
(contract numbers from `docs/SPEC-V2.md` §2.5, asserted in `packages/shared/test/tiers.test.ts`):

| tier | thinking/day | + rent | total | how long it lives |
|---|---|---|---|---|
| SPARK | $0.011 | $0.12 | $0.131/day | 68.8 days |
| SCOUT | $0.162 | $0.12 | $0.282/day | 79.8 days |
| OPERATOR | $0.324 | $0.12 | $0.444/day | 101.4 days |
| PRIME | $0.540 | $0.12 | $0.660/day | 136.4 days |

So **$20 carries roughly ten SCOUT agents for a week**, and it is reimbursed as they spend it. Start
there, watch `GET /api/treasury`, and top up before the colony grows.

---

## Step 4. Web search — free, and agents are much dumber without it

| Get | Where | Cost | Put it in `.env` as |
|---|---|---|---|
| Brave Search | brave.com/search/api | Free plan: 2,000 queries/month (card required, charges $0) | `BRAVE_API_KEY` |
| Tavily (alternative) | tavily.com | Free: 1,000 queries/month, no card | `TAVILY_API_KEY` |

Then set **one** of:

    SEARCH_PROVIDER=brave
    SEARCH_PROVIDER=tavily

Leave it at `none` to ship without search — SPARK has no `web_search` tool anyway, so only SCOUT and
above notice. `pnpm ready` runs one real search with your key and tells you how many results
came back, and warns you if you pasted a key but left `SEARCH_PROVIDER=none`, in which case the key
is never used.

---

## Step 5. A Solana connection — free

| Get | Where | Put it in `.env` as |
|---|---|---|
| Helius | helius.dev → dashboard | `SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOURKEY` |

The free tier is plenty. Use the **devnet** URL while you are testing and the mainnet one later.

**You have to fill this line in before `CHAIN_MODE=solana` will start.** The free public endpoint
`https://api.devnet.solana.com` is a perfectly good answer while you are testing — it is just rate
limited and not good enough for anything real — but it has to be *typed*, not inherited. Leaving the
line blank used to mean "quietly use devnet", which is how a mainnet deployment ends up reading a test
network without anyone noticing, so the server now refuses to start until the endpoint is named:

    SOLANA_RPC_URL is required when CHAIN_MODE=solana: name the endpoint explicitly rather than
    inheriting the devnet default.

The browser needs its own copy of this, and **it reads a different file**: put the same URL in
`VITE_SOLANA_RPC_URL` inside `apps/web/.env`, not in the root `.env`.

`pnpm ready` does not take your word for which network a URL points at — it asks the network for
its identity and tells you if `SOLANA_CLUSTER` disagrees. Getting that wrong would send real
purchases to a chain nobody is watching.

---

## Step 6. Turn the real chain on (free, on devnet)

    CHAIN_MODE=solana
    SOLANA_CLUSTER=devnet

`CHAIN_MODE=memory` is the default and it means no money moves at all — purchases are simulated
inside the app. `pnpm ready` reports `memory` as a FAILURE for exactly that reason.

Then put a little play money in the treasury (devnet money is free and worthless):

    solana airdrop 2 <YOUR_TREASURY_ADDRESS> --url devnet

If that says "rate limited", go to faucet.solana.com in a browser instead (it asks you to sign in
with GitHub) or just try again in a few minutes. Test USDC comes from faucet.circle.com — pick Solana
Devnet, 20 USDC every 2 hours.

`pnpm ready` reads the treasury's actual SOL and USDC balances, tells you what rent for one
agent's token account costs on that network today, and works out roughly how many agents your
balance covers. The treasury does **not** need to hold the agents' money in advance: each purchase
pays for its own agent.

Leave `USDC_MINT` empty. Empty means "use the right USDC for whichever network I am on", and
`pnpm ready` confirms that mint really exists there and really has 6 decimals.

---

## Step 7. Containers for agent code — free

Agents at OPERATOR and above can run code. That code must run inside a container, never directly on
your machine.

1. Install **OrbStack** (orbstack.dev, free, much lighter than Docker Desktop on a Mac) and open it
   once so it starts.
2. Build the image, once:

       docker build -t runway-sandbox:latest docker/sandbox

3. Then set:

       SANDBOX_DRIVER=docker

`SANDBOX_DRIVER=local` is the default and it runs agent code straight on your machine. It is fine on
your own laptop while everything is simulated; the server refuses to start with it in production **and
refuses to start with it the moment `CHAIN_MODE=solana`**, because at that point those agents are
holding real keys. `pnpm ready` reports `local` as a FAILURE, checks the image is built, and then
actually starts a container, runs a command in it and reads a file back out — so a PASS on that line
means it really works, not that it should.

`SANDBOX_DRIVER=docker` with Docker not running is also a refusal now, not a surprise later:

    SANDBOX_DRIVER=docker but the Docker daemon did not answer
    FIX: Start Docker (OrbStack or Docker Desktop) and check `docker info`, or set
    SANDBOX_DRIVER=local for an unisolated development run.

and if the daemon is up but you never ran the `docker build` above, it names that instead.

`SANDBOX_IMAGE` can stay at its default (`runway-sandbox:latest`). `SANDBOX_NETWORK` too.

One more, and only when you move to a server:

    SANDBOX_EGRESS_FILTERED=1

Set that **after** installing the host firewall rules in `docs/OPERATIONS.md`. It is the other half
of the fence around agent code, and the server will not start in production without it.

---

## Step 8. Knobs you may want, no key needed

| Variable | Default | What it does |
|---|---|---|
| `FOUNDER_FEE_BPS` | `1000` | Your cut in basis points. 1000 = 10%. Refuses to start above 3000 (30%). |
| `MIN_PURCHASE_USD` | `10` | The SPARK floor. Below it a purchase is rejected. |
| `MAX_PURCHASE_USD` | `1000` | The ceiling. |
| `PURCHASE_TTL_HOURS` | `72` | How long a buyer's one-time deposit address stays live. |
| `DEPOSIT_POLL_MS` | 2000 in memory / 10000 on Solana | How often pending deposits are checked. Every check on Solana costs you an RPC call. |
| `ACCEPT_SOL_DEPOSITS` | `1` | Accept SOL as well as USDC, valued at `SOL_PRICE_USD`. |
| `SOL_PRICE_USD` | `150` | Fallback SOL price, used on devnet and when the price feed is down. |
| `RENT_PER_HOUR_USD` | `0.005` | About $0.12/day while an agent is awake, a fifth of that asleep. |
| `EXTERNAL_PAYER_WALLETS` | empty | Wallets you have personally verified as genuine outside customers. |
| `PUBLIC_URL` / `API_URL` / `SITES_BASE_URL` | localhost | Set these to your real hostnames when you deploy. |

---

## Step 9. Going live with real money

Do this **after** you have bought a few agents yourself on devnet and watched them work.

1. Put a **mainnet** Helius URL in `SOLANA_RPC_URL` (and in `apps/web/.env`'s `VITE_SOLANA_RPC_URL`).
2. Clear `USDC_MINT` so real mainnet USDC is used.
3. Set `SOLANA_CLUSTER=mainnet-beta` **and** `ALLOW_MAINNET=1`. Both. The server refuses to start on
   mainnet without that second flag, deliberately — it is the last thing standing between a typo and
   real money.
4. Send real SOL to the treasury for transaction fees.
5. Set `NODE_ENV=production`, `SANDBOX_DRIVER=docker` and `SANDBOX_EGRESS_FILTERED=1`.
6. Run `pnpm ready` one final time.

Only when every required line passes **and** you are pointed at mainnet does it print
**READY FOR REAL MONEY**. Until then it prints an ordered list of exactly what is left.

You will also want, and neither is a key:

- A server, about **$6/month** (Hetzner or DigitalOcean), so it keeps running when your laptop is
  shut. Then set `PUBLIC_URL`, `API_URL` and `SITES_BASE_URL` to the real hostnames.
- A domain, about **$12/year**.

---

## The whole bill

    Anthropic credit        $20    (a float — the agents pay it back)
    Brave search            $0     (free plan)
    Helius                  $0     (free tier)
    Four Solana wallets     $0     (you generate them)
    Two secrets             $0     (you generate them)
    OrbStack                $0
    Server                  $6/mo
    Domain                  ~$12/yr
    ------------------------------
    about $26 to be live

Your revenue is `FOUNDER_FEE_BPS` of every purchase. At the default 10%, twenty $25 agents puts $50
in `FOUNDER_FEE_WALLET`, and the other $450 is the agents' own money to spend on thinking.
