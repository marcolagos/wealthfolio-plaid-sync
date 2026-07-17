import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { SettingsPage } from "./pages/settings";
import { maybeAutoSync } from "./sync/auto-sync";

// The host owns a single React root per addon and mounts the route `component`
// itself with no access to the addon context. Capture it at enable time so the
// route wrapper can hand it down. (Do NOT call createRoot yourself.)
let addonCtx: AddonContext | undefined;

const AddonRoute = () => (
  <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}>
    <SettingsPage ctx={addonCtx!} />
  </QueryClientProvider>
);

// This addon intentionally declares NO `contributes.routes` in manifest.json:
// pinned addons boot eagerly at app startup, which is what lets enable() run
// the auto-sync check on every launch. Route + sidebar are registered here.
const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  ctx.router.add({
    id: "plaid-sync",
    path: "/addons/plaid-sync",
    component: AddonRoute,
  });

  const sidebarItem = ctx.sidebar.addItem({
    id: "plaid-sync",
    label: "Account Sync",
    icon: "credit-card",
    route: "/addons/plaid-sync",
    order: 101,
  });

  // Fire-and-forget: syncs only when the last run is older than the
  // configured interval, so an app restart doesn't re-hit Plaid.
  void maybeAutoSync(ctx);

  ctx.onDisable(() => {
    sidebarItem.remove();
    addonCtx = undefined;
  });
};

export default enable;
