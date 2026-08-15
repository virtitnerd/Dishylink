import { cloudRequest, type CloudRequest, type CloudReply } from "./cloudHost";
import type { RouterWifiConfigUpdate } from "@core/routerWifiConfigUpdate";
import { AccountRequiredError } from "./routerClientUpdate";

/** Send one WifiConfig update through Starlink cloud. Mirrors
 *  applyRouterClientUpdate in routerClientUpdate.ts -- see that file for the
 *  full reasoning; this is the same pattern for WifiConfig-level writes. */
export async function applyRouterWifiConfigUpdate(
  update: RouterWifiConfigUpdate,
  request: (request: CloudRequest) => Promise<CloudReply> = cloudRequest,
): Promise<void> {
  const reply = await request({ path: "/cloud/wifi-config", method: "POST", body: update });
  if (reply.status === 200) return;
  const message = (reply.body as { message?: string })?.message ?? `HTTP ${reply.status}`;
  if (reply.status === 428) throw new AccountRequiredError(message);
  throw new Error(`Starlink rejected the WiFi config update: ${message}`);
}

export async function setRouterCustomDns(nameservers: string[], disabled: boolean): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "dns", nameservers, disabled });
}

export async function setRouterBypassMode(enabled: boolean): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "bypassMode", enabled });
}

export async function setRouterContentFiltering(
  level: 0 | 1 | 2,
  allowDomains?: string[],
): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "contentFiltering", level, allowDomains });
}
