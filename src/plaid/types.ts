/**
 * Plaid API types — the subset this addon touches, shaped from live sandbox
 * responses (2026-07). Wire format is snake_case JSON over POST.
 */

export type PlaidEnv = "sandbox" | "production";

export interface PlaidBalances {
  available: number | null;
  current: number | null;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  /** depository | credit | investment | loan | other */
  type: string;
  /** checking, savings, cd, credit card, ira, 401k, hsa, ... */
  subtype?: string | null;
  balances: PlaidBalances;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** YYYY-MM-DD (posted date) */
  date: string;
  authorized_date?: string | null;
  name: string;
  merchant_name?: string | null;
  /** Positive = money OUT of the account; negative = money IN. */
  amount: number;
  iso_currency_code: string | null;
  pending: boolean;
  /** Plaid's unified category taxonomy (populated for most institutions). */
  personal_finance_category?: {
    primary?: string;
    detailed?: string;
  } | null;
}

export interface TransactionsSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
  accounts?: PlaidAccount[];
}

export interface PlaidSecurity {
  security_id: string;
  ticker_symbol: string | null;
  name: string | null;
  /** equity | mutual fund | etf | cryptocurrency | derivative | cash | fixed income | ... */
  type: string | null;
  is_cash_equivalent?: boolean | null;
  iso_currency_code: string | null;
  close_price?: number | null;
}

export interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  /** Total cost basis for the position (not per share). */
  cost_basis: number | null;
  institution_price: number | null;
  institution_value: number | null;
  iso_currency_code: string | null;
}

export interface InvestmentsHoldingsResponse {
  accounts: PlaidAccount[];
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
}

export interface PlaidInvestmentTransaction {
  investment_transaction_id: string;
  account_id: string;
  security_id: string | null;
  /** YYYY-MM-DD */
  date: string;
  name: string;
  /** Signed: positive for buys, negative for sells. */
  quantity: number;
  /** Signed cash impact: positive = cash out (buys), negative = cash in. */
  amount: number;
  price: number | null;
  fees: number | null;
  /** buy | sell | cash | fee | transfer | cancel */
  type: string;
  /** dividend, deposit, withdrawal, contribution, management fee, ... */
  subtype: string | null;
  iso_currency_code: string | null;
}

export interface InvestmentsTransactionsResponse {
  accounts: PlaidAccount[];
  investment_transactions: PlaidInvestmentTransaction[];
  securities: PlaidSecurity[];
  total_investment_transactions: number;
}

export interface LinkTokenCreateResponse {
  link_token: string;
  expiration: string;
  hosted_link_url?: string;
}

export interface LinkTokenGetResponse {
  link_token: string;
  link_sessions?: {
    link_session_id: string;
    results?: {
      item_add_results?: { public_token: string }[];
    };
  }[];
}

export interface ItemPublicTokenExchangeResponse {
  access_token: string;
  item_id: string;
}

export interface PlaidErrorBody {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}
