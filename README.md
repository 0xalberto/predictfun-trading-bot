<p align="center">
  <img src="image.png" alt="predict.fun Arbitrage Bot — Spotting price gaps. Trading the edge." width="100%">
</p>

<h1 align="center">predict.fun Arbitrage Bot</h1>
<p align="center"><strong>BTC 5M &amp; 15M MARKETS</strong></p>
<p align="center"><em>Spotting price gaps. Trading the edge.</em></p>
<p align="center"><strong>BIGGER MOVES. SMARTER TRADES.</strong></p>

<p align="center">
  <a href="https://t.me/soladity">Telegram</a>
  ·
  <a href="https://predict.fun">predict.fun</a>
</p>

---

## Story

Markets move in seconds. Human traders blink.

This bot was built as a tireless companion for that chaos — a small machine that never sleeps, never second-guesses, and never misses a window. While BTC 5-minute and 15-minute prediction markets open, reprice, and expire, it sits on the book.

When YES and NO drift apart from that pressure, it trades the edge. When both sides of a market are sitting in the wallet, it merges them back into USDT so capital stays in play for the next candle.

No staring at charts. No missed rolls. Just a robot on the rocks, scanning the tape 24/7.

---

## Features

| | |
| --- | --- |
| **Real-Time Scanning** | Find inefficiencies across BTC 5m & 15m markets |
| **Smart Execution** | Fast & reliable trades with pre-signed order pools |
| **Automated 24/7** | No manual work, no missed opportunities |
| **Built for Profit** | Turn market gaps into consistent gains |

Under the hood:

- Live predict.fun order books over WebSocket
- Binance BTCUSDT depth as an order-book imbalance (OBI) signal
- Legacy (`±80 / ±30`) and predictive (momentum-ahead) OBI modes
- Paper trading with persisted PnL
- Live trading on BNB via the [predict.fun SDK](https://www.npmjs.com/package/@predictdotfun/sdk)
- Automatic YES + NO merge back to USDT

---

## How it works

1. **Resolve the active market** — every 5 minutes a new `btc-updown-5m-*` category opens on predict.fun.
2. **Read two books** — predict.fun YES/NO prices, plus Binance top-of-book imbalance.
4. **Execute** — live mode consumes pre-signed limit buys so the hot path is a POST, not a wallet sign.
5. **Recycle capital** — merge leftover YES and NO shares into USDT on a timer.

---

## Requirements

- [Bun](https://bun.sh/) **1.4+**
- A [predict.fun](https://predict.fun) account and API key
- A funded wallet on **BNB Chain** (USDT)
- Optional: a Predict smart-wallet deposit address if you trade through an account wallet

---

## Setup

```bash
git clone <your-repo-url>
cd "predictfun-trading-bot"

bun install
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | What it is |
| --- | --- | --- |
| `PREDICT_API_KEY` | yes | API key from predict.fun (`pred_sk_...`) |
| `WALLET_PRIVATE_KEY` | live / merge / order | EOA key, or the Privy key exported from account settings |
| `PREDICT_ACCOUNT_ADDRESS` | if using a smart wallet | Predict deposit / account address |
| `RPC_URL` | no | BNB RPC (defaults to Binance public seed) |
| `PREDICT_API_URL` | no | `https://api.predict.fun` |
| `PREDICT_WS_URL` | no | `wss://ws.predict.fun/ws` |
| `ORDER_SHARES` | no | Size per order (default `5`) |
| `PRESIGN_PER_BUCKET` | no | Pre-signed BUY orders per side/size when a 5m market starts (default `100`) |
| `PAPER_PNL_PATH` | no | Paper PnL JSON path (default `paper-pnl.json`) |
| `ORDER_POST_LATENCY_MS` | no | Simulated fill delay in paper mode (default `300`) |
| `MERGE_INTERVAL_MS` | no | Merge poll interval (default `60000`) |
| `MERGE_MIN_WEI` | no | Minimum mergeable shares (default `0.01`) |

Keep `.env` private. Never commit keys.

---

## Execution guide

Run commands from the project root. Stop any process with `Ctrl+C`.

### 1. Watch the books (no orders)

Stream the current BTC 5m market against Binance OBI. Use this first to confirm API keys, websockets, and market rolls.

```bash
bun start
```

Hot-reload while developing:

```bash
bun run dev
```

### 2. Paper trade

Same signals as live, but fills are simulated (with optional post latency). PnL is written to `paper-pnl.json`.

```bash
bun run paper
```

Newer paper runner:

```bash
bun run paper:new
```

Let it ride through a few 5-minute windows and inspect the PnL file before going live.

### 3. Test a real order

Places a single YES limit buy on the current BTC 5m market (`ORDER_SHARES` at price `0.80`). Runs on-chain trade approvals if needed. Use this to verify wallet, USDT balance, and API auth.

```bash
bun run order
```

### 4. Go live

Live OBI strategy: pre-signs YES/NO buckets when each 5m market opens, then enters / exits / flips from Binance imbalance.

```bash
bun run live
```

Before you start:

- Wallet (or Predict account) has enough **USDT on BNB**
- `WALLET_PRIVATE_KEY` is set
- `PREDICT_ACCOUNT_ADDRESS` is set if you deposit to a smart wallet
- You have already run `bun run order` successfully once

Live orders use a high limit price (`0.99`) so they take liquidity quickly. Position size is `ORDER_SHARES`; flips use `2 × ORDER_SHARES`.

### 5. Merge YES + NO → USDT

If you hold both outcomes on the active 5m market, the pair can be merged back into USDT. The merger polls on an interval and skips dust below `MERGE_MIN_WEI`.

```bash
bun run merge
```

Typical setup: run **live** in one terminal and **merge** in another so inventory does not sit idle across windows.

### 6. Tests & backtest

```bash
bun test
bun run backtest:obi
```

---

## Suggested run order

```text
bun install
→ fill .env
→ bun start          # books look healthy?
→ bun run paper      # signals + simulated PnL
→ bun run order      # one real fill / approval
→ bun run live       # strategy
→ bun run merge      # recycle YES+NO
```

---

## Strategy notes

**Predictive**: estimates imbalance a few hundred milliseconds ahead (velocity, persistence, optional microprice confirmation) so entries can fire.


---

## Disclaimer

This software trades real markets with real funds. Crypto and prediction markets are volatile. You can lose money. Nothing here is financial advice. Run paper mode first, size small, and use a dedicated wallet.

---

## Contact

Questions, custom builds, or collabs — reach out on Telegram:

**[t.me/soladity](https://t.me/soladity)**
