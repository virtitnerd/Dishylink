import type {
  DishClient,
  HtBandwidth,
  TxPowerLevel,
  VhtBandwidth,
  WifiLanNetworkJson,
  WifiSecurityType,
  WirelessMode,
} from "./dishClient";

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
 * The official app's "Network mode" selector, confirmed live against this
 * router's two networks: Default is guest=false/clientIsolation=false
 * (ElonsWorld), Guest is guest=true/clientIsolation=true (TheWire-EXT) --
 * matching the app's own description of Guest ("devices can't communicate
 * with each other"). Auto ("active only when internet is available") is
 * inferred to be disableWhenOffline=true with guest/clientIsolation left at
 * their Default values -- the field name and the app's own description line
 * up, but this specific combination hasn't been confirmed live the way
 * Default and Guest have.
 */
export type NetworkMode = "default" | "guest" | "auto";

const NETWORK_MODE_FIELDS: Record<NetworkMode, Partial<WifiLanNetworkJson>> = {
  default: { guest: false, clientIsolation: false, disableWhenOffline: false },
  guest: { guest: true, clientIsolation: true, disableWhenOffline: false },
  auto: { guest: false, clientIsolation: false, disableWhenOffline: true },
};

/** Reads a network's current fields back into the mode it matches, or null if
 *  it's some other combination the three presets don't cover (a network the
 *  official app didn't create, or one already edited through the advanced
 *  fields this app additionally exposes). */
export function networkModeOf(network: WifiLanNetworkJson): NetworkMode | null {
  for (const [mode, fields] of Object.entries(NETWORK_MODE_FIELDS) as [
    NetworkMode,
    Partial<WifiLanNetworkJson>,
  ][]) {
    if (Object.entries(fields).every(([key, value]) => (network as never)[key] === value))
      return mode;
  }
  return null;
}

/** Every predefined subnet the official app offers -- confirmed against it
 *  directly, not inferred. Picking one of these (rather than accepting any
 *  CIDR) is what keeps network creation from being able to produce something
 *  that collides with an existing network or is otherwise malformed. */
export const SUBNET_OPTIONS = [
  "192.168.1.1/24",
  "192.168.2.1/24",
  "192.168.3.1/24",
  "192.168.4.1/24",
  "10.0.0.1/16",
  "10.1.0.1/16",
  "10.2.0.1/16",
  "10.3.0.1/16",
] as const;

/** domain/vlan aren't user-facing anywhere in the official app -- it must
 *  allocate them itself when a network is created there. Mirrored here from
 *  the pattern actually observed on this router: "lan"/"lan1", vlan
 *  100/200 -- first unused "lan<N>" and first unused multiple of 100. */
function nextDomain(networks: WifiLanNetworkJson[]): string {
  const used = new Set(networks.map((n) => n.domain).filter(Boolean));
  if (!used.has("lan")) return "lan";
  let i = 1;
  while (used.has(`lan${i}`)) i++;
  return `lan${i}`;
}

function nextVlan(networks: WifiLanNetworkJson[]): number {
  const used = new Set(networks.map((n) => n.vlan).filter((v): v is number => v != null));
  let vlan = 100;
  while (used.has(vlan)) vlan += 100;
  return vlan;
}

/**
 * The writes this module knows how to build. "dns" is the one fully verified
 * live (see this project's own notes on why it went first: most recoverable
 * of the settings dishylink excludes from local writes). "bypassMode" is a
 * single unambiguous boolean -- but the *consequence* of turning it on is
 * severe (this router's own WiFi drops immediately, recoverable only via a
 * factory reset from the Starlink app), so the caller must arm a real
 * confirmation before sending it, not just disable-while-saving.
 * "contentFiltering" additionally overrides any custom DNS the moment it's
 * enabled (confirmed by the account holder against the official app) -- the
 * caller is responsible for surfacing that, this module just builds the
 * request. "ssid" changes one band's name/password/visibility within one
 * network -- see its own note below on why password is required, not
 * optional, and why networkDomain matters even though band alone looks like
 * it should be enough. "networkSettings" is mode + subnet + the DHCP/DNS
 * fields the official app doesn't expose at all (offered here as advanced
 * options). "addNetwork"/"deleteNetwork" are additive/destructive on the
 * whole networks[] array -- the first network (index 0) can be modified but
 * never deleted, same as the official app.
 */
export type RouterWifiConfigUpdate =
  | { kind: "dns"; nameservers: string[]; disabled: boolean }
  | { kind: "bypassMode"; enabled: boolean }
  | { kind: "contentFiltering"; level: ContentFilteringLevel; allowDomains?: string[] }
  | {
      kind: "ssid";
      networkDomain: string;
      band: string;
      ssid: string;
      /** Required for every security type except "open", where the schema's
       *  auth_open sub-message carries no fields at all. */
      password: string;
      hidden?: boolean;
      /** Turns this one band off without deleting it -- distinct from hidden,
       *  which keeps broadcasting but drops the SSID from scan lists. */
      disable?: boolean;
      /** Defaults to "wpa2" (unchanged) when omitted -- see WifiSecurityType. */
      security?: WifiSecurityType;
    }
  | {
      kind: "networkSettings";
      networkDomain: string;
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
    }
  | {
      kind: "addNetwork";
      ssid: string;
      password: string;
      ipv4: string;
      mode: NetworkMode;
      hidden?: boolean;
    }
  | { kind: "deleteNetwork"; networkDomain: string }
  /** Flat WifiConfig-level radio/onboarding knobs -- no read-modify-write
   *  needed (unlike everything touching networks[]), since each field carries
   *  its own apply_<field> flag the same as "dns"/"bypassMode" do. */
  | {
      kind: "routerAdvanced";
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
    }
  /** Trust/untrust one paired mesh node -- a map entry update (meshConfigs is
   *  keyed by deviceId), so it needs the same read-modify-write as networks[]. */
  | { kind: "meshTrust"; deviceId: string; trusted: boolean };

/** Builds exactly the one auth_* sub-message a security type needs -- open
 *  carries no fields at all, everything else just carries the password. */
function authFieldsFor(security: WifiSecurityType | undefined, password: string): Record<string, unknown> {
  if (security === "wpa3") return { authWpa3: { password } };
  if (security === "wpa2wpa3") return { authWpa2Wpa3: { password } };
  if (security === "open") return { authOpen: {} };
  return { authWpa2: { password } };
}

/** Trusted-host preparation, mirroring prepareRouterClientUpdate: source the
 *  target device id directly from the local router immediately before
 *  encoding the cloud write. Every kind past "dns"/"bypassMode" needs the
 *  current networks[] -- read-modify-write against a nested repeated field,
 *  same reason set_content_filtering/set_wifi_ssid do locally in
 *  starlink_client.py. */
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

  if (update.kind === "ssid") {
    // Same read-modify-write, and the same password requirement, as
    // set_wifi_ssid does locally in starlink_client.py: the router masks
    // passwords on read ("•••••"), so a write that only wanted to rename the
    // SSID and left the existing (masked) basicServiceSet untouched would
    // write the literal string "•••••" as the new password -- locking every
    // device off the network. Always resupplying the real password removes
    // the ambiguity; that's why it's required here, not optional.
    //
    // networkDomain matters because band alone isn't unique: RF_2GHZ and
    // RF_5GHZ each exist once per network, so matching on band across the
    // whole networks[] array (an earlier version of this function did
    // exactly that) would rename the same band on every network at once,
    // not just the one the caller meant.
    const config = await router.getWifiConfig(AbortSignal.timeout(5_000));
    let matched = false;
    const networks = (config.networks ?? []).map((network) => {
      if (network.domain !== update.networkDomain) return network;
      return {
        ...network,
        basicServiceSets: (network.basicServiceSets ?? []).map((bss) => {
          if (bss.band !== update.band) return bss;
          matched = true;
          // The auth_* fields are a oneof -- strip every variant the read
          // brought back before setting exactly the one this write wants, or
          // a stale authWpa2 would ride along next to a fresh authWpa3.
          const { authWpa2: _wpa2, authWpa3: _wpa3, authWpa2Wpa3: _mixed, authOpen: _open, ...bare } = bss;
          return {
            ...bare,
            ssid: update.ssid,
            ...authFieldsFor(update.security, update.password),
            ...(update.hidden !== undefined ? { hidden: update.hidden } : {}),
            ...(update.disable !== undefined ? { disable: update.disable } : {}),
          };
        }),
      };
    });
    if (!matched)
      throw new Error(`no network "${update.networkDomain}" with band ${update.band} found`);
    return router.encodeRequest(wifiConfigRequestFor(targetId, { networks }));
  }

  if (update.kind === "networkSettings") {
    const config = await router.getWifiConfig(AbortSignal.timeout(5_000));
    let matched = false;
    const networks = (config.networks ?? []).map((network) => {
      if (network.domain !== update.networkDomain) return network;
      matched = true;
      return {
        ...network,
        ...(update.mode !== undefined ? NETWORK_MODE_FIELDS[update.mode] : {}),
        ...(update.ipv4 !== undefined ? { ipv4: update.ipv4 } : {}),
        ...(update.dhcpv4Start !== undefined ? { dhcpv4Start: update.dhcpv4Start } : {}),
        ...(update.dhcpv4End !== undefined ? { dhcpv4End: update.dhcpv4End } : {}),
        ...(update.dhcpv4LeaseDurationS !== undefined
          ? { dhcpv4LeaseDurationS: update.dhcpv4LeaseDurationS }
          : {}),
        ...(update.dhcpDisabled !== undefined ? { dhcpDisabled: update.dhcpDisabled } : {}),
        ...(update.dnsDisabled !== undefined ? { dnsDisabled: update.dnsDisabled } : {}),
        ...(update.dnsStaticEntries !== undefined ? { dnsStaticEntries: update.dnsStaticEntries } : {}),
        ...(update.dnsForwardRules !== undefined ? { dnsForwardRules: update.dnsForwardRules } : {}),
        ...(update.staticRoutes !== undefined ? { staticRoutes: update.staticRoutes } : {}),
      };
    });
    if (!matched) throw new Error(`no network "${update.networkDomain}" found`);
    return router.encodeRequest(wifiConfigRequestFor(targetId, { networks }));
  }

  if (update.kind === "addNetwork") {
    const config = await router.getWifiConfig(AbortSignal.timeout(5_000));
    const existing = config.networks ?? [];
    const domain = nextDomain(existing);
    const vlan = nextVlan(existing);
    const newNetwork: WifiLanNetworkJson = {
      domain,
      vlan,
      ipv4: update.ipv4,
      dhcpv4Start: 20,
      dhcpv4End: 254,
      dhcpv4LeaseDurationS: 3600,
      ...NETWORK_MODE_FIELDS[update.mode],
      // bssid is deliberately omitted -- every bssid on this router shares
      // the locally-administered-MAC bit pattern the IEEE reserves for
      // software-generated addresses, which points at the router assigning
      // them itself rather than expecting a caller to invent one (and
      // inventing a colliding or malformed one is a worse failure mode than
      // leaving the field for the router to fill in).
      basicServiceSets: [
        { band: "RF_2GHZ", ssid: update.ssid, authWpa2: { password: update.password }, hidden: update.hidden ?? false },
        { band: "RF_5GHZ", ssid: update.ssid, authWpa2: { password: update.password }, hidden: update.hidden ?? false },
      ],
    };
    return router.encodeRequest(wifiConfigRequestFor(targetId, { networks: [...existing, newNetwork] }));
  }

  if (update.kind === "deleteNetwork") {
    const config = await router.getWifiConfig(AbortSignal.timeout(5_000));
    const existing = config.networks ?? [];
    if (existing[0]?.domain === update.networkDomain)
      throw new Error("the first network can't be deleted, only modified");
    const networks = existing.filter((network) => network.domain !== update.networkDomain);
    if (networks.length === existing.length)
      throw new Error(`no network "${update.networkDomain}" found`);
    return router.encodeRequest(wifiConfigRequestFor(targetId, { networks }));
  }

  if (update.kind === "routerAdvanced") {
    // Flat WifiConfig fields, each with its own apply_<field> flag -- no read
    // needed, same as "dns"/"bypassMode" above.
    const { kind: _kind, disableMeshOnboarding, ...changes } = update;
    const allChanges: Record<string, unknown> = { ...changes };
    // The schema splits wired vs wireless mesh pairing into two flags; the UI
    // offers one "lock mesh onboarding" toggle, so both are set together.
    if (disableMeshOnboarding !== undefined) {
      allChanges.disableMeshOnboarding = disableMeshOnboarding;
      allChanges.disableWirelessMeshOnboarding = disableMeshOnboarding;
    }
    if (Object.keys(allChanges).length === 0) throw new Error("no changes given");
    return router.encodeRequest(wifiConfigRequestFor(targetId, allChanges));
  }

  if (update.kind === "meshTrust") {
    // meshConfigs is a map keyed by deviceId -- read-modify-write the one
    // entry, same reason networks[] needs it (the write replaces whichever
    // fields are sent, and a map can't be partially indexed into by the
    // schema's apply_meshConfigs flag alone).
    const config = await router.getWifiConfig(AbortSignal.timeout(5_000));
    const existing = config.meshConfigs ?? {};
    const node = existing[update.deviceId];
    if (!node) throw new Error(`no mesh node "${update.deviceId}" found`);
    const meshConfigs = {
      ...existing,
      [update.deviceId]: { ...node, auth: update.trusted ? "MESH_AUTH_TRUSTED" : "MESH_AUTH_UNTRUSTED" },
    };
    return router.encodeRequest(wifiConfigRequestFor(targetId, { meshConfigs }));
  }

  throw new Error(`unhandled update kind`);
}
