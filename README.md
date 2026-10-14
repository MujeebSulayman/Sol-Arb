# Sol-Arb

A round-trip arbitrage bot for Solana. It cycles a base token (USDC by default) through another token and back, e.g. `USDC → SOL → USDC`, using [Jupiter](https://jup.ag)'s routing across Raydium, Orca, Meteora and other DEXs. If the round trip returns more than it started with, the bot executes both legs in **one atomic transaction**.

> ⚠️ **Read this first.** Solana arbitrage is extremely competitive. Professional searchers run co-located nodes and custom code, so expect this bot to find few or no profitable trades on major pairs. Treat it as a learning project and a base to build on. Use a dedicated wallet with only what you can afford to lose. Nothing here is financial advice.

## How it works

1. **Scan.** For each token in `TARGET_MINTS`, it quotes `BASE → X`, then quotes `X → BASE` for the amount the first leg returns.
2. **Filter.** If `out − in` is at least `MIN_PROFIT`, it's a candidate.
3. **Fuse.** The two quotes are merged into one circular Jupiter route whose minimum output is set to `in + MIN_PROFIT` with 0 slippage. The Jupiter program enforces that minimum on-chain, so **if the price moves and the trade wouldn't be profitable, the whole transaction reverts.** Your principal is never at risk from a bad fill. The worst case is losing the network fee.
4. **Simulate.** The signed transaction is simulated against the current chain state. If simulation fails, it's skipped and costs nothing.
5. **Send** (only when `DRY_RUN=false`), either through your RPC or as a Jito transaction with a tip.

## Setup

Requires Node.js 20.6+.

```bash
npm install
cp .env.example .env
# edit .env
npm run dev
```

### Modes

| Wallet set? | `DRY_RUN` | What happens |
|---|---|---|
| No | any | **Scan-only.** Logs opportunities. Safe to run with no funds. |
| Yes | `true` | Builds and **simulates** real transactions but never sends them. |
| Yes | `false` | **Live.** Sends transactions that pass simulation. |

Start in scan-only mode, then switch to dry run. Go live only after you've watched it for a while.

### Wallet requirements (for dry-run and live)

- A **new, dedicated** wallet. Export its secret key as base58 (Phantom: *Settings → Manage Accounts → Show Private Key*), or paste the JSON byte array from a Solana CLI keypair file.
- Some **SOL** for fees (0.05 SOL is plenty to start).
- A balance of the **base token** of at least `TRADE_AMOUNT`, and its token account must already exist. If you use SOL as the base, wrap it to wSOL first, because the bot doesn't wrap or unwrap SOL mid-trade.

## Configuration

All settings live in `.env`. See `.env.example` for defaults.

| Variable | Meaning |
|---|---|
| `RPC_URL` | Solana RPC. **Use a paid one** (Helius, Triton, QuickNode). The public RPC is too slow and rate-limited. |
| `JUPITER_API_URL` / `JUPITER_API_KEY` | Jupiter Swap API. The free `lite-api` endpoint is heavily rate-limited; an API key (`https://api.jup.ag/swap/v1`) raises the limits. |
| `BASE_MINT` | Token you start and end with. |
| `TRADE_AMOUNT` | Size per attempt, in the base token's smallest unit (USDC: 1 USDC = `1000000`). |
| `TARGET_MINTS` | Comma-separated tokens to cycle through. |
| `MIN_PROFIT` | Minimum profit in base units, enforced on-chain. When the base isn't SOL, set this high enough to cover fees. |
| `MAX_ACCOUNTS_PER_LEG` | Limits route complexity so both legs fit into one transaction (max 1232 bytes). Lower it if you see "transaction too large". |
| `PRIORITY_FEE_MICROLAMPORTS`, `COMPUTE_UNIT_LIMIT` | Priority fee settings. Cost per attempt = 5000 + price × limit ÷ 1,000,000 lamports. |
| `USE_JITO`, `JITO_TIP_LAMPORTS` | Send via Jito with a tip. The tip is only paid if the transaction lands. |
| `SCAN_INTERVAL_MS` | Pause between scan rounds. |
| `DRY_RUN` | `true` = simulate only. |

Set `DEBUG=1` to log every quote, including unprofitable ones and failed simulation logs.

## Project layout

```
src/
  config.ts    env parsing and validation
  jupiter.ts   quote + swap-instructions API, circular-route fusion
  executor.ts  transaction building, simulation, sending (RPC or Jito)
  index.ts     scan loop
```

## Ideas for improving your edge

- **Less contested pairs.** Major pairs are swept by pros within milliseconds. Newer or long-tail tokens and pools sometimes have gaps that last longer.
- **Self-hosted Jupiter.** Jupiter's self-hosted routing engine gives quotes in milliseconds with no rate limits.
- **Event-driven scanning.** Subscribe to pool account changes via Geyser/gRPC (e.g. Yellowstone) instead of polling, and quote only when a pool moves.
- **Parallel quotes and size search.** Quote several sizes at once and pick the most profitable one.
- **Read pools directly.** Calculating prices from on-chain pool state, instead of calling an API, is how serious bots stay fast.

## Caveats

- Jupiter has marked its Metis v1 Swap API (`/swap/v1`) as no longer actively maintained in favour of Swap V2. It still serves this bot's needs, but if Jupiter stops accepting circular routes there, `src/jupiter.ts` is the file to update.
- Tokens with transfer fees (Token-2022) can make quotes misleading. Stick to well-known mints.
- Watch for scams: never paste your private key into any bot, website or "arbitrage tool" you haven't read the code of. That includes this one. Read it first.
