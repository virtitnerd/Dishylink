import type { DishClient } from "./dishClient";

export interface RouterWifiConfigRequestJson {
  targetId: string;
  wifiSetConfig: {
    wifiConfig: Record<string, unknown>;
  };
}

/**
 * Generic partial WifiConfig write via the cloud gateway: any subset of
 * camelCase WifiConfig field names, each paired automatically with its
 * apply<Field> flag -- the same convention starlink_client.py's
 * set_dish_config uses for the local generic write, just re-expressed here
 * as a JSON payload for a cloud-authenticated request instead of a local RPC.
 */
function wifiConfigRequestFor(
  targetId: string,
  changes: Record<string, unknown>,
): RouterWifiConfigRequestJson {
  if (!targetId.startsWith("Router-")) throw new Error("invalid router target id");
  const wifiConfig: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(changes)) {
    wifiConfig[field] = value;
    wifiConfig[`apply${field[0].toUpperCase()}${field.slice(1)}`] = true;
  }
  return { targetId, wifiSetConfig: { wifiConfig } };
}

/**
 * Content filtering (the official app's term) is "sandbox" in the schema --
 * confirmed live against this network: sandboxEnabled=false, sandboxId=0 with
 * no filtering configured. sandboxId isn't a declared protobuf enum (no
 * values_by_name to read labels off), so which integer means "Malware" vs
 * "Malware and Adult content" is inferred, not verified: 0=off (confirmed),
 * 1=Malware, 2=Malware and Adult content, in the same increasing-restriction
 * order the official app lists its three options. Treat as provisional until
 * checked against the app with each option actually selected.
 */
export type ContentFilteringLevel = 0 | 1 | 2;

/**
 * The writes this module knows how to build. "dns" is the one fully verified
 * live (see this project's own notes on why it went first: most recoverable
 * of the settings dishylink excludes from local writes). "bypassMode" is a
 * single unambiguous boolean, low risk to verify the same way.
 * "contentFiltering" additionally overrides any custom DNS the moment it's
 * enabled (confirmed by the account holder against the official app) -- the
 * caller is responsible for surfacing that, this module just builds the
 * request.
 */
export type RouterWifiConfigUpdate =
  | { kind: "dns"; nameservers: string[]; disabled: boolean }
  | { kind: "bypassMode"; enabled: boolean }
  | { kind: "contentFiltering"; level: ContentFilteringLevel; allowDomains?: string[] };

/** Trusted-host preparation, mirroring prepareRouterClientUpdate: source the
 *  target device id directly from the local router immediately before
 *  encoding the cloud write. Content filtering additionally needs the
 *  current networks[] (read-modify-write against a nested repeated field,
 *  same reason set_content_filtering does locally in starlink_client.py). */
export async function prepareRouterWifiConfigUpdate(
  router: DishClient,
  update: RouterWifiConfigUpdate,
): Promise<Uint8Array> {
  const status = await router.getRouterStatus(AbortSignal.timeout(5_000));
  const targetId = status.deviceInfo?.id;
  if (!targetId) throw new Error("Starlink router identity is unavailable");

  if (update.kind === "dns") {
    return router.encodeRequest(
      wifiConfigRequestFor(targetId, {
        nameservers: update.nameservers,
        customDnsDisabled: update.disabled,
      }),
    );
  }

  if (update.kind === "bypassMode") {
    return router.encodeRequest(wifiConfigRequestFor(targetId, { bypassMode: update.enabled }));
  }

  if (update.kind === "contentFiltering") {
    const config = await router.getWifiConfig(AbortSignal.timeout(5_000));
    const networks = (config.networks ?? []).map((network) => ({
      ...network,
      sandboxEnabled: update.level !== 0,
      sandboxId: update.level,
      ...(update.allowDomains !== undefined ? { sandboxDomainAllowList: update.allowDomains } : {}),
    }));
    if (networks.length === 0) throw new Error("router has no configured networks to filter");
    return router.encodeRequest(wifiConfigRequestFor(targetId, { networks }));
  }

  throw new Error(`unhandled update kind`);
}
