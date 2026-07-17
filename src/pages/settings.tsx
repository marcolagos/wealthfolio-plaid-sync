import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import { useState } from "react";
import {
  useAccountMapping,
  useAutoSyncHours,
  useConfigured,
  useCreateAccountMutation,
  useExtendHistoryLinkMutation,
  useHistoryDays,
  useHostedLinkMutation,
  useItems,
  usePlaidAccounts,
  usePlaidEnv,
  usePollHostedLinkMutation,
  useRemoveItemMutation,
  useRemoveSnapTradeAuthorizationMutation,
  useSandboxConnectMutation,
  useSaveCredentialsMutation,
  useSaveMappingMutation,
  useSaveSnapTradeCredentialsMutation,
  useSnapTradeAuthorizations,
  useSnapTradeConfigured,
  useSnapTradePortalMutation,
  useSyncLog,
  useSyncMutation,
  useWealthfolioAccounts,
  type PlaidAccountRow,
} from "../hooks/use-plaid";
import type { AccountMapping, SyncKind } from "../lib/mapping";
import { MAX_HISTORY_DAYS } from "../plaid/client";
import type { PlaidEnv } from "../plaid/types";

const CREATE_OPTION = "__create__";
const IGNORE_OPTION = "__ignore__";
const UNMAPPED_OPTION = "__unmapped__";

function suggestedKind(row: PlaidAccountRow): SyncKind | null {
  if (row.account.type === "investment") return "INVESTMENTS";
  if (row.account.type === "loan") return null;
  return "BANKING";
}

function CredentialsCard({
  ctx,
  compact,
}: {
  ctx: AddonContext;
  compact: boolean;
}) {
  const env = usePlaidEnv(ctx);
  const save = useSaveCredentialsMutation(ctx);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [selectedEnv, setSelectedEnv] = useState<PlaidEnv | null>(null);
  const effectiveEnv: PlaidEnv = selectedEnv ?? env.data ?? "sandbox";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>
            Plaid API credentials{" "}
            {compact && (
              <Badge className="ml-2">Configured ({env.data ?? "…"})</Badge>
            )}
          </span>
        </CardTitle>
        <CardDescription>
          From your Plaid dashboard (Team Settings → Keys). The secret is
          environment-specific; stored in the encrypted secret store.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Select
            value={effectiveEnv}
            onValueChange={(v) => setSelectedEnv(v as PlaidEnv)}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sandbox">Sandbox</SelectItem>
              <SelectItem value="production">Production</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="client_id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-72"
          />
          <Input
            placeholder={compact ? "secret (unchanged)" : "secret"}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="w-72"
          />
          <Button
            onClick={() => save.mutate({ clientId, secret, env: effectiveEnv })}
            disabled={!clientId.trim() || !secret.trim() || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectCard({ ctx }: { ctx: AddonContext }) {
  const env = usePlaidEnv(ctx);
  const sandboxConnect = useSandboxConnectMutation(ctx);
  const hostedLink = useHostedLinkMutation(ctx);
  const pollLink = usePollHostedLinkMutation(ctx);
  const items = useItems(ctx);
  const removeItem = useRemoveItemMutation(ctx);
  const historyDays = useHistoryDays(ctx);
  const extendLink = useExtendHistoryLinkMutation(ctx);
  const [copied, setCopied] = useState(false);
  const [extendCopied, setExtendCopied] = useState(false);
  const [daysInput, setDaysInput] = useState<string | null>(null);

  const linkUrl = hostedLink.data?.hosted_link_url;
  const linkToken = hostedLink.data?.link_token;
  const extendUrl = extendLink.data?.hosted_link_url;
  const extendItemName =
    (items.data ?? []).find((i) => i.itemId === extendLink.variables)
      ?.institutionName ?? "this institution";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Institutions</CardTitle>
        <CardDescription>
          Connect an institution through Plaid Link. Each institution counts as
          one Plaid Item (10 free on the Trial plan). History depth applies to
          new connections and to “Extend history”; institutions cap what they
          actually return.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button
            onClick={() => hostedLink.mutate()}
            disabled={hostedLink.isPending}
          >
            {hostedLink.isPending ? "Creating link…" : "Connect an institution"}
          </Button>
          {env.data === "sandbox" && (
            <Button
              variant="outline"
              onClick={() => sandboxConnect.mutate()}
              disabled={sandboxConnect.isPending}
            >
              {sandboxConnect.isPending
                ? "Connecting…"
                : "Quick connect (sandbox test bank)"}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-muted-foreground text-sm whitespace-nowrap">
              History (days)
            </span>
            <Input
              type="number"
              min={1}
              max={MAX_HISTORY_DAYS}
              className="w-24"
              value={
                daysInput ?? String(historyDays.days.data ?? MAX_HISTORY_DAYS)
              }
              onChange={(e) => setDaysInput(e.target.value)}
              onBlur={() => {
                if (daysInput !== null && daysInput.trim() !== "") {
                  historyDays.setDays.mutate(Number(daysInput));
                }
                setDaysInput(null);
              }}
            />
          </div>
        </div>

        {linkUrl && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm">
              Open this link in your browser, sign in to your institution, then
              come back and press <strong>Check connection</strong>:
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={linkUrl} className="flex-1 text-xs" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(linkUrl)
                    .then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                size="sm"
                onClick={() => linkToken && pollLink.mutate(linkToken)}
                disabled={pollLink.isPending}
              >
                {pollLink.isPending ? "Checking…" : "Check connection"}
              </Button>
            </div>
          </div>
        )}

        {(items.data ?? []).length > 0 && (
          <div className="space-y-1">
            {(items.data ?? []).map((item) => (
              <div
                key={item.itemId}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <span className="text-sm">
                  {item.institutionName ?? item.itemId}{" "}
                  <Badge variant="outline" className="ml-1">
                    {item.env}
                  </Badge>
                </span>
                <span className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => extendLink.mutate(item.itemId)}
                    disabled={extendLink.isPending}
                  >
                    Extend history
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeItem.mutate(item.itemId)}
                    disabled={removeItem.isPending}
                  >
                    Remove
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}

        {extendUrl && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm">
              To pull up to {historyDays.days.data ?? MAX_HISTORY_DAYS} days of
              history for <strong>{extendItemName}</strong>, open this link in
              your browser and confirm the connection. Plaid backfills in the
              background — run <strong>Sync now</strong> a few minutes later to
              import the older transactions.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={extendUrl} className="flex-1 text-xs" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(extendUrl)
                    .then(() => setExtendCopied(true));
                }}
              >
                {extendCopied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SnapTradeCard({
  ctx,
  compact,
}: {
  ctx: AddonContext;
  compact: boolean;
}) {
  const save = useSaveSnapTradeCredentialsMutation(ctx);
  const auths = useSnapTradeAuthorizations(ctx, compact);
  const portal = useSnapTradePortalMutation(ctx);
  const removeAuth = useRemoveSnapTradeAuthorizationMutation(ctx);
  const [clientId, setClientId] = useState("");
  const [consumerKey, setConsumerKey] = useState("");
  const [copied, setCopied] = useState(false);

  const portalUrl = portal.data?.redirectURI;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>
            SnapTrade brokerages{" "}
            {compact && <Badge className="ml-2">Configured</Badge>}
          </span>
        </CardTitle>
        <CardDescription>
          Brokerage connections (Robinhood, Fidelity, E*Trade, Schwab…) with
          broker-complete history. Keys come from the SnapTrade dashboard; the
          free tier covers 5 connections.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Input
            placeholder="client_id (PERS-…)"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-72"
          />
          <Input
            placeholder={compact ? "consumer key (unchanged)" : "consumer key"}
            type="password"
            value={consumerKey}
            onChange={(e) => setConsumerKey(e.target.value)}
            className="w-72"
          />
          <Button
            onClick={() => save.mutate({ clientId, consumerKey })}
            disabled={!clientId.trim() || !consumerKey.trim() || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>

        {compact && (
          <>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => portal.mutate()}
                disabled={portal.isPending}
              >
                {portal.isPending ? "Creating link…" : "Connect a brokerage"}
              </Button>
            </div>

            {portalUrl && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm">
                  Open this link in your browser and sign in to your brokerage.
                  Connected accounts appear in the table below (allow a minute
                  for SnapTrade's first data sync).
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={portalUrl}
                    className="flex-1 text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(portalUrl)
                        .then(() => setCopied(true));
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
            )}

            {(auths.data ?? []).length > 0 && (
              <div className="space-y-1">
                {(auths.data ?? []).map((auth) => (
                  <div
                    key={auth.id}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <span className="text-sm">
                      {auth.brokerage?.name ?? auth.id}{" "}
                      {auth.disabled && (
                        <Badge variant="destructive" className="ml-1">
                          disconnected
                        </Badge>
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeAuth.mutate(auth.id)}
                      disabled={removeAuth.isPending}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MappingRow({
  ctx,
  row,
  mapping,
  wfAccounts,
  onSave,
}: {
  ctx: AddonContext;
  row: PlaidAccountRow;
  mapping: AccountMapping;
  wfAccounts: { id: string; name: string; currency: string }[];
  onSave: (mapping: AccountMapping) => void;
}) {
  const createAccount = useCreateAccountMutation(ctx);
  const plaidId = row.account.account_id;
  const link = mapping.links[plaidId];
  const isIgnored = mapping.ignored.includes(plaidId);
  const kind = link?.kind ?? suggestedKind(row);
  const selectValue = isIgnored
    ? IGNORE_OPTION
    : (link?.wfAccountId ?? UNMAPPED_OPTION);
  const currency = row.account.balances.iso_currency_code ?? "USD";
  // SnapTrade account names are broker-generic ("ROTH IRA") — prefix the
  // institution so rows and created accounts are distinguishable (unless the
  // broker already includes it, e.g. "Robinhood Individual").
  const institution = row.institutionName ?? "";
  const displayName =
    row.provider === "snaptrade" &&
    institution &&
    !row.account.name.toLowerCase().includes(institution.toLowerCase())
      ? `${institution} ${row.account.name}`
      : row.account.name;

  const applyTarget = async (value: string) => {
    if (!kind) return;
    const next: AccountMapping = {
      links: { ...mapping.links },
      ignored: mapping.ignored.filter((id) => id !== plaidId),
    };
    if (value === IGNORE_OPTION) {
      delete next.links[plaidId];
      next.ignored.push(plaidId);
    } else if (value === UNMAPPED_OPTION) {
      delete next.links[plaidId];
    } else if (value === CREATE_OPTION) {
      const created = await createAccount.mutateAsync({
        name: displayName.slice(0, 50),
        accountType:
          kind === "INVESTMENTS"
            ? "SECURITIES"
            : row.account.type === "credit"
              ? "CREDIT_CARD"
              : "CASH",
        currency,
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
        provider: row.provider,
        providerAccountId: plaidId,
        group: row.institutionName,
      });
      next.links[plaidId] = {
        wfAccountId: created.id,
        kind,
        itemId: row.itemId,
        provider: row.provider,
      };
      ctx.api.toast.success(`Created account "${created.name}"`);
    } else {
      next.links[plaidId] = {
        wfAccountId: value,
        kind,
        itemId: row.itemId,
        provider: row.provider,
      };
    }
    onSave(next);
  };

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{displayName}</div>
        <div className="text-muted-foreground text-xs">
          {row.provider === "snaptrade" ? "snaptrade · " : ""}
          {row.account.type}
          {row.account.subtype ? ` · ${row.account.subtype}` : ""}
          {row.account.mask ? ` · …${row.account.mask}` : ""}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {row.account.balances.current ?? "—"} {currency}
      </TableCell>
      <TableCell>
        {kind ? (
          <Select
            value={selectValue}
            onValueChange={(v) => void applyTarget(v)}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNMAPPED_OPTION}>Not synced</SelectItem>
              <SelectItem value={CREATE_OPTION}>Create new account…</SelectItem>
              {wfAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </SelectItem>
              ))}
              <SelectItem value={IGNORE_OPTION}>Ignore</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Badge variant="outline">Loans not supported</Badge>
        )}
      </TableCell>
      <TableCell>
        {kind ? (
          <Badge variant="outline">
            {kind === "INVESTMENTS" ? "Investments" : "Banking"}
          </Badge>
        ) : (
          "—"
        )}
      </TableCell>
    </TableRow>
  );
}

function AccountsCard({ ctx }: { ctx: AddonContext }) {
  const plaidAccounts = usePlaidAccounts(ctx, true);
  const wfAccounts = useWealthfolioAccounts(ctx);
  const mapping = useAccountMapping(ctx);
  const saveMapping = useSaveMappingMutation(ctx);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <CardDescription>
          Map each Plaid account to a Wealthfolio account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {plaidAccounts.isLoading ||
        mapping.isLoading ||
        wfAccounts.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : plaidAccounts.isError ? (
          <p className="text-destructive text-sm">
            {(plaidAccounts.error as Error).message}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plaid account</TableHead>
                <TableHead>Balance</TableHead>
                <TableHead>Syncs to</TableHead>
                <TableHead>Mode</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(plaidAccounts.data ?? []).map((row) => (
                <MappingRow
                  key={row.account.account_id}
                  ctx={ctx}
                  row={row}
                  mapping={mapping.data ?? { links: {}, ignored: [] }}
                  wfAccounts={wfAccounts.data ?? []}
                  onSave={(m) => saveMapping.mutate(m)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SyncCard({ ctx, hasLinks }: { ctx: AddonContext; hasLinks: boolean }) {
  const sync = useSyncMutation(ctx);
  const log = useSyncLog(ctx);
  const autoSync = useAutoSyncHours(ctx);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync</CardTitle>
        <CardDescription>
          Import transactions for mapped accounts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button
            onClick={() => sync.mutate()}
            disabled={!hasLinks || sync.isPending}
            title={hasLinks ? undefined : "Map at least one account first"}
          >
            {sync.isPending ? "Syncing…" : "Sync now"}
          </Button>
          <Select
            value={String(autoSync.hours.data ?? 24)}
            onValueChange={(v) => autoSync.setHours.mutate(Number(v))}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Auto-sync off (manual only)</SelectItem>
              <SelectItem value="6">Auto-sync every 6 hours</SelectItem>
              <SelectItem value="12">Auto-sync every 12 hours</SelectItem>
              <SelectItem value="24">Auto-sync daily</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {(log.data ?? []).length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Recent runs</h3>
            {(log.data ?? []).slice(0, 5).map((run) => (
              <div key={run.at} className="rounded-md border p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {new Date(run.at).toLocaleString()}
                  </span>
                  {run.error || run.outcomes.some((o) => o.error) ? (
                    <Badge variant="destructive">Errors</Badge>
                  ) : (
                    <Badge variant="secondary">OK</Badge>
                  )}
                </div>
                {run.error && (
                  <p className="text-destructive mt-1">{run.error}</p>
                )}
                {run.outcomes.map((o) => (
                  <p key={o.plaidAccountId} className="mt-1">
                    {o.name}:{" "}
                    {o.error ? (
                      <span className="text-destructive">{o.error}</span>
                    ) : (
                      `${o.imported} imported, ${o.duplicates} duplicates${o.skippedRows ? `, ${o.skippedRows} skipped` : ""}`
                    )}
                    {!o.error && o.note && (
                      <span className="text-muted-foreground"> — {o.note}</span>
                    )}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SettingsPage({ ctx }: { ctx: AddonContext }) {
  const configured = useConfigured(ctx);
  const snapConfigured = useSnapTradeConfigured(ctx);
  const items = useItems(ctx);
  const mapping = useAccountMapping(ctx);
  const hasItems = (items.data ?? []).length > 0;
  const hasLinks = Object.keys(mapping.data?.links ?? {}).length > 0;
  const showAccounts = Boolean(
    (configured.data && hasItems) || snapConfigured.data,
  );

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Account Sync</h1>
        <p className="text-muted-foreground">
          Auto-sync bank, credit, and brokerage accounts via Plaid and
          SnapTrade.
        </p>
      </div>
      {configured.isLoading || snapConfigured.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <CredentialsCard ctx={ctx} compact={Boolean(configured.data)} />
          {configured.data && <ConnectCard ctx={ctx} />}
          <SnapTradeCard ctx={ctx} compact={Boolean(snapConfigured.data)} />
          {showAccounts && <AccountsCard ctx={ctx} />}
          {showAccounts && <SyncCard ctx={ctx} hasLinks={hasLinks} />}
        </>
      )}
    </div>
  );
}
