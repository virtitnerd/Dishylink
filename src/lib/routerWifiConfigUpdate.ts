import { cloudRequest, type CloudRequest, type CloudReply } from "./cloudHost";
import type { NetworkMode, RouterWifiConfigUpdate } from "@core/routerWifiConfigUpdate";
import { AccountRequiredError } from "./routerClientUpdate";

export { SUBNET_OPTIONS, networkModeOf, type NetworkMode } from "@core/routerWifiConfigUpdate";

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

/** password is required on every call, not optional -- see
 *  core/routerWifiConfigUpdate.ts's own note on why re-sending the real
 *  password is what keeps a rename from locking every device off the
 *  network. */
export async function setRouterWifiSsid(
  networkDomain: string,
  band: string,
  ssid: string,
  password: string,
  hidden?: boolean,
): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "ssid", networkDomain, band, ssid, password, hidden });
}

export async function setRouterNetworkSettings(
  networkDomain: string,
  changes: {
    mode?: NetworkMode;
    ipv4?: string;
    dhcpv4Start?: number;
    dhcpv4End?: number;
    dhcpv4LeaseDurationS?: number;
    dhcpDisabled?: boolean;
    dnsDisabled?: boolean;
  },
): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "networkSettings", networkDomain, ...changes });
}

export async function addRouterNetwork(
  ssid: string,
  password: string,
  ipv4: string,
  mode: NetworkMode,
  hidden?: boolean,
): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "addNetwork", ssid, password, ipv4, mode, hidden });
}

export async function deleteRouterNetwork(networkDomain: string): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "deleteNetwork", networkDomain });
}
