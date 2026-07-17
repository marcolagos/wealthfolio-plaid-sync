import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { linkProvider, loadMapping, type SyncKind } from "../lib/mapping";
import { PlaidClient, type PlaidItemRef } from "../plaid/client";
import type {
  PlaidAccount,
  PlaidInvestmentTransaction,
  PlaidSecurity,
  PlaidTransaction,
} from "../plaid/types";
import { SnapTradeClient } from "../snaptrade/client";
import type { SnapTradeAccount } from "../snaptrade/types";
import { buildBankingAnchor, mapBankingTransactions } from "./map-banking";
import {
  buildInvestmentBaseline,
  mapInvestmentTransactions,
} from "./map-investments";
import {
  buildSnapTradeBaseline,
  mapSnapTradeActivities,
} from "./map-snaptrade";

const STATE_KEY = "plaid-sync-state";
const LOG_KEY = "plaid-sync-log";
const LOG_LIMIT = 20;

/** Plaid investments history reaches back at most ~24 months. */
const INITIAL_LOOKBACK_DAYS = 730;
/** Overlap window re-fetched on incremental investment syncs; dedup absorbs it. */
const OVERLAP_DAYS = 7;

interface SyncState {
  /** transactions/sync cursor per item. */
  cursors: Record<string, string>;
  /** Last synced end-date (YYYY-MM-DD) per item for investments. */
  invCheckpoints: Record<string, string>;
  /** Last synced end-date (YYYY-MM-DD) per SnapTrade account. */
  snapCheckpoints: Record<string, string>;
  /** Provider account ids whose opening baseline/anchor has been imported. */
  baselined: string[];
}

export interface AccountSyncOutcome {
  plaidAccountId: string;
  name: string;
  kind: SyncKind;
  imported: number;
  duplicates: number;
  skippedRows: number;
  /** Informational detail (e.g. why rows were skipped) — not a failure. */
  note?: string;
  error?: string;
}

export interface SyncRunResult {
  at: string;
  outcomes: AccountSyncOutcome[];
  error?: string;
}

async function loadState(ctx: AddonContext): Promise<SyncState> {
  const raw = await ctx.api.storage.get(STATE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SyncState>;
      return {
        cursors: parsed.cursors ?? {},
        invCheckpoints: parsed.invCheckpoints ?? {},
        snapCheckpoints: parsed.snapCheckpoints ?? {},
        baselined: Array.isArray(parsed.baselined) ? parsed.baselined : [],
      };
    } catch {
      // corrupted state → full re-sync; dedup makes that safe
    }
  }
  return {
    cursors: {},
    invCheckpoints: {},
    snapCheckpoints: {},
    baselined: [],
  };
}

export async function loadSyncLog(ctx: AddonContext): Promise<SyncRunResult[]> {
  const raw = await ctx.api.storage.get(LOG_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as SyncRunResult[];
  } catch {
    return [];
  }
}

async function appendSyncLog(
  ctx: AddonContext,
  entry: SyncRunResult,
): Promise<void> {
  const log = await loadSyncLog(ctx);
  await ctx.api.storage.set(
    LOG_KEY,
    JSON.stringify([entry, ...log].slice(0, LOG_LIMIT)),
  );
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

/**
 * Import rows with dedup in chunks: a single check/import of a full backfill
 * (~1000 rows with cold symbol resolution) exceeds the app server's 30s
 * request timeout. Chunks keep each request fast, and the server caches
 * resolved symbols/assets so later chunks speed up. Chunks run oldest-first,
 * so DB-side duplicate checks cover earlier chunks of the same run.
 */
const IMPORT_CHUNK_SIZE = 150;

/**
 * Symbol-bearing rows (BUY/SELL/DIVIDEND/TRANSFER of a security) must go
 * through `saveMany` — only that path runs the ensure-assets step that
 * creates and links asset records. `import()` inserts rows as-is (its asset
 * step belongs to the CSV UI's review flow), which would leave BUYs with no
 * asset and break holdings calculation. Cash rows stay on `import()`, which
 * gives the cheap bulk dedup summary.
 */
async function importRows(
  ctx: AddonContext,
  rows: ActivityImport[],
): Promise<{
  imported: number;
  duplicates: number;
  invalid: number;
  invalidExample?: string;
}> {
  let imported = 0;
  let duplicates = 0;
  let invalid = 0;
  let invalidExample: string | undefined;
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + IMPORT_CHUNK_SIZE);
    const checked = await ctx.api.activities.checkImport(chunk);
    duplicates += checked.filter((r) => r.duplicateOfId).length;
    // Rows the check marks invalid would otherwise vanish silently — count
    // them and keep one example so the sync log shows what was rejected.
    const invalidRows = checked.filter((r) => !r.isValid && !r.duplicateOfId);
    if (invalidRows.length > 0) {
      invalid += invalidRows.length;
      if (!invalidExample) {
        const first = invalidRows[0];
        const detail = first.errors
          ? Object.entries(first.errors)
              .map(([field, msgs]) => `${field}: ${msgs.join("; ")}`)
              .join(", ")
          : "no error detail";
        invalidExample = `"${first.comment ?? first.activityType}" → ${detail}`;
      }
    }
    const importable = checked.filter((r) => r.isValid && !r.duplicateOfId);
    if (importable.length === 0) continue;

    const cashRows = importable.filter((r) => !(r.symbol ?? "").trim());
    const assetRows = importable.filter((r) => (r.symbol ?? "").trim());

    if (cashRows.length > 0) {
      const result = await ctx.api.activities.import(cashRows);
      if (!result.summary.success) {
        throw new Error(
          "Import finished with errors — check the import history",
        );
      }
      imported += result.summary.imported;
      duplicates += result.summary.duplicates;
    }

    if (assetRows.length > 0) {
      const creates = assetRows.map((r) => ({
        accountId: r.accountId,
        activityType: r.activityType,
        activityDate:
          typeof r.date === "string"
            ? r.date
            : (r.date?.toISOString().slice(0, 10) ?? ""),
        asset: {
          symbol: (r.symbol ?? "").trim(),
          exchangeMic: r.exchangeMic,
          quoteCcy: r.quoteCcy,
          instrumentType: r.instrumentType,
          providerId: r.providerId,
          providerSymbol: r.providerSymbol,
          name: r.symbolName,
        },
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        amount: r.amount,
        currency: r.currency,
        fee: r.fee,
        comment: r.comment,
      }));
      // saveMany is transactional: one DB-level duplicate rejects the whole
      // batch. checkImport can miss a few (its review-step key differs subtly
      // from the stored create-step key), so on a duplicate failure fall back
      // to row-by-row saves — this only happens on small incremental overlaps.
      try {
        const result = await ctx.api.activities.saveMany({ creates });
        imported += result.created.length;
        duplicates += result.errors.filter((e) =>
          /duplicate/i.test(e.message),
        ).length;
        const realErrors = result.errors.filter(
          (e) => !/duplicate/i.test(e.message),
        );
        if (realErrors.length > 0) {
          throw new Error(
            `${realErrors.length} activities failed to save (e.g. ${realErrors[0].message})`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate/i.test(message)) throw error;
        for (const create of creates) {
          try {
            const single = await ctx.api.activities.saveMany({
              creates: [create],
            });
            imported += single.created.length;
            duplicates += single.errors.filter((e) =>
              /duplicate/i.test(e.message),
            ).length;
          } catch (rowError) {
            const rowMessage =
              rowError instanceof Error ? rowError.message : String(rowError);
            if (!/duplicate/i.test(rowMessage)) throw rowError;
            duplicates += 1;
          }
        }
      }
    }
  }
  return { imported, duplicates, invalid, invalidExample };
}

async function syncItemBanking(
  ctx: AddonContext,
  client: PlaidClient,
  item: PlaidItemRef,
  mapped: { plaidAccountId: string; wfAccountId: string }[],
  plaidAccounts: Map<string, PlaidAccount>,
  state: SyncState,
  outcomes: AccountSyncOutcome[],
): Promise<void> {
  // A newly mapped account needs history the current cursor already consumed:
  // restart from scratch and let dedup absorb the overlap.
  const hasNewAccount = mapped.some(
    (m) => !state.baselined.includes(m.plaidAccountId),
  );
  let cursor = hasNewAccount ? undefined : state.cursors[item.itemId];

  const added: PlaidTransaction[] = [];
  for (;;) {
    const page = await client.transactionsSync(item.itemId, cursor);
    added.push(...page.added);
    cursor = page.next_cursor;
    if (!page.has_more) break;
  }

  let allOk = true;
  for (const m of mapped) {
    const account = plaidAccounts.get(m.plaidAccountId);
    const outcome: AccountSyncOutcome = {
      plaidAccountId: m.plaidAccountId,
      name: account?.name ?? m.plaidAccountId,
      kind: "BANKING",
      imported: 0,
      duplicates: 0,
      skippedRows: 0,
    };
    try {
      const accountTxns = added.filter(
        (t) => t.account_id === m.plaidAccountId,
      );
      const currency = account?.balances.iso_currency_code ?? "USD";
      const rows = mapBankingTransactions(
        accountTxns,
        m.wfAccountId,
        currency,
        account?.type,
      );
      if (!state.baselined.includes(m.plaidAccountId) && account) {
        const anchor = buildBankingAnchor(account, accountTxns, m.wfAccountId);
        if (anchor) rows.unshift(anchor);
      }
      const { imported, duplicates, invalid, invalidExample } =
        await importRows(ctx, rows);
      outcome.imported = imported;
      outcome.duplicates = duplicates;
      if (invalid > 0) {
        // Rows the host's import validation rejects (e.g. a symbol market
        // data can't resolve) are permanent — retrying can't fix them, so
        // don't fail the account or hold the cursor. Count them as skipped
        // and explain in the log.
        outcome.skippedRows += invalid;
        outcome.note = `${invalid} row(s) rejected by import validation — e.g. ${invalidExample}`;
      }
      if (!state.baselined.includes(m.plaidAccountId))
        state.baselined.push(m.plaidAccountId);
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
      allOk = false;
    }
    outcomes.push(outcome);
  }

  // Only advance the cursor when every account imported cleanly; otherwise the
  // next run re-fetches this batch and dedup drops what already landed.
  if (allOk && cursor) {
    state.cursors[item.itemId] = cursor;
  }
}

async function syncItemInvestments(
  ctx: AddonContext,
  client: PlaidClient,
  item: PlaidItemRef,
  mapped: { plaidAccountId: string; wfAccountId: string }[],
  plaidAccounts: Map<string, PlaidAccount>,
  state: SyncState,
  outcomes: AccountSyncOutcome[],
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const checkpoint = state.invCheckpoints[item.itemId];
  const hasNewAccount = mapped.some(
    (m) => !state.baselined.includes(m.plaidAccountId),
  );
  const startDate =
    checkpoint && !hasNewAccount
      ? new Date(
          new Date(`${checkpoint}T00:00:00Z`).getTime() -
            OVERLAP_DAYS * 86400_000,
        )
          .toISOString()
          .slice(0, 10)
      : isoDaysAgo(INITIAL_LOOKBACK_DAYS);

  // Fetch in ~90-day windows: keeps each request fast enough for the network
  // broker's 10s timeout (Plaid generates sandbox history lazily and large
  // date ranges are slow) and each response well under the 2 MB cap.
  const WINDOW_MS = 90 * 86400_000;
  const transactions: PlaidInvestmentTransaction[] = [];
  const securities = new Map<string, PlaidSecurity>();
  const endMs = new Date(`${today}T00:00:00Z`).getTime();
  for (
    let windowStart = new Date(`${startDate}T00:00:00Z`).getTime();
    windowStart <= endMs;
    windowStart += WINDOW_MS
  ) {
    const windowEnd = Math.min(windowStart + WINDOW_MS - 86400_000, endMs);
    const from = new Date(windowStart).toISOString().slice(0, 10);
    const to = new Date(windowEnd).toISOString().slice(0, 10);
    let offset = 0;
    for (;;) {
      const page = await client.investmentsTransactions(
        item.itemId,
        from,
        to,
        offset,
      );
      transactions.push(...page.investment_transactions);
      for (const s of page.securities) securities.set(s.security_id, s);
      offset += page.investment_transactions.length;
      if (
        offset >= page.total_investment_transactions ||
        page.investment_transactions.length === 0
      )
        break;
    }
  }

  let holdingsCache: Awaited<
    ReturnType<PlaidClient["investmentsHoldings"]>
  > | null = null;
  let allOk = true;
  for (const m of mapped) {
    const account = plaidAccounts.get(m.plaidAccountId);
    const outcome: AccountSyncOutcome = {
      plaidAccountId: m.plaidAccountId,
      name: account?.name ?? m.plaidAccountId,
      kind: "INVESTMENTS",
      imported: 0,
      duplicates: 0,
      skippedRows: 0,
    };
    try {
      const accountTxns = transactions.filter(
        (t) => t.account_id === m.plaidAccountId,
      );
      const currency = account?.balances.iso_currency_code ?? "USD";
      const { rows, skipped } = mapInvestmentTransactions(
        accountTxns,
        securities,
        m.wfAccountId,
        currency,
      );
      outcome.skippedRows = skipped.length;

      if (!state.baselined.includes(m.plaidAccountId)) {
        if (!holdingsCache)
          holdingsCache = await client.investmentsHoldings(item.itemId);
        for (const s of holdingsCache.securities)
          securities.set(s.security_id, s);
        const earliest = accountTxns.length
          ? accountTxns.reduce(
              (min, t) => (t.date < min ? t.date : min),
              accountTxns[0].date,
            )
          : null;
        const baseline = buildInvestmentBaseline(
          holdingsCache.holdings,
          securities,
          rows,
          m.plaidAccountId,
          m.wfAccountId,
          currency,
          earliest,
        );
        rows.unshift(...baseline);
      }

      const { imported, duplicates, invalid, invalidExample } =
        await importRows(ctx, rows);
      outcome.imported = imported;
      outcome.duplicates = duplicates;
      if (invalid > 0) {
        // Rows the host's import validation rejects (e.g. a symbol market
        // data can't resolve) are permanent — retrying can't fix them, so
        // don't fail the account or hold the cursor. Count them as skipped
        // and explain in the log.
        outcome.skippedRows += invalid;
        outcome.note = `${invalid} row(s) rejected by import validation — e.g. ${invalidExample}`;
      }
      if (!state.baselined.includes(m.plaidAccountId))
        state.baselined.push(m.plaidAccountId);
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
      allOk = false;
    }
    outcomes.push(outcome);
  }

  if (allOk) {
    state.invCheckpoints[item.itemId] = today;
  }
}

/**
 * SnapTrade accounts are investment-only: one activities feed per account
 * with broker-complete history (no 730-day cap). First sync fetches from the
 * broker's first_transaction_date and adds a positions-derived baseline;
 * incremental syncs re-fetch a small overlap that dedup absorbs.
 */
async function syncSnapTradeAccounts(
  ctx: AddonContext,
  snap: SnapTradeClient,
  links: { plaidAccountId: string; wfAccountId: string }[],
  state: SyncState,
  outcomes: AccountSyncOutcome[],
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const accounts = new Map<string, SnapTradeAccount>(
    (await snap.listAccounts()).map((a) => [a.id, a]),
  );

  for (const m of links) {
    const account = accounts.get(m.plaidAccountId);
    const institution = account?.institution_name ?? "";
    const outcome: AccountSyncOutcome = {
      plaidAccountId: m.plaidAccountId,
      name: account
        ? institution &&
          !account.name.toLowerCase().includes(institution.toLowerCase())
          ? `${institution} ${account.name}`
          : account.name
        : m.plaidAccountId,
      kind: "INVESTMENTS",
      imported: 0,
      duplicates: 0,
      skippedRows: 0,
    };
    try {
      if (!account) {
        throw new Error(
          "Account no longer exists in SnapTrade — reconnect or remap",
        );
      }
      const checkpoint = state.snapCheckpoints[m.plaidAccountId];
      const isNew = !state.baselined.includes(m.plaidAccountId);
      const start =
        checkpoint && !isNew
          ? new Date(
              new Date(`${checkpoint}T00:00:00Z`).getTime() -
                OVERLAP_DAYS * 86400_000,
            )
              .toISOString()
              .slice(0, 10)
          : (account.sync_status?.transactions?.first_transaction_date ??
            isoDaysAgo(3650));
      const currency = account.balance?.total?.currency ?? "USD";

      const activities = await snap.accountActivities(
        m.plaidAccountId,
        start,
        today,
      );
      const { rows, skipped } = mapSnapTradeActivities(
        activities,
        m.wfAccountId,
        currency,
      );
      outcome.skippedRows = skipped.length;
      if (skipped.length > 0) {
        outcome.note = `${skipped.length} row(s) skipped — e.g. ${skipped[0].reason}`;
      }

      if (isNew) {
        const positions = await snap.accountPositions(m.plaidAccountId);
        const earliest =
          rows.length > 0 && typeof rows[0].date === "string"
            ? rows[0].date
            : null;
        const baseline = buildSnapTradeBaseline(
          positions,
          rows,
          m.plaidAccountId,
          m.wfAccountId,
          currency,
          earliest,
        );
        rows.unshift(...baseline);
      }

      const { imported, duplicates, invalid, invalidExample } =
        await importRows(ctx, rows);
      outcome.imported = imported;
      outcome.duplicates = duplicates;
      if (invalid > 0) {
        outcome.skippedRows += invalid;
        outcome.note = [
          outcome.note,
          `${invalid} row(s) rejected by import validation — e.g. ${invalidExample}`,
        ]
          .filter(Boolean)
          .join("; ");
      }
      if (isNew) state.baselined.push(m.plaidAccountId);
      state.snapCheckpoints[m.plaidAccountId] = today;
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
    outcomes.push(outcome);
  }
}

/**
 * Item-level fetch failures (e.g. PRODUCTS_NOT_SUPPORTED from an institution
 * that lacks a product) must not abort the rest of the run: record them on
 * each affected account and move on, so other institutions still sync and
 * state still saves.
 */
function recordItemFailure(
  outcomes: AccountSyncOutcome[],
  item: PlaidItemRef,
  links: { plaidAccountId: string; kind: SyncKind }[],
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  for (const link of links) {
    outcomes.push({
      plaidAccountId: link.plaidAccountId,
      name: `${item.institutionName ?? item.itemId} (${link.kind === "INVESTMENTS" ? "investments" : "banking"})`,
      kind: link.kind,
      imported: 0,
      duplicates: 0,
      skippedRows: 0,
      error: message,
    });
  }
}

/** Sync every mapped account across all items. Per-account failures are recorded, not fatal. */
export async function runSync(ctx: AddonContext): Promise<SyncRunResult> {
  const client = new PlaidClient(ctx);
  const run: SyncRunResult = { at: new Date().toISOString(), outcomes: [] };

  try {
    const [items, mapping, state] = await Promise.all([
      client.listItems(),
      loadMapping(ctx),
      loadState(ctx),
    ]);

    for (const item of items) {
      const links = Object.entries(mapping.links)
        .filter(
          ([, link]) =>
            linkProvider(link) === "plaid" && link.itemId === item.itemId,
        )
        .map(([plaidAccountId, link]) => ({ plaidAccountId, ...link }));
      if (links.length === 0) continue;

      let plaidAccounts: Map<string, PlaidAccount>;
      try {
        plaidAccounts = new Map(
          (await client.getAccounts(item.itemId)).map((a) => [a.account_id, a]),
        );
      } catch (error) {
        recordItemFailure(run.outcomes, item, links, error);
        continue;
      }

      const banking = links.filter((l) => l.kind === "BANKING");
      const investments = links.filter((l) => l.kind === "INVESTMENTS");
      if (banking.length > 0) {
        try {
          await syncItemBanking(
            ctx,
            client,
            item,
            banking,
            plaidAccounts,
            state,
            run.outcomes,
          );
        } catch (error) {
          recordItemFailure(run.outcomes, item, banking, error);
        }
      }
      if (investments.length > 0) {
        try {
          await syncItemInvestments(
            ctx,
            client,
            item,
            investments,
            plaidAccounts,
            state,
            run.outcomes,
          );
        } catch (error) {
          recordItemFailure(run.outcomes, item, investments, error);
        }
      }
    }

    const snapLinks = Object.entries(mapping.links)
      .filter(([, link]) => linkProvider(link) === "snaptrade")
      .map(([plaidAccountId, link]) => ({ plaidAccountId, ...link }));
    if (snapLinks.length > 0) {
      try {
        await syncSnapTradeAccounts(
          ctx,
          new SnapTradeClient(ctx),
          snapLinks,
          state,
          run.outcomes,
        );
      } catch (error) {
        // Account-level failures are recorded inside; this catches feed-level
        // ones (credentials, listAccounts) so Plaid results still land.
        const message = error instanceof Error ? error.message : String(error);
        for (const link of snapLinks) {
          run.outcomes.push({
            plaidAccountId: link.plaidAccountId,
            name: "SnapTrade",
            kind: link.kind,
            imported: 0,
            duplicates: 0,
            skippedRows: 0,
            error: message,
          });
        }
      }
    }

    await ctx.api.storage.set(STATE_KEY, JSON.stringify(state));
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  }

  await appendSyncLog(ctx, run);
  return run;
}
