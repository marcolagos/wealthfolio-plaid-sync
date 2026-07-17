import type { Account, AddonContext } from "@wealthfolio/addon-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { loadMapping, saveMapping, type AccountMapping } from "../lib/mapping";
import { PlaidClient } from "../plaid/client";
import type { PlaidAccount, PlaidEnv } from "../plaid/types";
import { AUTO_SYNC_HOURS_KEY, getAutoSyncHours } from "../sync/auto-sync";
import { loadSyncLog, runSync } from "../sync/orchestrator";

// Query-key prefix: the query cache is shared with the host app.
const K = {
  configured: ["plaid-sync", "configured"] as const,
  env: ["plaid-sync", "env"] as const,
  items: ["plaid-sync", "items"] as const,
  plaidAccounts: ["plaid-sync", "plaid-accounts"] as const,
  wfAccounts: ["plaid-sync", "wf-accounts"] as const,
  mapping: ["plaid-sync", "mapping"] as const,
  syncLog: ["plaid-sync", "sync-log"] as const,
  autoSyncHours: ["plaid-sync", "auto-sync-hours"] as const,
  historyDays: ["plaid-sync", "history-days"] as const,
};

export function usePlaidClient(ctx: AddonContext): PlaidClient {
  return useMemo(() => new PlaidClient(ctx), [ctx]);
}

export function useConfigured(ctx: AddonContext) {
  const client = usePlaidClient(ctx);
  return useQuery({
    queryKey: K.configured,
    queryFn: () => client.isConfigured(),
  });
}

export function usePlaidEnv(ctx: AddonContext) {
  const client = usePlaidClient(ctx);
  return useQuery({ queryKey: K.env, queryFn: () => client.getEnv() });
}

export function useSaveCredentialsMutation(ctx: AddonContext) {
  const client = usePlaidClient(ctx);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      clientId,
      secret,
      env,
    }: {
      clientId: string;
      secret: string;
      env: PlaidEnv;
    }) => client.saveCredentials(clientId, secret, env),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: K.configured });
      queryClient.invalidateQueries({ queryKey: K.env });
      ctx.api.toast.success("Plaid credentials saved");
    },
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
}

export function useItems(ctx: AddonContext) {
  const client = usePlaidClient(ctx);
  return useQuery({ queryKey: K.items, queryFn: () => client.listItems() });
}

export interface PlaidAccountRow {
  itemId: string;
  institutionName?: string;
  account: PlaidAccount;
}

/** Flat list of all accounts across connected items, for the mapping table. */
export function usePlaidAccounts(ctx: AddonContext, enabled: boolean) {
  const client = usePlaidClient(ctx);
  return useQuery({
    queryKey: K.plaidAccounts,
    queryFn: async (): Promise<PlaidAccountRow[]> => {
      const items = await client.listItems();
      const rows: PlaidAccountRow[] = [];
      for (const item of items) {
        const accounts = await client.getAccounts(item.itemId);
        for (const account of accounts) {
          rows.push({
            itemId: item.itemId,
            institutionName: item.institutionName,
            account,
          });
        }
      }
      return rows;
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useSandboxConnectMutation(ctx: AddonContext) {
  const client = usePlaidClient(ctx);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.sandboxQuickConnect(),
    onSuccess: (item) => {
      queryClient.invalidateQueries({ queryKey: K.items });
      queryClient.invalidateQueries({ queryKey: K.plaidAccounts });
      ctx.api.toast.success(`Connected ${item.institutionName ?? item.itemId}`);
    },
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
}

export function useHostedLinkMutation(ctx: AddonContext) {
  const client = usePlaidClient(ctx);
  return useMutation({
    mutationFn: () => client.createHostedLink(),
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
}

export function usePollHostedLinkMutation(ctx: AddonContext) {
  const client = usePlaidClient(ctx);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (linkToken: string) => client.pollHostedLink(linkToken),
    onSuccess: (item) => {
      if (item) {
        queryClient.invalidateQueries({ queryKey: K.items });
        queryClient.invalidateQueries({ queryKey: K.plaidAccounts });
        ctx.api.toast.success("Institution connected");
      } else {
        ctx.api.toast.info(
          "Link session not finished yet — complete it in the browser first",
        );
      }
    },
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
}

export function useHistoryDays(ctx: AddonContext) {
  const client = usePlaidClient(ctx);
  const queryClient = useQueryClient();
  const days = useQuery({
    queryKey: K.historyDays,
    queryFn: () => client.getHistoryDays(),
  });
  const setDays = useMutation({
    mutationFn: (value: number) => client.setHistoryDays(value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: K.historyDays }),
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
  return { days, setDays };
}

export function useExtendHistoryLinkMutation(ctx: AddonContext) {
  const client = usePlaidClient(ctx);
  return useMutation({
    mutationFn: (itemId: string) => client.createExtendHistoryLink(itemId),
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
}

export function useRemoveItemMutation(ctx: AddonContext) {
  const client = usePlaidClient(ctx);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => client.removeItem(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: K.items });
      queryClient.invalidateQueries({ queryKey: K.plaidAccounts });
      ctx.api.toast.success("Institution removed");
    },
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
}

export function useWealthfolioAccounts(ctx: AddonContext) {
  return useQuery<Account[]>({
    queryKey: K.wfAccounts,
    queryFn: () => ctx.api.accounts.getAll(),
  });
}

export function useAccountMapping(ctx: AddonContext) {
  return useQuery({ queryKey: K.mapping, queryFn: () => loadMapping(ctx) });
}

export function useSaveMappingMutation(ctx: AddonContext) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mapping: AccountMapping) => saveMapping(ctx, mapping),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: K.mapping }),
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
}

export function useCreateAccountMutation(ctx: AddonContext) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (account: unknown) => ctx.api.accounts.create(account),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: K.wfAccounts }),
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
}

export function useAutoSyncHours(ctx: AddonContext) {
  const queryClient = useQueryClient();
  const hours = useQuery({
    queryKey: K.autoSyncHours,
    queryFn: () => getAutoSyncHours(ctx),
  });
  const setHours = useMutation({
    mutationFn: (value: number) =>
      ctx.api.storage.set(AUTO_SYNC_HOURS_KEY, String(value)),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: K.autoSyncHours }),
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
  return { hours, setHours };
}

export function useSyncLog(ctx: AddonContext) {
  return useQuery({ queryKey: K.syncLog, queryFn: () => loadSyncLog(ctx) });
}

export function useSyncMutation(ctx: AddonContext) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => runSync(ctx),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: K.syncLog });
      const failed = run.outcomes.filter((o) => o.error);
      const imported = run.outcomes.reduce((acc, o) => acc + o.imported, 0);
      if (run.error) {
        ctx.api.toast.error(`Sync failed: ${run.error}`);
      } else if (failed.length > 0) {
        ctx.api.toast.warning(
          `Sync finished with errors on ${failed.length} account(s) — see the sync log`,
        );
      } else {
        ctx.api.toast.success(`Sync complete: ${imported} activities imported`);
      }
    },
    onError: (error: Error) => ctx.api.toast.error(error.message),
  });
}
