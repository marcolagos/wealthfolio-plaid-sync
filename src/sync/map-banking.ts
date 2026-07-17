import type { ActivityImport, ActivityType } from "@wealthfolio/addon-sdk";
import type { PlaidAccount, PlaidTransaction } from "../plaid/types";

/**
 * Mapping must stay deterministic: the host dedupes on a content hash of
 * (account, type, date, amounts, currency, comment). The `[plaid:<id>]`
 * marker folds Plaid's stable transaction_id into that hash.
 *
 * Plaid sign convention: amount > 0 = money OUT of the account.
 */

const INTEREST_PATTERN = /\binterest\b/i;
const FEE_PATTERN = /\b(?:fee|fees|service charge)\b/i;
const CARD_PAYMENT_PATTERN = /\bautopay\b|automatic payment|payment[ -]+thank/i;

/** Payment received by a credit card (reduces the debt). */
function isCardPayment(
  tx: PlaidTransaction,
  plaidAccountType?: string,
): boolean {
  if (plaidAccountType !== "credit") return false;
  if (tx.personal_finance_category?.primary === "LOAN_PAYMENTS") return true;
  return CARD_PAYMENT_PATTERN.test(
    `${tx.name ?? ""} ${tx.merchant_name ?? ""}`,
  );
}

function classify(
  tx: PlaidTransaction,
  plaidAccountType?: string,
): ActivityType {
  // Money INTO a credit card must be CREDIT — the host rejects DEPOSIT on
  // CREDIT_CARD accounts. Payments are matched by category/name rather than
  // sign because some institutions (and the Plaid sandbox) report them with
  // the same positive sign as purchases; refunds arrive as negative amounts.
  if (plaidAccountType === "credit") {
    if (isCardPayment(tx, plaidAccountType) || tx.amount < 0) return "CREDIT";
  }
  const text = `${tx.name ?? ""} ${tx.merchant_name ?? ""}`;
  const outflow = tx.amount > 0;
  if (outflow) {
    return FEE_PATTERN.test(text) ? "FEE" : "WITHDRAWAL";
  }
  return INTEREST_PATTERN.test(text) ? "INTEREST" : "DEPOSIT";
}

export function mapBankingTransaction(
  tx: PlaidTransaction,
  wfAccountId: string,
  fallbackCurrency: string,
  lineNumber: number,
  plaidAccountType?: string,
): ActivityImport {
  return {
    accountId: wfAccountId,
    currency: tx.iso_currency_code ?? fallbackCurrency,
    activityType: classify(tx, plaidAccountType),
    date: tx.date,
    symbol: "",
    amount: Math.abs(tx.amount).toFixed(2),
    comment: `${tx.name} [plaid:${tx.transaction_id}]`,
    lineNumber,
    isValid: false,
    isDraft: false,
  };
}

/** Map posted (non-pending) transactions, oldest first. */
export function mapBankingTransactions(
  transactions: PlaidTransaction[],
  wfAccountId: string,
  fallbackCurrency: string,
  plaidAccountType?: string,
): ActivityImport[] {
  return transactions
    .filter((tx) => !tx.pending)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((tx, i) =>
      mapBankingTransaction(
        tx,
        wfAccountId,
        fallbackCurrency,
        i + 1,
        plaidAccountType,
      ),
    );
}

/**
 * Opening-balance anchor for depository accounts so the computed balance
 * matches the reported one: current balance plus the signed sum of fetched
 * outflows. Credit accounts get no anchor (their balance is amount owed, not
 * an asset balance); activity history still imports correctly.
 */
export function buildBankingAnchor(
  account: PlaidAccount,
  transactions: PlaidTransaction[],
  wfAccountId: string,
): ActivityImport | null {
  if (account.type !== "depository") return null;
  const current = account.balances.current;
  if (current == null) return null;

  const posted = transactions.filter((tx) => !tx.pending);
  // cash delta per transaction = -amount (positive amount = outflow)
  const netDelta = posted.reduce((acc, tx) => acc - tx.amount, 0);
  const residue = Math.round((current - netDelta) * 100) / 100;
  if (!Number.isFinite(residue) || residue === 0) return null;

  const earliest = posted.length
    ? posted.reduce(
        (min, tx) => (tx.date < min ? tx.date : min),
        posted[0].date,
      )
    : new Date().toISOString().slice(0, 10);
  const anchorDate = new Date(
    new Date(`${earliest}T00:00:00Z`).getTime() - 86400_000,
  )
    .toISOString()
    .slice(0, 10);

  return {
    accountId: wfAccountId,
    currency: account.balances.iso_currency_code ?? "USD",
    activityType: residue > 0 ? "DEPOSIT" : "WITHDRAWAL",
    date: anchorDate,
    symbol: "",
    amount: Math.abs(residue).toFixed(2),
    comment: `Opening balance [plaid:anchor:${account.account_id}]`,
    lineNumber: 0,
    isValid: false,
    isDraft: false,
  };
}
