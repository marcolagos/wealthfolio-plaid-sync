import type { AddonContext } from "@wealthfolio/addon-sdk";

/** How a mapped account syncs: cash transactions vs investment transactions. */
export type SyncKind = "BANKING" | "INVESTMENTS";

export type SyncProvider = "plaid" | "snaptrade";

export interface AccountLink {
  wfAccountId: string;
  kind: SyncKind;
  /**
   * Plaid: the item id. SnapTrade: the brokerage authorization id.
   * (Set when the link is created.)
   */
  itemId: string;
  /** Absent on links created before v0.2.0 — treat as "plaid". */
  provider?: SyncProvider;
}

export function linkProvider(link: AccountLink): SyncProvider {
  return link.provider ?? "plaid";
}

/**
 * Links keyed by provider account id (Plaid account_id / SnapTrade account
 * id). Ids in `ignored` are never synced.
 */
export interface AccountMapping {
  links: Record<string, AccountLink>;
  ignored: string[];
}

const MAPPING_STORAGE_KEY = "plaid-account-map";

export async function loadMapping(ctx: AddonContext): Promise<AccountMapping> {
  const raw = await ctx.api.storage.get(MAPPING_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<AccountMapping>;
      return {
        links: parsed.links ?? {},
        ignored: Array.isArray(parsed.ignored) ? parsed.ignored : [],
      };
    } catch {
      // fall through to a fresh mapping
    }
  }
  return { links: {}, ignored: [] };
}

export async function saveMapping(
  ctx: AddonContext,
  mapping: AccountMapping,
): Promise<void> {
  await ctx.api.storage.set(MAPPING_STORAGE_KEY, JSON.stringify(mapping));
}
