# Changelog

All notable changes to this addon are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] - 2026-07-18

### Fixed

- **Large investment accounts could stall on the first sync.** A 150-row
  import chunk of cold brokerage symbols can exceed the server's 30s
  market-data-resolution timeout on a small/slow instance (e.g. Render
  Starter), erroring the whole account with "Request Timeout" and importing
  nothing. Chunk size reduced to 50, and checkImport/import/saveMany now
  retry on timeout (a timed-out attempt still warms the server's quote cache,
  so the retry completes). Fast instances are unaffected.

## [0.3.1] - 2026-07-18

### Fixed

- **FDIC-insured deposit sweeps** (Fidelity core-account cash parked in a
  partner-bank deposit; pseudo-symbols `FDIC#####`, "CORE ACCOUNT FDIC
  INSURED DEPOSIT") are now recognized as cash churn and skipped, like
  money-market sweeps (SPAXX/FDRXX). Previously their unresolvable
  pseudo-tickers were rejected as errors. Verified safe against live Fidelity
  data: real CASH CONTRIBUTION / INTEREST / DIVIDEND rows are separate and
  still import; the paired core-account buy/sell carries no economic signal.
- **Unresolvable-but-real symbols** (institutional 401k funds like `PBHK`,
  delisted tickers) are no longer dropped. When the host rejects a symbol
  only because it isn't in market data, the row is retried as a
  **manual-quote asset** — imported at the broker-provided price so the
  position and history appear; it just won't get live price updates (no
  public data exists for these). Surfaced in the sync log as "N imported as
  manual-priced". Applies to both SnapTrade and Plaid investment rows.

## [0.3.0] - 2026-07-18

### Changed

- **BREAKING — addon id renamed `plaid-sync` → `account-sync`.** This is a
  fresh identity: the route is now `/addons/account-sync`, and the addon's
  secret/storage namespace changes, so an existing install is not upgraded in
  place — remove the old addon (and its connections/accounts) and install
  this as new. Shared storage keys dropped their `plaid-` prefix
  (`account-map`, `sync-state`, `sync-log`, `auto-sync-hours`);
  provider-scoped keys (`plaid-*`, `snaptrade-*` credentials/items) are
  unchanged. The Plaid `client_user_id` is now `wealthfolio-account-sync`.
  No data-model change — done purely so nothing internal still reads
  "plaid-sync" now that the addon spans both providers.

## [0.2.0] - 2026-07-18

### Added

- **SnapTrade provider**: brokerage connections (Robinhood, Fidelity,
  E\*Trade, Schwab, …) with broker-complete history — no 24-month cap.
  Personal-API-key auth with per-request HMAC-SHA256 signing computed in the
  addon; Connection Portal link for connecting brokerages; per-account
  incremental checkpoints with overlap dedup (`[snaptrade:<id>]` markers);
  positions-derived baselines with a cash anchor for cash-equivalent
  holdings; money-market sweep trades (SPAXX-style) skipped as cash churn.
- SnapTrade accounts appear in the same mapping table (institution-prefixed
  names) and sync log as Plaid accounts.

### Changed

- Addon renamed **Plaid Sync → Account Sync** (id unchanged — existing
  credentials, connections, and mappings carry over).

## [0.1.1] - 2026-07-16

### Added

- Configurable history depth (1–730 days, default 730): applied to new
  institution connections via `transactions.days_requested`. Previously
  connections got Plaid's 90-day default.
- "Extend history" per connected institution: update-mode Hosted Link that
  asks Plaid to backfill up to the configured depth for an existing
  connection — no relinking, stable transaction IDs, dedup absorbs overlap.

### Fixed

- Credit-card payments and refunds never imported: inflows mapped to
  DEPOSIT, which Wealthfolio rejects on CREDIT_CARD accounts (silently
  dropped in v0.1.0), and institutions that report payments with the same
  positive sign as purchases (the Plaid sandbox does) got WITHDRAWAL.
  Payments are now recognized via Plaid's `LOAN_PAYMENTS` category (with a
  name-pattern fallback) and all card inflows import as CREDIT, so card
  balances compute correctly.
- One institution's failure (e.g. `PRODUCTS_NOT_SUPPORTED` on investments) no
  longer aborts the rest of the sync run or drops cursor/checkpoint state;
  it is recorded per account with the institution named.
- Rows rejected by import validation (e.g. symbols market data cannot
  resolve) were silently dropped; they now show in the sync log as skipped,
  with a count and an example of why.

## [0.1.0] - 2026-07-16

### Added

- Initial release: banking sync via `/transactions/sync` cursors with
  opening-balance anchors; investment sync via
  `/investments/transactions/get` (BUY/SELL/DIVIDEND/FEE/TRANSFER with real
  asset creation) plus holdings-derived baselines for positions older than
  Plaid's history window; idempotent re-syncs via `[plaid:<id>]` comment
  markers; sandbox quick-connect and production Hosted Link flows; account
  mapping UI; auto-sync on launch; encrypted credential storage.
