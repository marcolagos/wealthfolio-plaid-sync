import type { AddonContext } from "@wealthfolio/addon-sdk";
import type {
  SnapTradeAccount,
  SnapTradeActivity,
  SnapTradeAuthorization,
  SnapTradeLoginResponse,
  SnapTradePosition,
} from "./types";

export const SNAPTRADE_CLIENT_ID_KEY = "snaptrade-client-id";
export const SNAPTRADE_CONSUMER_KEY_KEY = "snaptrade-consumer-key";

const BASE_URL = "https://api.snaptrade.com";

/**
 * JSON.stringify with recursively sorted object keys and no whitespace —
 * must byte-match Python's json.dumps(obj, separators=(",",":"),
 * sort_keys=True), which is what SnapTrade's signature spec canonicalizes
 * with.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export class SnapTradeClient {
  private readonly ctx: AddonContext;

  constructor(ctx: AddonContext) {
    this.ctx = ctx;
  }

  async isConfigured(): Promise<boolean> {
    const [clientId, consumerKey] = await Promise.all([
      this.ctx.api.secrets.get(SNAPTRADE_CLIENT_ID_KEY),
      this.ctx.api.secrets.get(SNAPTRADE_CONSUMER_KEY_KEY),
    ]);
    return Boolean(clientId && consumerKey);
  }

  async saveCredentials(clientId: string, consumerKey: string): Promise<void> {
    await this.ctx.api.secrets.set(SNAPTRADE_CLIENT_ID_KEY, clientId.trim());
    await this.ctx.api.secrets.set(
      SNAPTRADE_CONSUMER_KEY_KEY,
      consumerKey.trim(),
    );
  }

  /** HMAC-SHA256(base64) of the canonical payload, keyed by the consumer key. */
  private async sign(payload: string, consumerKey: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      throw new Error(
        "WebCrypto is unavailable in this environment — cannot sign SnapTrade requests",
      );
    }
    const encoder = new TextEncoder();
    const key = await subtle.importKey(
      "raw",
      encoder.encode(consumerKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await subtle.sign("HMAC", key, encoder.encode(payload));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  /**
   * Signed request. `body` of null means "no request body" — the signature
   * still covers it as content:null (SnapTrade's bodyless-POST convention,
   * e.g. /snapTrade/login).
   */
  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    query: Record<string, string> = {},
    body: unknown = null,
  ): Promise<T> {
    const [clientId, consumerKey] = await Promise.all([
      this.ctx.api.secrets.get(SNAPTRADE_CLIENT_ID_KEY),
      this.ctx.api.secrets.get(SNAPTRADE_CONSUMER_KEY_KEY),
    ]);
    if (!clientId || !consumerKey) {
      throw new Error("SnapTrade credentials are not configured");
    }

    // Same transient-transport retry policy as the Plaid client; the
    // timestamp (and thus signature) is regenerated per attempt.
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; ; attempt++) {
      const params = new URLSearchParams({
        ...query,
        clientId,
        timestamp: String(Math.floor(Date.now() / 1000)),
      });
      const qs = params.toString();
      const signature = await this.sign(
        canonicalJson({ content: body, path, query: qs }),
        consumerKey,
      );
      try {
        const res = await this.ctx.api.network.request({
          url: `${BASE_URL}${path}?${qs}`,
          method,
          headers: {
            Signature: signature,
            ...(body !== null ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== null ? { body: JSON.stringify(body) } : {}),
        });
        if (res.status !== 200) {
          let detail = "";
          try {
            const parsed = JSON.parse(res.body) as { detail?: string };
            detail = parsed.detail ?? "";
          } catch {
            // non-JSON error body
          }
          throw new Error(
            `SnapTrade HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
          );
        }
        return JSON.parse(res.body) as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const transient =
          /error sending request|timed out|timeout|network/i.test(message);
        if (!transient || attempt >= MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
      }
    }
  }

  async listAccounts(): Promise<SnapTradeAccount[]> {
    return this.request<SnapTradeAccount[]>("GET", "/api/v1/accounts");
  }

  async listAuthorizations(): Promise<SnapTradeAuthorization[]> {
    return this.request<SnapTradeAuthorization[]>(
      "GET",
      "/api/v1/authorizations",
    );
  }

  async removeAuthorization(authorizationId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/v1/authorizations/${authorizationId}`,
    );
  }

  /** Connection Portal session URL — open in a browser to link a brokerage. */
  async createPortalUrl(): Promise<SnapTradeLoginResponse> {
    return this.request<SnapTradeLoginResponse>(
      "POST",
      "/api/v1/snapTrade/login",
    );
  }

  /** All activities in [startDate, endDate] (YYYY-MM-DD), broker-complete. */
  async accountActivities(
    accountId: string,
    startDate: string,
    endDate: string,
  ): Promise<SnapTradeActivity[]> {
    const res = await this.request<
      SnapTradeActivity[] | { data?: SnapTradeActivity[] }
    >("GET", `/api/v1/accounts/${accountId}/activities`, {
      startDate,
      endDate,
    });
    return Array.isArray(res) ? res : (res.data ?? []);
  }

  async accountPositions(accountId: string): Promise<SnapTradePosition[]> {
    return this.request<SnapTradePosition[]>(
      "GET",
      `/api/v1/accounts/${accountId}/positions`,
    );
  }
}
