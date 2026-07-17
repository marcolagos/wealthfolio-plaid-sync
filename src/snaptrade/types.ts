/** SnapTrade API response shapes (only the fields the addon consumes). */

export interface SnapTradeAccount {
  id: string;
  brokerage_authorization: string;
  name: string;
  number?: string | null;
  institution_name?: string | null;
  raw_type?: string | null;
  status?: string | null;
  balance?: {
    total?: { amount?: number | null; currency?: string | null } | null;
  } | null;
  sync_status?: {
    transactions?: {
      first_transaction_date?: string | null;
      last_successful_sync?: string | null;
    } | null;
  } | null;
  meta?: Record<string, unknown> | null;
}

export interface SnapTradeAuthorization {
  id: string;
  disabled?: boolean;
  type?: string;
  brokerage?: { name?: string | null; slug?: string | null } | null;
}

export interface SnapTradeSymbol {
  symbol?: string | null;
  raw_symbol?: string | null;
  description?: string | null;
  currency?: { code?: string | null } | null;
  type?: { code?: string | null } | null;
}

export interface SnapTradeActivity {
  id: string;
  type: string;
  trade_date?: string | null;
  settlement_date?: string | null;
  symbol?: SnapTradeSymbol | null;
  option_symbol?: unknown;
  units?: number | null;
  price?: number | null;
  amount?: number | null;
  fee?: number | null;
  currency?: { code?: string | null } | null;
  description?: string | null;
  institution?: string | null;
}

/** Note the nesting: position.symbol.symbol is the SnapTradeSymbol. */
export interface SnapTradePosition {
  symbol?: { symbol?: SnapTradeSymbol | null } | null;
  units?: number | null;
  price?: number | null;
  average_purchase_price?: number | null;
  cash_equivalent?: boolean | null;
  currency?: { code?: string | null } | null;
}

export interface SnapTradeLoginResponse {
  redirectURI: string;
  sessionId?: string;
}
