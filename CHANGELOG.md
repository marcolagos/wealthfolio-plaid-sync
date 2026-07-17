# Changelog

All notable changes to the plaid-sync addon are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
