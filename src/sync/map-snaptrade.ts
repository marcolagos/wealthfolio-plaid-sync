import type { ActivityImport, ActivityType } from "@wealthfolio/addon-sdk";
import type { SnapTradeActivity, SnapTradePosition } from "../snaptrade/types";

/**
 * SnapTrade activity conventions (observed live): BUY has positive units and
 * NEGATIVE amount (cash out); SELL has negative units and positive amount;
 * DIVIDEND/CONTRIBUTION are positive amounts. The stable activity `id` goes
 * into the `[snaptrade:<id>]` comment marker for content-hash dedup, same
 * scheme as the Plaid markers.
 */

/** Money-market sweep funds (SPAXX, FDRXX, VMFXX, SWVXX…): cash churn, not
 *  positions. Trades in them at $1.00 are skipped — the cash-flow rows
 *  (CONTRIBUTION/WITHDRAWAL/BUY/SELL of real securities) already balance. */
const SWEEP_PATTERN = /^[A-Z]{2,4}XX$/;

function isSweepTrade(activity: SnapTradeActivity, symbol: string): boolean {
  return (
    symbol !== "" &&
    SWEEP_PATTERN.test(symbol) &&
    Math.abs(activity.price ?? 0) === 1
  );
}

export interface SnapTradeMapResult {
  rows: ActivityImport[];
  skipped: { id: string; reason: string }[];
}

function row(
  activity: SnapTradeActivity,
  wfAccountId: string,
  fallbackCurrency: string,
  lineNumber: number,
  activityType: ActivityType,
  symbol: string,
  extra: Partial<ActivityImport>,
): ActivityImport {
  const label = (activity.description ?? activity.type).slice(0, 80);
  return {
    accountId: wfAccountId,
    currency: activity.currency?.code ?? fallbackCurrency,
    activityType,
    date: (activity.trade_date ?? activity.settlement_date ?? "").slice(0, 10),
    symbol,
    fee: activity.fee ?? 0,
    comment: `${label} [snaptrade:${activity.id}]`,
    lineNumber,
    isValid: false,
    isDraft: false,
    ...extra,
  };
}

export function mapSnapTradeActivities(
  activities: SnapTradeActivity[],
  wfAccountId: string,
  fallbackCurrency: string,
): SnapTradeMapResult {
  const rows: ActivityImport[] = [];
  const skipped: { id: string; reason: string }[] = [];

  const sorted = [...activities].sort((a, b) => {
    const da = a.trade_date ?? "";
    const db = b.trade_date ?? "";
    return da < db ? -1 : da > db ? 1 : 0;
  });

  for (const activity of sorted) {
    const symbol = (activity.symbol?.symbol ?? "").trim();
    const units = activity.units ?? 0;
    const absUnits = Math.abs(units);
    const absAmount = Math.abs(activity.amount ?? 0);
    const price =
      activity.price && activity.price !== 0
        ? Math.abs(activity.price)
        : absUnits > 0
          ? absAmount / absUnits
          : 0;
    const n = rows.length + 1;
    const type = activity.type.toUpperCase();

    if (
      (type === "BUY" || type === "SELL" || type === "REI") &&
      isSweepTrade(activity, symbol)
    ) {
      skipped.push({
        id: activity.id,
        reason: `money-market sweep (${symbol})`,
      });
      continue;
    }

    switch (type) {
      case "BUY":
      case "REI": // dividend reinvestment is a buy funded by the dividend row
        if (!symbol || absUnits === 0) {
          skipped.push({
            id: activity.id,
            reason: `${type} without symbol/units`,
          });
          break;
        }
        rows.push(
          row(activity, wfAccountId, fallbackCurrency, n, "BUY", symbol, {
            quantity: absUnits,
            unitPrice: price,
            amount: absAmount,
          }),
        );
        break;
      case "SELL":
        if (!symbol || absUnits === 0) {
          skipped.push({
            id: activity.id,
            reason: "SELL without symbol/units",
          });
          break;
        }
        rows.push(
          row(activity, wfAccountId, fallbackCurrency, n, "SELL", symbol, {
            quantity: absUnits,
            unitPrice: price,
            amount: absAmount,
          }),
        );
        break;
      case "DIVIDEND":
      case "STOCK_DIVIDEND":
        if (type === "STOCK_DIVIDEND" && symbol && absUnits > 0) {
          rows.push(
            row(
              activity,
              wfAccountId,
              fallbackCurrency,
              n,
              "TRANSFER_IN",
              symbol,
              {
                quantity: absUnits,
                unitPrice: price,
                amount: absAmount,
              },
            ),
          );
        } else {
          rows.push(
            row(
              activity,
              wfAccountId,
              fallbackCurrency,
              n,
              "DIVIDEND",
              symbol,
              {
                amount: absAmount,
              },
            ),
          );
        }
        break;
      case "CONTRIBUTION":
        rows.push(
          row(activity, wfAccountId, fallbackCurrency, n, "DEPOSIT", "", {
            amount: absAmount,
          }),
        );
        break;
      case "WITHDRAWAL":
        rows.push(
          row(activity, wfAccountId, fallbackCurrency, n, "WITHDRAWAL", "", {
            amount: absAmount,
          }),
        );
        break;
      case "INTEREST":
        rows.push(
          row(activity, wfAccountId, fallbackCurrency, n, "INTEREST", "", {
            amount: absAmount,
          }),
        );
        break;
      case "FEE":
        rows.push(
          row(activity, wfAccountId, fallbackCurrency, n, "FEE", "", {
            amount: absAmount,
          }),
        );
        break;
      case "TRANSFER":
      case "EXTERNAL_ASSET_TRANSFER_IN":
      case "EXTERNAL_ASSET_TRANSFER_OUT": {
        const inbound = type === "EXTERNAL_ASSET_TRANSFER_IN" || units > 0;
        if (symbol && absUnits > 0) {
          rows.push(
            row(
              activity,
              wfAccountId,
              fallbackCurrency,
              n,
              inbound ? "TRANSFER_IN" : "TRANSFER_OUT",
              symbol,
              { quantity: absUnits, unitPrice: price, amount: absAmount },
            ),
          );
        } else {
          rows.push(
            row(
              activity,
              wfAccountId,
              fallbackCurrency,
              n,
              inbound ? "TRANSFER_IN" : "TRANSFER_OUT",
              "",
              { amount: absAmount },
            ),
          );
        }
        break;
      }
      default:
        skipped.push({
          id: activity.id,
          reason: `unsupported type ${activity.type}`,
        });
    }
  }

  return { rows, skipped };
}

/**
 * Positions predating the broker's transaction history come in as baseline
 * TRANSFER_INs (dated before the earliest activity), cash-equivalent
 * positions as one cash DEPOSIT anchor — mirrors the Plaid investment
 * baseline logic with `[snaptrade:baseline:…]` markers.
 */
export function buildSnapTradeBaseline(
  positions: SnapTradePosition[],
  rows: ActivityImport[],
  snapAccountId: string,
  wfAccountId: string,
  fallbackCurrency: string,
  earliestDate: string | null,
): ActivityImport[] {
  const anchorDate = earliestDate
    ? new Date(new Date(`${earliestDate}T00:00:00Z`).getTime() - 86400_000)
        .toISOString()
        .slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const netUnits = new Map<string, number>();
  for (const r of rows) {
    const sym = (r.symbol ?? "").trim();
    if (!sym) continue;
    const qty = Number(r.quantity ?? 0);
    if (r.activityType === "BUY" || r.activityType === "TRANSFER_IN") {
      netUnits.set(sym, (netUnits.get(sym) ?? 0) + qty);
    } else if (r.activityType === "SELL" || r.activityType === "TRANSFER_OUT") {
      netUnits.set(sym, (netUnits.get(sym) ?? 0) - qty);
    }
  }

  const baseline: ActivityImport[] = [];
  let cashAnchor = 0;
  for (const position of positions) {
    const sym = (position.symbol?.symbol?.symbol ?? "").trim();
    const units = position.units ?? 0;
    if (units <= 0) continue;
    if (position.cash_equivalent || (sym && SWEEP_PATTERN.test(sym))) {
      cashAnchor += units * (position.price ?? 1);
      continue;
    }
    if (!sym) continue;
    const remainder = units - (netUnits.get(sym) ?? 0);
    if (remainder <= 1e-6) continue;
    baseline.push({
      accountId: wfAccountId,
      currency: position.currency?.code ?? fallbackCurrency,
      activityType: "TRANSFER_IN",
      date: anchorDate,
      symbol: sym,
      quantity: remainder,
      unitPrice: position.average_purchase_price ?? position.price ?? 0,
      fee: 0,
      comment: `Baseline position [snaptrade:baseline:${snapAccountId}:${sym}]`,
      lineNumber: 0,
      isValid: false,
      isDraft: false,
    });
  }

  if (cashAnchor > 0.01) {
    baseline.push({
      accountId: wfAccountId,
      currency: fallbackCurrency,
      activityType: "DEPOSIT",
      date: anchorDate,
      symbol: "",
      amount: Math.round(cashAnchor * 100) / 100,
      fee: 0,
      comment: `Baseline cash [snaptrade:baseline:${snapAccountId}:cash]`,
      lineNumber: 0,
      isValid: false,
      isDraft: false,
    });
  }

  return baseline;
}
