import type { AddonContext } from "@wealthfolio/addon-sdk";
import type {
  InvestmentsHoldingsResponse,
  InvestmentsTransactionsResponse,
  ItemPublicTokenExchangeResponse,
  LinkTokenCreateResponse,
  LinkTokenGetResponse,
  PlaidAccount,
  PlaidEnv,
  PlaidErrorBody,
  TransactionsSyncResponse,
} from "./types";

export const CLIENT_ID_SECRET_KEY = "plaid-client-id";
export const API_SECRET_SECRET_KEY = "plaid-secret";
export const ENV_STORAGE_KEY = "plaid-env";
export const ITEMS_STORAGE_KEY = "plaid-items";
export const HISTORY_DAYS_STORAGE_KEY = "plaid-history-days";

/** Plaid's hard cap for transactions.days_requested (24 months). */
export const MAX_HISTORY_DAYS = 730;
const DEFAULT_HISTORY_DAYS = 730;

function clampHistoryDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_HISTORY_DAYS;
  return Math.min(MAX_HISTORY_DAYS, Math.max(1, Math.round(days)));
}

const BASE_URLS: Record<PlaidEnv, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

/** One connected institution (a Plaid "Item"). */
export interface PlaidItemRef {
  itemId: string;
  /** Environment the item was created in — its access token only works there. */
  env: PlaidEnv;
  institutionName?: string;
  connectedAt: string;
}

export function accessTokenSecretKey(itemId: string): string {
  return `plaid-at-${itemId}`;
}

export class PlaidClient {
  private readonly ctx: AddonContext;

  constructor(ctx: AddonContext) {
    this.ctx = ctx;
  }

  // ── Configuration ────────────────────────────────────────────────

  async getEnv(): Promise<PlaidEnv> {
    const raw = await this.ctx.api.storage.get(ENV_STORAGE_KEY);
    return raw === "production" ? "production" : "sandbox";
  }

  async isConfigured(): Promise<boolean> {
    const [clientId, secret] = await Promise.all([
      this.ctx.api.secrets.get(CLIENT_ID_SECRET_KEY),
      this.ctx.api.secrets.get(API_SECRET_SECRET_KEY),
    ]);
    return Boolean(clientId && secret);
  }

  /** How many days of transaction history to request from Plaid (1–730). */
  async getHistoryDays(): Promise<number> {
    const raw = await this.ctx.api.storage.get(HISTORY_DAYS_STORAGE_KEY);
    const parsed = Number(raw);
    return raw && Number.isFinite(parsed)
      ? clampHistoryDays(parsed)
      : DEFAULT_HISTORY_DAYS;
  }

  async setHistoryDays(days: number): Promise<void> {
    await this.ctx.api.storage.set(
      HISTORY_DAYS_STORAGE_KEY,
      String(clampHistoryDays(days)),
    );
  }

  async saveCredentials(
    clientId: string,
    secret: string,
    env: PlaidEnv,
  ): Promise<void> {
    await this.ctx.api.secrets.set(CLIENT_ID_SECRET_KEY, clientId.trim());
    await this.ctx.api.secrets.set(API_SECRET_SECRET_KEY, secret.trim());
    await this.ctx.api.storage.set(ENV_STORAGE_KEY, env);
  }

  async listItems(): Promise<PlaidItemRef[]> {
    const raw = await this.ctx.api.storage.get(ITEMS_STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as PlaidItemRef[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async saveItems(items: PlaidItemRef[]): Promise<void> {
    await this.ctx.api.storage.set(ITEMS_STORAGE_KEY, JSON.stringify(items));
  }

  // ── Transport ────────────────────────────────────────────────────

  /**
   * POST to the Plaid API with client credentials merged into the body
   * (Plaid's documented auth style). Credentials never leave the encrypted
   * secret store except to be embedded per-request here.
   */
  private async post<T>(
    env: PlaidEnv,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const [clientId, secret] = await Promise.all([
      this.ctx.api.secrets.get(CLIENT_ID_SECRET_KEY),
      this.ctx.api.secrets.get(API_SECRET_SECRET_KEY),
    ]);
    if (!clientId || !secret) {
      throw new Error("Plaid credentials are not configured");
    }
    const send = () =>
      this.ctx.api.network.request({
        url: `${BASE_URLS[env]}${path}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, secret, ...body }),
      });
    // Transport-level failures (connection errors, the broker's 10s timeout)
    // never carry a Plaid response, so retrying is safe — even for token
    // exchanges. Plaid warms cold sandbox data during the timed-out attempt,
    // so later attempts typically finish fast.
    const MAX_ATTEMPTS = 4;
    let res: Awaited<ReturnType<typeof send>> | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await send();
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const transient =
          /error sending request|timed out|timeout|network/i.test(message);
        if (!transient || attempt >= MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
      }
    }
    if (res.status !== 200) {
      let plaidError: PlaidErrorBody = {};
      try {
        plaidError = JSON.parse(res.body) as PlaidErrorBody;
      } catch {
        // non-JSON error body — fall through to the generic message
      }
      const code = plaidError.error_code ?? `HTTP ${res.status}`;
      const message =
        plaidError.display_message ??
        plaidError.error_message ??
        "Plaid request failed";
      throw new Error(`${code}: ${message}`);
    }
    return JSON.parse(res.body) as T;
  }

  private async postForItem<T>(
    itemId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const items = await this.listItems();
    const item = items.find((i) => i.itemId === itemId);
    if (!item) throw new Error(`Unknown Plaid item ${itemId}`);
    const accessToken = await this.ctx.api.secrets.get(
      accessTokenSecretKey(itemId),
    );
    if (!accessToken)
      throw new Error("Access token missing — reconnect this institution");
    return this.post<T>(item.env, path, { access_token: accessToken, ...body });
  }

  // ── Connect flows ────────────────────────────────────────────────

  private async registerItem(
    env: PlaidEnv,
    publicToken: string,
    institutionName?: string,
  ): Promise<PlaidItemRef> {
    const exchanged = await this.post<ItemPublicTokenExchangeResponse>(
      env,
      "/item/public_token/exchange",
      {
        public_token: publicToken,
      },
    );
    await this.ctx.api.secrets.set(
      accessTokenSecretKey(exchanged.item_id),
      exchanged.access_token,
    );
    const item: PlaidItemRef = {
      itemId: exchanged.item_id,
      env,
      institutionName,
      connectedAt: new Date().toISOString(),
    };
    const items = await this.listItems();
    await this.saveItems([
      ...items.filter((i) => i.itemId !== item.itemId),
      item,
    ]);
    return item;
  }

  /** Sandbox-only: connect a test institution without the Link UI. */
  async sandboxQuickConnect(
    institutionId = "ins_109508",
  ): Promise<PlaidItemRef> {
    const env = await this.getEnv();
    if (env !== "sandbox")
      throw new Error(
        "Quick connect is only available in the sandbox environment",
      );
    // transactions-only creation is fast; requesting investments up front makes
    // Plaid generate all investment history synchronously and blows past the
    // network broker's 10s timeout (and each retry starts a fresh item, so
    // retrying never helps). Investments initializes lazily on first use.
    const created = await this.post<{ public_token: string }>(
      env,
      "/sandbox/public_token/create",
      {
        institution_id: institutionId,
        initial_products: ["transactions"],
      },
    );
    return this.registerItem(
      env,
      created.public_token,
      `Sandbox (${institutionId})`,
    );
  }

  /**
   * Real connect flow: create a Hosted Link session. The returned URL must be
   * opened in a browser (the sandboxed addon iframe cannot open popups — the
   * settings page shows it with a copy button). Then `pollHostedLink` picks up
   * the completed session.
   */
  async createHostedLink(): Promise<LinkTokenCreateResponse> {
    const env = await this.getEnv();
    return this.post<LinkTokenCreateResponse>(env, "/link/token/create", {
      user: { client_user_id: "wealthfolio-plaid-sync" },
      client_name: "Wealthfolio",
      products: ["transactions"],
      optional_products: ["investments"],
      country_codes: ["US"],
      language: "en",
      hosted_link: {},
      transactions: { days_requested: await this.getHistoryDays() },
    });
  }

  /**
   * Update-mode Hosted Link for an existing item, requesting a deeper
   * transaction history window. After the user completes it in the browser,
   * Plaid backfills asynchronously and /transactions/sync delivers the older
   * transactions with stable IDs (dedup absorbs the overlap). Update mode
   * produces no public token, so there is nothing to poll or exchange.
   */
  async createExtendHistoryLink(
    itemId: string,
  ): Promise<LinkTokenCreateResponse> {
    return this.postForItem<LinkTokenCreateResponse>(
      itemId,
      "/link/token/create",
      {
        user: { client_user_id: "wealthfolio-plaid-sync" },
        client_name: "Wealthfolio",
        country_codes: ["US"],
        language: "en",
        hosted_link: {},
        transactions: { days_requested: await this.getHistoryDays() },
      },
    );
  }

  /** Returns the new item if the hosted Link session has completed, else null. */
  async pollHostedLink(linkToken: string): Promise<PlaidItemRef | null> {
    const env = await this.getEnv();
    const res = await this.post<LinkTokenGetResponse>(env, "/link/token/get", {
      link_token: linkToken,
    });
    for (const session of res.link_sessions ?? []) {
      const publicToken = session.results?.item_add_results?.[0]?.public_token;
      if (publicToken) {
        return this.registerItem(env, publicToken);
      }
    }
    return null;
  }

  async removeItem(itemId: string): Promise<void> {
    try {
      await this.postForItem(itemId, "/item/remove", {});
    } catch {
      // Item may already be dead server-side; still clean up locally.
    }
    await this.ctx.api.secrets.delete(accessTokenSecretKey(itemId));
    const items = await this.listItems();
    await this.saveItems(items.filter((i) => i.itemId !== itemId));
  }

  // ── Data ─────────────────────────────────────────────────────────

  async getAccounts(itemId: string): Promise<PlaidAccount[]> {
    const res = await this.postForItem<{ accounts: PlaidAccount[] }>(
      itemId,
      "/accounts/get",
      {},
    );
    return res.accounts;
  }

  async transactionsSync(
    itemId: string,
    cursor: string | undefined,
  ): Promise<TransactionsSyncResponse> {
    return this.postForItem<TransactionsSyncResponse>(
      itemId,
      "/transactions/sync",
      {
        ...(cursor ? { cursor } : {}),
        count: 500,
      },
    );
  }

  async investmentsHoldings(
    itemId: string,
  ): Promise<InvestmentsHoldingsResponse> {
    return this.postForItem<InvestmentsHoldingsResponse>(
      itemId,
      "/investments/holdings/get",
      {},
    );
  }

  async investmentsTransactions(
    itemId: string,
    startDate: string,
    endDate: string,
    offset: number,
  ): Promise<InvestmentsTransactionsResponse> {
    return this.postForItem<InvestmentsTransactionsResponse>(
      itemId,
      "/investments/transactions/get",
      {
        start_date: startDate,
        end_date: endDate,
        options: { count: 100, offset },
      },
    );
  }
}
