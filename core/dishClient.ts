// Client for the Starlink dish/router local API -- fetched as plain JSON from
// our own FastAPI backend (server.py + starlink_client.py), which does the
// actual gRPC/gRPC-Web work server-side via dynamic reflection (no vendored
// proto files to keep in sync). This file used to speak grpc-web directly to
// the dish/router from the browser; that's now server.py's job. Every method
// signature and return type below is unchanged, so no calling component had
// to change -- only the transport underneath did.
//
// The one exception is encodeRequest: it doesn't make a local call at all, it
// builds the raw protobuf bytes an authenticated host sends through the cloud
// gateway (see core/routerClientUpdate.ts) -- for that it still needs the
// schema dumped from the dish's reflection service, loaded lazily so the
// (much more common) local-only calls above never pay for a fetch they don't
// need.

import {
  createFileRegistry,
  fromBinary,
  fromJson,
  toBinary,
  type DescMessage,
  type JsonValue,
  type Registry,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

async function parseRequestSchema(
  protosetBytes: Uint8Array,
): Promise<{ requestSchema: DescMessage; registry: Registry }> {
  const fileDescriptorSet = fromBinary(FileDescriptorSetSchema, protosetBytes);
  const registry = createFileRegistry(fileDescriptorSet);
  const requestSchema = registry.getMessage("SpaceX.API.Device.Request");
  if (!requestSchema) throw new Error("Device Request missing from dish.protoset");
  return { requestSchema, registry };
}

let requestSchemaPromise: Promise<{ requestSchema: DescMessage; registry: Registry }> | null = null;

/** Browser fallback: a relative fetch resolves fine against the page's own
 *  origin. Node-side callers (no page origin to resolve against) supply
 *  protosetBytes to DishClient.load() instead -- see its own note. */
function loadRequestSchema(): Promise<{ requestSchema: DescMessage; registry: Registry }> {
  requestSchemaPromise ??= (async () => {
    const protosetResponse = await fetch("/dish.protoset");
    return parseRequestSchema(new Uint8Array(await protosetResponse.arrayBuffer()));
  })();
  return requestSchemaPromise;
}

// The FastAPI backend's own address. Same-origin by default (it also serves
// this app's built static files); override for a dev setup where the two run
// on different ports.
let apiBase = "/api";

/** Called once by a host entry point, before the UI renders, if the backend
 *  isn't same-origin (e.g. `npm run dev` against a separately-run server.py). */
export function setApiBase(base: string): void {
  apiBase = base.replace(/\/$/, "");
}

/** The router's LAN address — the only one it answers on, which is what makes it
 *  collidable with another router's default. lib/routerDiagnosis turns a failure
 *  to reach it into the one wording every surface reports. */
export const ROUTER_LAN_ADDRESS = "192.168.1.1";
export const ROUTER_LAN_HANDLE_URL = `http://${ROUTER_LAN_ADDRESS}:9001/SpaceX.API.Device.Device/Handle`;

/**
 * @deprecated No-op kept only so the Electron/extension entry points (which
 * bind a direct grpc-web host during their own bootstrap) keep compiling.
 * This fork's web build talks to our own FastAPI backend (see setApiBase)
 * instead of a grpc-web proxy, so a dish/router host binding has nothing to
 * do here. Not wired into the web target yet.
 */
export function setDishHost(_binding: {
  dishHandleUrl?: string;
  routerHandleUrl?: string;
  protosetUrl?: string;
}): void {}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function apiGet<T>(path: string, abortSignal?: AbortSignal): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, { signal: abortSignal });
  const payload = (await res.json()) as ApiEnvelope<T>;
  if (!payload.ok) throw new Error(payload.error ?? `${path} failed`);
  return payload.data as T;
}

async function apiPost<T>(path: string, body?: unknown, abortSignal?: AbortSignal): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: abortSignal,
  });
  const payload = (await res.json()) as ApiEnvelope<T>;
  if (!payload.ok) throw new Error(payload.error ?? `${path} failed`);
  return payload.data as T;
}

// ---------- response JSON shapes (proto3 JSON mapping; uint64 → string) ----------

export interface DishDeviceInfoJson {
  id?: string;
  hardwareVersion?: string;
  softwareVersion?: string;
  countryCode?: string;
  bootcount?: number;
}

export interface DishObstructionStatsJson {
  fractionObstructed?: number;
  validS?: number;
  avgProlongedObstructionIntervalS?: number | "NaN" | "Infinity";
  patchesValid?: number;
}

export interface DishAlignmentStatsJson {
  tiltAngleDeg?: number;
  boresightAzimuthDeg?: number;
  boresightElevationDeg?: number;
  desiredBoresightAzimuthDeg?: number;
  desiredBoresightElevationDeg?: number;
  attitudeEstimationState?: string;
  attitudeUncertaintyDeg?: number;
  /** "HAS_ACTUATORS_NO" on electronically-steered kits, "HAS_ACTUATORS_YES" on motorized. */
  hasActuators?: string;
  /** What the motors are doing ("ACTUATOR_STATE_TILT", …). Absent means the zero
   *  value, ACTUATOR_STATE_IDLE — which is why a dish that sends nothing here
   *  still reads "Idle" in the official app. */
  actuatorState?: string;
}

export interface DishGpsStatsJson {
  gpsValid?: boolean;
  gpsSats?: number;
  /** Position/navigation filter state, e.g. "FILTER_CONVERGED". */
  pntFilterConvergenceState?: string;
}

/** The dish's orientation as a unit quaternion (NED → dish frame). */
export interface DishQuaternionJson {
  qScalar?: number;
  qX?: number;
  qY?: number;
  qZ?: number;
}

/** Per-subsystem readiness flags; all true = fully online. */
export interface DishReadyStatesJson {
  scp?: boolean;
  l1l2?: boolean;
  xphy?: boolean;
  aap?: boolean;
  rf?: boolean;
}

export interface DishStatusJson {
  deviceInfo?: DishDeviceInfoJson;
  deviceState?: { uptimeS?: string };
  obstructionStats?: DishObstructionStatsJson;
  alerts?: Record<string, boolean>;
  downlinkThroughputBps?: number;
  uplinkThroughputBps?: number;
  popPingLatencyMs?: number;
  popPingDropRate?: number;
  boresightAzimuthDeg?: number;
  boresightElevationDeg?: number;
  stowRequested?: boolean;
  gpsStats?: DishGpsStatsJson;
  ethSpeedMbps?: number;
  classOfService?: string;
  softwareUpdateState?: string;
  alignmentStats?: DishAlignmentStatsJson;
  connectedRouters?: string[];
  /** Routers the dish is currently talking to, keyed by the same DeviceId the
   *  cloud telemetry uses ("Router-<hex>"), with the dish's own view of when it
   *  last heard from each. The account panel reads this so a mesh node — which
   *  has no LAN address of its own to poll — still gets a live dot rather than
   *  waiting on the cloud's ~2-minute upload cycle. A node that is down is
   *  dropped from the map entirely (verified 2026-07-29: a mesh unit dark for
   *  2.7 days was absent while the controller was listed). */
  downstreamRouters?: Record<string, { role?: string; lastSeen?: string }>;
  dlBandwidthRestrictedReason?: string;
  ulBandwidthRestrictedReason?: string;
  isSnrAboveNoiseFloor?: boolean;
  /** Set when SNR has stayed low long enough to look like weather, not a blip —
   *  the flag behind the dish's own RAIN_SNR_PERSISTENTLY_LOW alert. Absent
   *  (proto3 drops false) means the signal is holding. */
  isSnrPersistentlyLow?: boolean;
  /** Per-subsystem online flags — which stage is up while the dish boots. */
  readyStates?: DishReadyStatesJson;
  /** Seconds until a pending software-update reboot is possible; −1 = none pending. */
  secondsUntilSwupdateRebootPossible?: number;
  /** NAT state, e.g. "NAT_DISABLED" in bypass mode. */
  natFlag?: string;
  /** Dish attitude as a quaternion — more precise than the two boresight angles. */
  ned2dishQuaternion?: DishQuaternionJson;
  /** Motorized ("HAS_ACTUATORS_YES") vs electronically-steered ("HAS_ACTUATORS_NO"). */
  hasActuators?: string;
  /** How the kit is licensed to move: "STATIONARY", "NOMADIC" or "MOBILE".
   *  Absent means STATIONARY — proto3 drops the zero value — which is why a
   *  fixed install never sends it. A MOBILE kit is allowed to aim all the way to
   *  zenith, so the alignment band ceiling depends on this. */
  mobilityClass?: string;
}

export interface DishOutageJson {
  cause?: string;
  startTimestampNs?: string;
  durationNs?: string;
  didSwitch?: boolean;
}

export interface DishEventJson {
  severity?: string;
  reason?: string;
  startTimestampNs?: string;
  durationNs?: string;
}

export interface DishHistoryJson {
  current?: string | number;
  popPingDropRate?: number[];
  popPingLatencyMs?: number[];
  downlinkThroughputBps?: number[];
  uplinkThroughputBps?: number[];
  powerIn?: number[];
  outages?: DishOutageJson[];
  eventLog?: { events?: DishEventJson[] };
}

export interface DishLocationJson {
  lla?: { lat?: number; lon?: number; alt?: number };
  source?: string;
}

export interface DishObstructionMapJson {
  numRows?: number;
  numCols?: number;
  snr?: number[];
  maxThetaDeg?: number;
}

// ---------- config / diagnostics shapes ----------

export type SnowMeltMode = "AUTO" | "ALWAYS_ON" | "ALWAYS_OFF";

/** Writable dish knobs (proto3 JSON field names). Every set is partial: only
    the fields present are applied, via their matching apply_* flags. */
export interface DishConfigJson {
  snowMeltMode?: SnowMeltMode;
  locationRequestMode?: "NONE" | "LOCAL";
  /** Whether the dish tilts to compensate for a non-level mount ("normal") or
   *  assumes it's already level and points straight up when idle -- a mast/roof
   *  install on a slope wants FORCE_LEVEL; the default is right for everyone else. */
  levelDishMode?: "TILT_LIKE_NORMAL" | "FORCE_LEVEL";
  powerSaveStartMinutes?: number;
  powerSaveDurationMinutes?: number;
  powerSaveMode?: boolean;
  swupdateRebootHour?: number;
  swupdateThreeDayDeferralEnabled?: boolean;
}

export interface DishDiagnosticsJson {
  id?: string;
  hardwareVersion?: string;
  softwareVersion?: string;
  alerts?: Record<string, unknown>;
  disablementCode?: string;
  hardwareSelfTest?: string;
  alignmentStats?: DishAlignmentStatsJson;
}

/** Which of the schema's auth sub-messages is present tells the router which
 *  security type this band uses -- open has no fields at all, WPA3 and the
 *  WPA2/WPA3-mixed transitional mode carry the same shape WPA2 does. */
export type WifiSecurityType = "wpa2" | "wpa3" | "wpa2wpa3" | "open";

export interface WifiBasicServiceSetJson {
  bssid?: string;
  ssid?: string;
  band?: string;
  ifaceName?: string;
  /** Read back masked ("•••••"), never the real value -- a write must always
   *  resupply the actual password, never round-trip this. See
   *  setRouterWifiSsid's own note for why that matters. */
  authWpa2?: { password?: string };
  authWpa3?: { password?: string };
  authWpa2Wpa3?: { password?: string };
  /** Present (as `{}`) when this band is open/unsecured -- absent otherwise. */
  authOpen?: Record<string, never>;
  hidden?: boolean;
  disable?: boolean;
}

export interface WifiLanNetworkJson {
  ipv4?: string;
  domain?: string;
  vlan?: number;
  basicServiceSets?: WifiBasicServiceSetJson[];
  /** Content filtering (the official app's term) is "sandbox" in this schema.
   *  sandboxId is the official app's 3-way level -- see
   *  core/routerWifiConfigUpdate.ts's ContentFilteringLevel for the mapping
   *  and how confident it is. Not a declared protobuf enum, so there are no
   *  value labels to read off the schema itself. */
  sandboxEnabled?: boolean;
  sandboxId?: number;
  sandboxDomainAllowList?: string[];
  /** The official app's "Network mode" is a preset over these three fields --
   *  see NetworkMode in routerWifiConfigUpdate.ts for the exact combination
   *  each of Default/Guest/Auto sets, and which part of that is confirmed
   *  live vs inferred. */
  guest?: boolean;
  clientIsolation?: boolean;
  disableWhenOffline?: boolean;
  /** DHCP range/lease -- not exposed in the official app at all; offered here
   *  as an advanced option since the schema supports it. */
  dhcpv4Start?: number;
  dhcpv4End?: number;
  dhcpv4LeaseDurationS?: number;
  dhcpDisabled?: boolean;
  dnsDisabled?: boolean;
  /** Local DNS overrides for this network -- domains resolved straight to the
   *  given addresses rather than going out to the real resolver. */
  dnsStaticEntries?: { domains?: string[]; addresses?: string[] }[];
  /** Per-domain DNS forwarding -- these domains go to the given server(s)
   *  instead of the network's own resolver. */
  dnsForwardRules?: { domains?: string[]; serverAddresses?: string[] }[];
  /** Extra routes this network's devices get, beyond the default gateway. */
  staticRoutes?: { subnet?: string; gateway?: string }[];
}

/** A mesh node the router has been paired with, keyed in `meshConfigs` by the
 *  node's `deviceId` (same "Router-<hex>" namespace the client list reports).
 *  Entries persist across disconnects, so this is the roster of *known* nodes —
 *  whether one is currently up is decided by the live client list. */
export interface WifiMeshNodeJson {
  displayName?: string;
  auth?: string;
  hardwareVersion?: string;
  lastConnected?: string;
}

export type TxPowerLevel =
  | "TX_POWER_LEVEL_100"
  | "TX_POWER_LEVEL_80"
  | "TX_POWER_LEVEL_50"
  | "TX_POWER_LEVEL_25"
  | "TX_POWER_LEVEL_12"
  | "TX_POWER_LEVEL_6";

export type WirelessMode =
  | "WIRELESS_MODE_DEFAULT"
  | "A_ONLY"
  | "B_ONLY"
  | "G_ONLY"
  | "N_ONLY"
  | "B_G_MIXED"
  | "A_N_MIXED"
  | "G_N_MIXED"
  | "B_G_N_MIXED"
  | "A_AN_AC_MIXED"
  | "AN_AC_MIXED"
  | "B_G_N_AX_MIXED"
  | "A_AN_AC_AX_MIXED";

export type HtBandwidth = "HT_BANDWIDTH_DEFAULT" | "HT_BANDWIDTH_20_MHZ" | "HT_BANDWIDTH_20_OR_40_MHZ";

export type VhtBandwidth =
  | "VHT_BANDWIDTH_DEFAULT"
  | "VHT_BANDWIDTH_DISABLED"
  | "VHT_BANDWIDTH_80_MHZ"
  | "VHT_BANDWIDTH_160_MHZ"
  | "VHT_BANDWIDTH_80_PLUS_80_MHZ";

export interface WifiNetworkConfigJson {
  countryCode?: string;
  networks?: WifiLanNetworkJson[];
  meshConfigs?: Record<string, WifiMeshNodeJson>;
  clientConfigs?: WifiClientConfigJson[];
  boot?: { evenSideSoftwareVersion?: string; oddSideSoftwareVersion?: string; lastReason?: string };
  /** Disables the router's own WiFi in favor of a third-party router on its
   *  ethernet port. Read-only here -- see setBypassMode's own risk note. */
  bypassMode?: boolean;
  nameservers?: string[];
  customDnsDisabled?: boolean;
  /** Whether content filtering fails open (internet keeps working, unfiltered)
   *  or closed (internet blocks entirely) if the filtering service itself is
   *  unreachable. Only meaningful while content filtering is on. */
  disableSandboxFailOpen?: boolean;
  txPowerLevel2ghz?: TxPowerLevel;
  txPowerLevel5ghz?: TxPowerLevel;
  txPowerLevel5ghzHigh?: TxPowerLevel;
  disable2ghz?: boolean;
  disable5ghz?: boolean;
  disable5ghzHigh?: boolean;
  /** Raw channel number -- not a declared enum in the schema, so there's no
   *  fixed valid-value list to validate against here; 0/absent means Auto. */
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
  /** Bundled together in the UI as one "lock mesh onboarding" toggle -- the
   *  schema splits wired vs wireless mesh pairing into two flags, but nothing
   *  about this router's setup needs them set independently. */
  disableMeshOnboarding?: boolean;
  disableWirelessMeshOnboarding?: boolean;
  [key: string]: unknown;
}

export interface WifiBlockRangeJson {
  startMinutes?: number;
  endMinutes?: number;
}

export interface WifiWeeklyBlockScheduleJson {
  blockRanges?: WifiBlockRangeJson[];
  groupId?: string;
}

export interface WifiClientConfigJson {
  clientId?: number;
  macAddress?: string;
  givenName?: string;
  weeklyBlockSchedules?: WifiWeeklyBlockScheduleJson[];
  groupId?: string;
  [key: string]: unknown;
}

export interface WifiClientStatsJson {
  bytes?: string;
  rateMbps?: number;
  bandwidth?: number;
  nss?: number;
  mcs?: number;
  /** proto3 JSON encodes a NaN double as the *string* "NaN" — the router does
   *  this on quiet clients — so these are never safely arithmetic. Read them
   *  through throughputMbps(). */
  throughputMbpsLast1mAvg?: number | "NaN";
  throughputMbpsLast15sAvg?: number | "NaN";
}

/** A reading only if it is really a number: rejects undefined and the "NaN" string. */
function finiteMbps(value: number | "NaN" | undefined): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Point-in-time rate for one direction, the fallback when the exact byte-delta
 * rate is unavailable. The 15s average is preferred over the 1-minute one: the
 * shorter window sits closer to the current rate, and txStats carries no 1m field
 * at all — preferring 1m would smooth download over 60s while upload rode a 15s
 * window on the same chart. The 1m average is only a further fallback, and the
 * "NaN" string the router emits on quiet clients is rejected either way.
 */
export function throughputMbps(stats: WifiClientStatsJson | undefined): number {
  return (
    finiteMbps(stats?.throughputMbpsLast15sAvg) ?? finiteMbps(stats?.throughputMbpsLast1mAvg) ?? 0
  );
}

export interface WifiClientJson {
  name?: string;
  givenName?: string;
  macAddress?: string;
  ipAddress?: string;
  ipv6Addresses?: string[];
  signalStrength?: number;
  snr?: number;
  iface?: string;
  ifaceName?: string;
  channelWidth?: number;
  role?: string;
  deviceId?: string;
  upstreamMacAddress?: string;
  hopsFromController?: number;
  /** Router's estimate of the link back to the controller, per direction. On a
   *  mesh node this is the backhaul everything it relays has to fit through —
   *  measured at ~320/1000 Mbps on 5 GHz and ~216/187 after it fell to 2.4 GHz.
   *  Absent on the controller itself, which has no upstream radio link. */
  estRxRateMbpsFromController?: number;
  estTxRateMbpsFromController?: number;
  associatedTimeS?: number;
  secondsUntilDhcpLeaseExpires?: number;
  dhcpLeaseActive?: boolean;
  /** Router's internal id for this client — the number the app prints under the
   *  device name. Reissued whenever the MAC changes, which on a phone or laptop
   *  using a private Wi-Fi address includes an ordinary rotation. */
  clientId?: number;
  /** Per-client 32-byte hex the router derives from something it does not expose:
   *  devices behind one vendor-masked MAC each get a distinct value, so it is not
   *  a hash of the address we are given. Whether it survives a MAC rotation is
   *  unproven — recorded so a rotation answers it, and safe to trust on a match
   *  either way, since a match can at worst mean the same full MAC. */
  captiveClientId?: string;
  /** Seconds since the client last passed traffic. Omitted (proto3 drops zeros)
   *  while data is flowing, so `undefined` means "active right now". */
  noDataIdleS?: number;
  /** True while the device is paused (its internet blocked). A manual pause is a
   *  whole-week `_permanent` block schedule in its clientConfig; the router
   *  surfaces the live effect here. Set from the app (LAN writes are denied), but
   *  readable locally — see wifiConfig.clientConfigs[].weeklyBlockSchedules. */
  blocked?: boolean;
  /** Cumulative per-client totals, in megabytes despite the name.
   *
   *  Not interchangeable with rxStats.bytes / txStats.bytes: these appear to
   *  count WAN-attributed traffic only, where the byte counters count everything
   *  crossing the radio. They diverge by large factors in either direction, so
   *  a device's totals are read from the byte counters. On a client whose
   *  traffic is nearly all WAN — a downstream router — the two agree, which
   *  makes the difference easy to miss.
   *
   *  A wired client has empty rxStats/txStats and only these, which is why its
   *  usage reads blank rather than a different quantity under the same label.
   *
   *  Guard anything built on them: a client has been seen reporting ~3.7e9. */
  uploadMb?: number;
  downloadMb?: number;
  rxStats?: WifiClientStatsJson;
  txStats?: WifiClientStatsJson;
}

/** The router's own get_status. Its alerts are a different set from the dish's. */
export interface WifiStatusJson {
  deviceInfo?: DishDeviceInfoJson;
  deviceState?: { uptimeS?: string };
  alerts?: Record<string, boolean>;
  pingLatencyMs?: number;
  dishPingLatencyMs?: number;
  popPingLatencyMs?: number;
  /** Share of the router's own pings to the PoP lost over a rolling five
   *  minutes, 0–1, computed by the router. The safe source for router ping
   *  success: it rides the get_status reply already polled everywhere, unlike
   *  get_ping (1009), which rebooted the router every time it was polled
   *  (2026-07-20, three trials at three cadences). Absent means the proto3
   *  zero — no drops — not "unsupported": this firmware sends the field.
   *  NOTE the lowercase trailing `m`: the LAN reply spells it `5m`, unlike the
   *  app's cloud debug dump (`5M`) — verified by probe on this firmware. */
  popPingDropRate5m?: number;
  ipv4WanAddress?: string;
}

/** The router's per-radio Wi-Fi stats — the only real temperatures on this LAN.
 *  Only `temp2` is populated on current firmware; `temp` is absent. */
export interface RadioStatsJson {
  radioStats?: Array<{
    band?: string;
    thermalStatus?: { temp?: number; temp2?: number; dutyCycle?: number };
  }>;
}

// ---------- client ----------

export class DishClient {
  private constructor(
    private readonly target: "dish" | "router",
    /** Set only by a caller that already has the protoset bytes in hand (the
     *  dev cloud proxy reads them off disk with Node fs -- see its own note on
     *  why: its process can't do a relative `fetch("/dish.protoset")` the way
     *  a browser tab can). Everything else falls back to loadRequestSchema's
     *  lazy HTTP fetch, shared module-wide. */
    private readonly schemaOverride: Promise<{ requestSchema: DescMessage; registry: Registry }> | null = null,
  ) {}

  /**
   * No network round-trip needed anymore for local calls (no protoset to
   * fetch) -- async only to keep every call site that awaits
   * DishClient.load(...) unchanged.
   *
   * `handleUrl`/`protosetUrl` are accepted-but-ignored, for compatibility
   * with the Electron/extension entry points, which still pass a grpc-web
   * host binding during their own bootstrap (see setDishHost's own note).
   * `protosetBytes`, if given, is used -- it's how a Node-side caller (no
   * relative fetch available) supplies what encodeRequest needs.
   */
  static async load(
    target: "dish" | "router" = "dish",
    options: { handleUrl?: string; protosetUrl?: string; protosetBytes?: Uint8Array } = {},
  ): Promise<DishClient> {
    const schemaOverride = options.protosetBytes
      ? parseRequestSchema(options.protosetBytes)
      : null;
    return new DishClient(target, schemaOverride);
  }

  async getStatus(abortSignal?: AbortSignal): Promise<DishStatusJson> {
    return apiGet<DishStatusJson>("/status", abortSignal);
  }

  /** The ROUTER's own status. Carries the router's alert set (PoE faults, mesh health). */
  async getRouterStatus(abortSignal?: AbortSignal): Promise<WifiStatusJson> {
    return apiGet<WifiStatusJson>("/router/status", abortSignal);
  }

  async getHistory(abortSignal?: AbortSignal): Promise<DishHistoryJson> {
    return apiGet<DishHistoryJson>("/history", abortSignal);
  }

  async getDeviceInfo(abortSignal?: AbortSignal): Promise<DishDeviceInfoJson> {
    const status = await apiGet<DishStatusJson>("/status", abortSignal);
    return status.deviceInfo ?? {};
  }

  async getObstructionMap(abortSignal?: AbortSignal): Promise<DishObstructionMapJson> {
    return apiGet<DishObstructionMapJson>("/obstruction-map", abortSignal);
  }

  /**
   * Dish GPS position. Throws (status 7, "Disabled due to policy") on consumer
   * plans since mid-2026 firmware -- the app's old "Allow access on local
   * network" toggle no longer exists.
   */
  async getLocation(abortSignal?: AbortSignal): Promise<DishLocationJson> {
    return apiGet<DishLocationJson>("/location", abortSignal);
  }

  /** Connected clients — meaningful on the ROUTER target. */
  async getWifiClients(abortSignal?: AbortSignal): Promise<WifiClientJson[]> {
    const data = await apiGet<{ clients?: WifiClientJson[] }>("/router/clients", abortSignal);
    return data.clients ?? [];
  }

  /** Per-radio Wi-Fi stats — meaningful on the ROUTER target. The only real
   *  temperatures anything on this network reports; the dish answers Unimplemented. */
  async getRadioStats(abortSignal?: AbortSignal): Promise<RadioStatsJson> {
    return apiGet<RadioStatsJson>("/router/radio-stats", abortSignal);
  }

  /** Reboot this device (dish or router). Drops connectivity for a few minutes. */
  async reboot(abortSignal?: AbortSignal): Promise<void> {
    await apiPost(this.target === "dish" ? "/reboot" : "/router/reboot", undefined, abortSignal);
  }

  /** Stow (fold flat) or unstow the dish. Motorized (mast) models only -- a
   *  no-op RPC on electronically-steered kits (this network's Mini). */
  async stow(unstow: boolean, abortSignal?: AbortSignal): Promise<void> {
    await apiPost(`/stow?unstow=${unstow}`, undefined, abortSignal);
  }

  /** Encode a Device.Request for an authenticated host to send through the cloud
   *  gateway. This does not perform a local router write. */
  async encodeRequest(requestJson: object): Promise<Uint8Array> {
    const { requestSchema, registry } = await (this.schemaOverride ?? loadRequestSchema());
    return toBinary(requestSchema, fromJson(requestSchema, requestJson as JsonValue, { registry }));
  }

  /** Current dish configuration (sleep schedule, snow melt, update window …). */
  async getConfig(abortSignal?: AbortSignal): Promise<DishConfigJson & Record<string, unknown>> {
    const data = await apiGet<{ dishConfig?: DishConfigJson & Record<string, unknown> }>(
      "/dish-config",
      abortSignal,
    );
    return data.dishConfig ?? {};
  }

  /**
   * Apply a partial config change. Only the fields present are written — the
   * matching apply_* flags are set automatically (server-side, in
   * starlink_client.py's set_dish_config) so untouched knobs stay put.
   *
   * As of mid-2026 firmware this -- like every local write RPC -- returns
   * PERMISSION_DENIED (grpc status 7); Starlink's official app writes through
   * their cloud, not the LAN. Kept wired up (not hidden) so it goes live the
   * moment that changes, or once cloud-auth writes are added here.
   */
  async setConfig(changes: DishConfigJson, abortSignal?: AbortSignal): Promise<void> {
    await apiPost("/settings/dish-config", { changes }, abortSignal);
  }

  /** Self-diagnostics: disablement code, hardware self-test, alerts. */
  async getDiagnostics(abortSignal?: AbortSignal): Promise<DishDiagnosticsJson> {
    return apiGet(this.target === "dish" ? "/diagnostics" : "/router/diagnostics", abortSignal);
  }

  /** Wipe the learned sky map and restart the obstruction survey. Blocked by
   *  firmware the same as setConfig -- see its note above. */
  async clearObstructionMap(abortSignal?: AbortSignal): Promise<void> {
    await apiPost("/obstruction-map/clear", undefined, abortSignal);
  }

  /** Router WiFi configuration (SSID, channels, mesh) — ROUTER target. */
  async getWifiConfig(abortSignal?: AbortSignal): Promise<WifiNetworkConfigJson> {
    const data = await apiGet<{ wifiConfig?: WifiNetworkConfigJson }>("/router/config", abortSignal);
    return data.wifiConfig ?? {};
  }

  /** Rename a client device (persists in the router) — ROUTER target. Blocked
   *  by firmware the same as setConfig -- see its note above. */
  async setClientGivenName(
    macAddress: string,
    givenName: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    await apiPost("/router/clients/name", { mac_address: macAddress, given_name: givenName }, abortSignal);
  }
}
