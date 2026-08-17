import { cloudRequest, type CloudRequest, type CloudReply } from "./cloudHost";
import type { NetworkMode, RouterWifiConfigUpdate } from "@core/routerWifiConfigUpdate";
import type {
  HtBandwidth,
  TxPowerLevel,
  VhtBandwidth,
  WifiSecurityType,
  WirelessMode,
} from "@core/dishClient";
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

export async function setRouterContentFiltering(
  level: 0 | 1 | 2,
  allowDomains?: string[],
): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "contentFiltering", level, allowDomains });
}

/** password is required on every call except "open" security -- see
 *  core/routerWifiConfigUpdate.ts's own note on why re-sending the real
 *  password is what keeps a rename from locking every device off the
 *  network. */
export async function setRouterWifiSsid(
  networkDomain: string,
  band: string,
  ssid: string,
  password: string,
  options?: { hidden?: boolean; disable?: boolean; security?: WifiSecurityType },
): Promise<void> {
  await applyRouterWifiConfigUpdate({
    kind: "ssid",
    networkDomain,
    band,
    ssid,
    password,
    ...options,
  });
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
    dnsStaticEntries?: { domains: string[]; addresses: string[] }[];
    dnsForwardRules?: { domains: string[]; serverAddresses: string[] }[];
    staticRoutes?: { subnet: string; gateway: string }[];
  },
): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "networkSettings", networkDomain, ...changes });
}

export async function setRouterAdvanced(changes: {
  disableSandboxFailOpen?: boolean;
  txPowerLevel2ghz?: TxPowerLevel;
  txPowerLevel5ghz?: TxPowerLevel;
  txPowerLevel5ghzHigh?: TxPowerLevel;
  disable2ghz?: boolean;
  disable5ghz?: boolean;
  disable5ghzHigh?: boolean;
  channel2ghz?: number;
  channel5ghz?: number;
  channel5ghzHigh?: number;
  wirelessMode2ghz?: WirelessMode;
  wirelessMode5ghz?: WirelessMode;
  wirelessMode5ghzHigh?: WirelessMode;
  htBandwidth2ghz?: HtBandwidth;
  htBandwidth5ghz?: HtBandwidth;
  htBandwidth5ghzHigh?: HtBandwidth;
  vhtBandwidth?: VhtBandwidth;
  vhtBandwidth5ghzHigh?: VhtBandwidth;
  disableBandSteering?: boolean;
  disableMeshOnboarding?: boolean;
}): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "routerAdvanced", ...changes });
}

export async function setMeshNodeTrust(deviceId: string, trusted: boolean): Promise<void> {
  await applyRouterWifiConfigUpdate({ kind: "meshTrust", deviceId, trusted });
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
