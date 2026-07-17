# Account Sync

Wealthfolio addon that auto-syncs bank, credit, and brokerage accounts from
two providers, each doing what it's best at:

- **[Plaid](https://plaid.com/)** — banks and credit cards (free Trial plan:
  10 institutions, Transactions + Investments).
- **[SnapTrade](https://snaptrade.com/)** — brokerages (Robinhood, Fidelity,
  E\*Trade, Schwab, …) with broker-complete history, read-only (free tier:
  5 connections).

## How it works

- **Bank / credit accounts (Plaid)** sync as activities via
  `/transactions/sync` cursors. Depository accounts get an opening-balance
  anchor on first sync; credit-card payments and refunds import as CREDIT.
  History depth is configurable up to Plaid's 730-day cap.
- **Brokerages (SnapTrade)** sync as real investment activities
  (BUY/SELL/DIVIDEND/reinvestments/transfers with quantity, price, and fees)
  from the broker's full available history — no 24-month cap. Positions
  predating the history come in as baseline TRANSFER_INs; money-market sweep
  churn (SPAXX-style) is skipped. Plaid investment accounts work too, when
  the institution supports them.
- **Dedup**: every activity carries its provider transaction id in the
  comment (`[plaid:<id>]` / `[snaptrade:<id>]`), folded into Wealthfolio's
  content-hash idempotency; re-syncs never double-import. Symbol rows go
  through the asset-creating import path so tickers resolve to real
  market-data assets.
- **Auto-sync** runs at app launch when the last run is older than the
  configured interval (default daily, or manual-only).

## Setup

1. **Plaid** (banks/cards): create a team at dashboard.plaid.com, paste
   `client_id` + environment secret, connect institutions via Hosted Link.
2. **SnapTrade** (brokerages): create an account at dashboard.snaptrade.com,
   paste the `client_id` (PERS-…) + consumer key. Connect brokerages via the
   "Connect a brokerage" portal link — or directly in SnapTrade's own
   dashboard; connections made there appear here automatically.
3. Map each discovered account (create new / link existing / ignore) and
   press **Sync now**.

All credentials live in Wealthfolio's encrypted secret store; SnapTrade
requests are HMAC-signed in the addon and neither key ever leaves the
server-side network broker.

## Development

```bash
pnpm install
pnpm dev:server   # hot-reload server; enable addon dev mode in Wealthfolio
pnpm bundle       # build + package ZIP for installation
```

Releases: push a `v*` tag and CI attaches the installable ZIP to a GitHub
Release.

E2E coverage (in a [wealthfolio](https://github.com/afadil/wealthfolio)
checkout, against a running web-mode app):

- `e2e/98-plaid-addon.spec.ts` — full Plaid Sandbox flow.
- `e2e/99-snaptrade-sync.spec.ts` — live SnapTrade flow; requires
  `SNAPTRADE_CLIENT_ID` / `SNAPTRADE_CONSUMER_KEY` env vars.
