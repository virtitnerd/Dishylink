// Host-agnostic client for the user's own starlink.com account. It holds the
// session cookie, refreshes the short-lived Access.V1 token, and serves the
// /cloud/* routes the UI reads. The transport (fetch) and the cookie store are
// injected, so each host binds its own: the dev server a file + Node fetch, the
// Electron main process the OS keychain + net.fetch, the extension chrome.cookies.
//
// This is separate from the historian on purpose: cloud data needs only the
// internet and a cookie, and must not depend on the dish poller's health.

import { GrpcWebError, grpcWebUnaryCall } from "../core/grpcWeb";
import type { RouterClientUpdate } from "../core/routerClientUpdate";
import {
  SUBNET_OPTIONS,
  type NetworkMode,
  type RouterWifiConfigUpdate,
} from "../core/routerWifiConfigUpdate";
import type { DishConfigJson } from "../core/dishClient";
import type { DishUpdate } from "../core/dishConfigUpdate";
import {
  normalizeNameservers,
  subnetRefusal,
  type RouterConfigUpdate,
} from "../core/routerConfigUpdate";

const VALID_NETWORK_MODES: ReadonlySet<NetworkMode> = new Set(["default", "guest", "auto"]);
const VALID_SECURITY_TYPES: ReadonlySet<string> = new Set(["wpa2", "wpa3", "wpa2wpa3", "open"]);
const VALID_TX_POWER_LEVELS: ReadonlySet<string> = new Set([
  "TX_POWER_LEVEL_100",
  "TX_POWER_LEVEL_80",
  "TX_POWER_LEVEL_50",
  "TX_POWER_LEVEL_25",
  "TX_POWER_LEVEL_12",
  "TX_POWER_LEVEL_6",
]);
const VALID_WIRELESS_MODES: ReadonlySet<string> = new Set([
  "WIRELESS_MODE_DEFAULT",
  "A_ONLY",
  "B_ONLY",
  "G_ONLY",
  "N_ONLY",
  "B_G_MIXED",
  "A_N_MIXED",
  "G_N_MIXED",
  "B_G_N_MIXED",
  "A_AN_AC_MIXED",
  "AN_AC_MIXED",
  "B_G_N_AX_MIXED",
  "A_AN_AC_AX_MIXED",
]);
const VALID_HT_BANDWIDTHS: ReadonlySet<string> = new Set([
  "HT_BANDWIDTH_DEFAULT",
  "HT_BANDWIDTH_20_MHZ",
  "HT_BANDWIDTH_20_OR_40_MHZ",
]);
const VALID_VHT_BANDWIDTHS: ReadonlySet<string> = new Set([
  "VHT_BANDWIDTH_DEFAULT",
  "VHT_BANDWIDTH_DISABLED",
  "VHT_BANDWIDTH_80_MHZ",
  "VHT_BANDWIDTH_160_MHZ",
  "VHT_BANDWIDTH_80_PLUS_80_MHZ",
]);
/** Raw channel numbers aren't a declared enum in the schema (no fixed list to
 *  check against) -- just bound them to a range no real channel exceeds, so a
 *  stray value can't reach the router as something wildly malformed. */
function isValidChannel(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 200)
  );
}
const VALID_SNOW_MELT_MODES: ReadonlySet<string> = new Set(["AUTO", "ALWAYS_ON", "ALWAYS_OFF"]);
const VALID_LOCATION_MODES: ReadonlySet<string> = new Set(["NONE", "LOCAL"]);
const VALID_LEVEL_DISH_MODES: ReadonlySet<string> = new Set(["TILT_LIKE_NORMAL", "FORCE_LEVEL"]);
const DISH_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "snowMeltMode",
  "locationRequestMode",
  "levelDishMode",
  "powerSaveStartMinutes",
  "powerSaveDurationMinutes",
  "powerSaveMode",
  "swupdateRebootHour",
  "swupdateThreeDayDeferralEnabled",
]);

const AUTH_URL = "https://api.starlink.com/auth-rp/auth/user";
const API = "https://starlink.com/api";
const DEVICE_HANDLE = `${API}/SpaceX.API.Device.Device/Handle`;
const REFRESH_TTL_MS = 60_000; // the Access.V1 token is short-lived; refresh at most this often
const IDS_TTL_MS = 5 * 60_000; // account/service-line numbers change ~never; cache across routes

/** The account has not named a router this write could target. Nothing is wrong
 *  with the session or the connection: the telemetry feed is momentarily empty,
 *  and it fills in again on its own — so this must not read as a fault. */
export class ControllerUnknownError extends Error {
  constructor() {
    super("Starlink has not reported a router on this account yet");
    this.name = "ControllerUnknownError";
  }
}

/** The account session is gone or expired — the UI must prompt a reconnect, NOT
 *  show a generic "check your internet". Distinct from a real upstream fault. */
export class SessionExpiredError extends Error {
  constructor() {
    super("Starlink session expired or not connected");
    this.name = "SessionExpiredError";
  }
}

export interface CloudResult {
  status: number;
  body: unknown;
}

export interface CloudHandlerOptions {
  /** Injected for tests / non-Node hosts; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Cookie persistence — host-wired (dev: a file; Electron: the OS keychain).
   *  Absent readCookie means "no session", so the UI reads as not connected. */
  readCookie?: () => string | null;
  writeCookie?: (cookie: string) => void;
  clearCookie?: () => void;
  /** How long to let a just-installed session settle before the one retry. On the
   *  extension the cookie rides a declarativeNetRequest rule, and a rule set
   *  microseconds earlier is not reliably applied to the very next worker fetch;
   *  the pause gives it a beat to take. Injected so tests retry without waiting. */
  retryDelayMs?: number;
  /** Maximum time for each remote router mutation attempt. */
  deviceCallTimeoutMs?: number;
  /** Trusted host callback: reads what the write must preserve — through the same
   *  gateway, against the target this handler resolved from the account — and
   *  encodes exactly one client update. Renderer-provided protobuf is never
   *  accepted. Touching no LAN is what lets a bypassed router, invisible on the
   *  local network by definition, still have its devices paused and renamed. */
  prepareDeviceUpdate?: (
    update: RouterClientUpdate,
    targetId: string,
    callGateway: (requestBytes: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<Uint8Array>;
  /** Same trust boundary as prepareDeviceUpdate, for WifiConfig-level writes
   *  (custom DNS today; bypass mode and content filtering once each has had
   *  its own careful verification -- see routerWifiConfigUpdate.ts). */
  prepareWifiConfigUpdate?: (update: RouterWifiConfigUpdate) => Promise<Uint8Array>;
  /** Same trust boundary again, for the dish itself -- see dishConfigUpdate.ts. */
  prepareDishUpdate?: (update: DishUpdate) => Promise<Uint8Array>;
  /** Trusted host callback: encodes exactly one router config change against the
   *  target this handler resolved from the account. Unlike the callbacks above it
   *  reads nothing from the LAN, which is what lets a bypassed router — invisible
   *  on the local network by definition — still be configured. */
  prepareRouterConfigUpdate?: (
    update: RouterConfigUpdate,
    targetId: string,
    /** Sends one encoded request through the same authenticated gateway and
     *  returns the raw reply. A subnet change needs it: the write has to carry
     *  the network block the router currently reports. */
    callGateway: (requestBytes: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<Uint8Array>;
  /** Trusted host callback: reads the router's current subnet through the same
   *  gateway. Like the write above it touches no LAN, so it answers for a router
   *  the local network cannot see. */
  readRouterSubnet?: (
    targetId: string,
    callGateway: (requestBytes: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<string | null>;
  /** Trusted host callback: reads the connected-device roster through the same
   *  gateway — the one reader that answers away from home, and for a router the
   *  LAN cannot see. */
  readRouterClients?: (
    targetId: string,
    callGateway: (requestBytes: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<unknown[]>;
  /** Trusted host callback: reads the router's whole WiFi config through the same
   *  gateway — SSIDs, mesh nodes, saved device names. */
  readRouterConfig?: (
    targetId: string,
    callGateway: (requestBytes: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<unknown>;
}

/** The durable half of the session — without it a token refresh can't happen, so
 *  a session missing it is definitely not usable. */
const SSO_COOKIE_RE = /Starlink\.Com\.Sso=/;

/** Answered wherever a router has to be named, so every surface says the same
 *  waitable thing rather than reporting an outage. */
const NO_CONTROLLER: CloudResult = {
  status: 503,
  body: {
    error: "router_not_reported",
    message: "Starlink hasn't reported your router yet — try again in a minute.",
  },
};

const NOT_CONNECTED: CloudResult = {
  status: 428,
  body: {
    error: "not_connected",
    message: "An authorized account is required — sign in to use this feature.",
  },
};

/** Finite number or undefined — a missing legend field yields Number(undefined)
 *  = NaN, which otherwise leaks to the UI as "NaN%"/"NaN". */
function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Per-device live stats from the telemetry feed, keyed by full DeviceId
 *  ("ut<uuid>" for dishes, "Router-<hex>" for routers). The service-line detail
 *  carries none of this (software/hardware version, uptime, clients, hops,
 *  bypass) nor the freshness timestamp the online/offline dot needs. Exported
 *  for direct testing of the missing-field / NaN-guard behaviour. */
export function deviceTelemetryFrom(telemetry: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const data = (
    telemetry as {
      data?: { columnNamesByDeviceType?: Record<string, string[]>; values?: unknown[][] };
    }
  )?.data;
  if (!data?.values || !data.columnNamesByDeviceType) return out;
  for (const row of data.values) {
    const kind = row[0];
    const legend: string[] | undefined = data.columnNamesByDeviceType[kind as string];
    if (!legend) continue;
    const get = (name: string): unknown => row[legend.indexOf(name)];
    const id = String(get("DeviceId") ?? "");
    if (!id) continue;
    const timestampMs = (num(get("UtcTimestampNs")) ?? 0) / 1e6;
    if (kind === "u") {
      out[id] = {
        kind: "dish",
        timestampMs,
        softwareVersion: get("RunningSoftwareVersion"),
        uptimeS: num(get("Uptime")),
        obstructionPct: num(get("ObstructionPercentTime")),
        signalQuality: num(get("SignalQuality")),
      };
    } else if (kind === "r") {
      out[id] = {
        kind: "router",
        timestampMs,
        hardwareVersion: get("WifiHardwareVersion"),
        softwareVersion: get("WifiSoftwareVersion"),
        uptimeS: num(get("WifiUptimeS")),
        clients: num(get("Clients")),
        hops: num(get("WifiHopsFromController")),
        isRepeater: get("WifiIsRepeater") === true,
        isBypassed: get("WifiIsBypassed") === true,
      };
    }
  }
  return out;
}

interface ServiceLineResult {
  serviceLineNumber?: string;
  accountReferenceId?: string;
}

/** Host-agnostic cloud client: holds the session cookie + short-lived-token
 *  refresh and serves the /cloud/* routes. State is per-instance so tests get a
 *  clean client each time. */
export function createCloudHandler(options: CloudHandlerOptions = {}) {
  const doFetch = options.fetch ?? fetch;
  const readCookie = options.readCookie ?? (() => null);
  const writeCookie = options.writeCookie ?? (() => {});
  const clearCookie = options.clearCookie ?? (() => {});
  const retryDelayMs = options.retryDelayMs ?? 150;
  const deviceCallTimeoutMs = options.deviceCallTimeoutMs ?? 15_000;
  const prepareDeviceUpdate = options.prepareDeviceUpdate;
  const prepareWifiConfigUpdate = options.prepareWifiConfigUpdate;
  const prepareDishUpdate = options.prepareDishUpdate;
  const prepareRouterConfigUpdate = options.prepareRouterConfigUpdate;
  const readRouterSubnet = options.readRouterSubnet;
  const readRouterClients = options.readRouterClients;
  const readRouterConfig = options.readRouterConfig;

  let cachedCookie: string | null = null;
  let cachedAt = 0;
  let refreshInFlight: Promise<string | null> | null = null;
  let cachedIds: { acc: string; sl: string } | null = null;
  let cachedIdsAt = 0;
  let cachedControllerId: string | null = null;
  let cachedControllerIdAt = 0;
  let deviceMutationTail: Promise<void> = Promise.resolve();

  function forgetSession() {
    cachedCookie = null;
    cachedAt = 0;
    cachedIds = null;
    cachedIdsAt = 0;
    cachedControllerId = null;
    cachedControllerIdAt = 0;
  }

  /** Swap in a freshly-minted Access.V1 (the webagg/telemetryagg calls 401
   *  without it). `force` busts the 60s cache after a mid-flight token expiry.
   *  Concurrent callers share one in-flight refresh so opening a surface fires
   *  one auth/user. */
  async function freshCookie(force = false, abortSignal?: AbortSignal): Promise<string | null> {
    const base = readCookie();
    if (!base) return null;
    if (!force && cachedCookie && Date.now() - cachedAt < REFRESH_TTL_MS) return cachedCookie;
    if (!force && refreshInFlight && !abortSignal) return refreshInFlight;

    const refresh = (async () => {
      const authResponse = await doFetch(AUTH_URL, {
        headers: { cookie: base },
        signal: abortSignal,
      });
      // A dead SSO session answers the refresh itself with 401/403 — that's a
      // reconnect, not an upstream failure. Surface it as such.
      if (authResponse.status === 401 || authResponse.status === 403) {
        forgetSession();
        throw new SessionExpiredError();
      }
      const setCookie = authResponse.headers.get("set-cookie") ?? "";
      const match = setCookie.match(/Starlink\.Com\.Access\.V1=([^;]+)/);
      const withoutOld = base.replace(/Starlink\.Com\.Access\.V1=[^;]*;?/g, "").trim();
      cachedCookie = match ? `Starlink.Com.Access.V1=${match[1]};${withoutOld}` : base;
      cachedAt = Date.now();
      return cachedCookie;
    })();

    // Bounded mutations use their own abortable refresh rather than inheriting
    // an unrelated, potentially stalled shared read request.
    if (abortSignal) return refresh;
    refreshInFlight = refresh.finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  /** Run a sequence of cloud calls with a valid token, healing one transient
   *  session miss. A SessionExpiredError is raised both when the short-lived token
   *  ages out mid-flight and when the session cookie has not yet reached this
   *  fetch — the extension delivers it via a rule that lands a beat after it is
   *  set, so a just-connected account or a just-woken worker misses the first
   *  auth/user. The recovery is the same for both: pause, force one fresh refresh,
   *  and try once more. A genuinely dead session throws again on that retry and
   *  surfaces as not-connected. The initial refresh is inside the retry because
   *  that first auth/user is exactly where the late cookie bites. */
  async function withFreshCookie<T>(
    run: (cookie: string) => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    const attempt = async (force: boolean): Promise<T> => {
      const cookie = await freshCookie(force, abortSignal);
      if (!cookie) throw new SessionExpiredError();
      return run(cookie);
    };
    try {
      return await attempt(false);
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      return attempt(true);
    }
  }

  async function apiGet(path: string, cookie: string, abortSignal?: AbortSignal): Promise<unknown> {
    const response = await doFetch(`${API}${path}`, {
      headers: { cookie, accept: "application/json" },
      signal: abortSignal,
    });
    if (response.status === 401 || response.status === 403) throw new SessionExpiredError();
    if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`);
    return response.json();
  }

  async function apiPost(
    path: string,
    cookie: string,
    body: unknown,
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    const response = await doFetch(`${API}${path}`, {
      method: "POST",
      headers: { cookie, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (response.status === 401 || response.status === 403) throw new SessionExpiredError();
    if (!response.ok) throw new Error(`POST ${path} → HTTP ${response.status}`);
    return response.json();
  }

  /** Account identity lives on the auth host, not the /api proxy. */
  async function fetchIdentity(cookie: string): Promise<unknown> {
    const response = await doFetch(AUTH_URL, { headers: { cookie, accept: "application/json" } });
    if (response.status === 401 || response.status === 403) throw new SessionExpiredError();
    if (!response.ok) throw new Error(`auth/user → HTTP ${response.status}`);
    return response.json();
  }

  /** Identity is optional to the account panel — a dead session must still leave
   *  plan and address readable — but a transient miss while a just-connected
   *  session settles should heal rather than leave Name/Email blank until a manual
   *  reload. A session miss retries once behind a forced token refresh, the same
   *  recovery withFreshCookie gives the calls that aren't wrapped here; only a
   *  genuine failure degrades to null. Hosts that rotate their token out of band
   *  (the extension re-reads the cookie jar the auth call repopulates) finish this
   *  heal on their own follow-up read. */
  async function resilientIdentity(cookie: string): Promise<unknown | null> {
    try {
      return await fetchIdentity(cookie);
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) return null;
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      const refreshed = await freshCookie(true).catch(() => null);
      if (!refreshed) return null;
      return fetchIdentity(refreshed).catch(() => null);
    }
  }

  /** Resolve the account number + primary service line the UI hangs everything
   *  off. Cached briefly so /cloud/account and /cloud/usage don't each re-list. */
  async function resolveIds(
    cookie: string,
    abortSignal?: AbortSignal,
  ): Promise<{ acc: string; sl: string }> {
    if (cachedIds && Date.now() - cachedIdsAt < IDS_TTL_MS) return cachedIds;
    const list = (await apiGet(
      "/webagg/v2/accounts/service-lines?limit=100&page=0&isConverting=false&serviceAddressId=&onlyActive=false&searchString=&onlyNoUts=false",
      cookie,
      abortSignal,
    )) as { content?: { results?: ServiceLineResult[] } };
    const first = list.content?.results?.[0];
    if (!first?.serviceLineNumber || !first?.accountReferenceId) {
      throw new Error("no service line on this account");
    }
    cachedIds = { acc: first.accountReferenceId, sl: first.serviceLineNumber };
    cachedIdsAt = Date.now();
    return cachedIds;
  }

  /**
   * The router to configure, named by the account rather than by the LAN.
   *
   * A mesh node reports as a router too, so the id cannot simply be "the one
   * router on the account" — this kit has two. `WifiHopsFromController` is what
   * separates them: the controller is zero hops from itself, and every node sits
   * behind it. Sourcing this from telemetry rather than the local router is the
   * whole reason a bypassed kit, which answers nothing on the LAN, can still be
   * configured.
   */
  async function resolveControllerId(cookie: string, abortSignal?: AbortSignal): Promise<string> {
    if (cachedControllerId && Date.now() - cachedControllerIdAt < IDS_TTL_MS) {
      return cachedControllerId;
    }
    const { acc } = await resolveIds(cookie, abortSignal);
    const telemetry = await apiPost(
      "/device-data/cache/v1/telemetry",
      cookie,
      { accountNumber: acc },
      abortSignal,
    );
    const routers = Object.entries(deviceTelemetryFrom(telemetry)).filter(
      ([, device]) => device.kind === "router",
    );
    if (routers.length === 0) throw new ControllerUnknownError();
    const controller =
      routers.find(([, device]) => device.hops === 0) ??
      (routers.length === 1 ? routers[0] : undefined);
    if (!controller) throw new ControllerUnknownError();
    cachedControllerId = controller[0];
    cachedControllerIdAt = Date.now();
    return cachedControllerId;
  }

  /** Run one bounded read against the account's controller: resolve the target,
   *  hand the callback a gateway bound to a fresh token, and let a session miss
   *  heal the way every other call here does. */
  async function withRouterGateway<T>(
    run: (
      targetId: string,
      callGateway: (requestBytes: Uint8Array) => Promise<Uint8Array>,
    ) => Promise<T>,
  ): Promise<T> {
    const abortSignal = AbortSignal.timeout(deviceCallTimeoutMs);
    return withFreshCookie(async (cookie) => {
      const targetId = await resolveControllerId(cookie, abortSignal);
      return run(targetId, (requestBytes) =>
        grpcWebUnaryCall(DEVICE_HANDLE, requestBytes, abortSignal, {
          fetch: doFetch,
          headers: { cookie },
        }),
      );
    }, abortSignal);
  }

  /** `route` is the path without query, e.g. "/cloud/account". */
  async function handle(route: string): Promise<CloudResult> {
    if (!readCookie()) return NOT_CONNECTED;
    try {
      if (route === "/cloud/account") {
        const body = await withFreshCookie(async (cookie) => {
          const { acc, sl } = await resolveIds(cookie);
          const [identity, serviceLine, telemetry] = await Promise.all([
            resilientIdentity(cookie),
            apiGet(`/webagg/v2/accounts/service-line/${sl}`, cookie),
            apiPost("/device-data/cache/v1/telemetry", cookie, { accountNumber: acc }).catch(
              () => null,
            ),
          ]);
          return { identity, serviceLine, deviceTelemetry: deviceTelemetryFrom(telemetry) };
        });
        return { status: 200, body };
      }
      if (route === "/cloud/usage") {
        const body = await withFreshCookie(async (cookie) => {
          const { acc, sl } = await resolveIds(cookie);
          return apiGet(
            `/telemetryagg/v1/data-usage/account/${acc}/service-line/${sl}/annotated`,
            cookie,
          );
        });
        return { status: 200, body };
      }
      if (route === "/cloud/telemetry") {
        const body = await withFreshCookie(async (cookie) => {
          const { acc } = await resolveIds(cookie);
          return apiPost("/device-data/cache/v1/telemetry", cookie, { accountNumber: acc });
        });
        return { status: 200, body };
      }
      if (route === "/cloud/router-subnet") {
        if (!readRouterSubnet) return { status: 503, body: { error: "router_subnet_unavailable" } };
        const subnet = await withRouterGateway(readRouterSubnet);
        return { status: 200, body: { subnet } };
      }
      // The roster the LAN normally serves, sourced from the account instead. It
      // is the same list — the router reports its devices to Starlink whether or
      // not this machine can reach it — so it answers the two cases the LAN read
      // cannot: away from home, and a router the local network cannot see.
      if (route === "/cloud/router-clients") {
        if (!readRouterClients)
          return { status: 503, body: { error: "router_clients_unavailable" } };
        const clients = await withRouterGateway(readRouterClients);
        return { status: 200, body: { clients } };
      }
      // GET reads the config the writes on this route change. Names, mesh nodes,
      // and SSIDs all live here, so a roster read from the account has somewhere
      // to get them from.
      if (route === "/cloud/router-config") {
        if (!readRouterConfig) return { status: 503, body: { error: "router_config_unavailable" } };
        const wifiConfig = await withRouterGateway(readRouterConfig);
        return { status: 200, body: { wifiConfig } };
      }
      return { status: 404, body: { error: "unknown_cloud_route", route } };
    } catch (error) {
      // A dead session is a reconnect prompt (428), not a network fault (502).
      if (error instanceof SessionExpiredError) return NOT_CONNECTED;
      if (error instanceof ControllerUnknownError) return NO_CONTROLLER;
      return { status: 502, body: { error: "upstream_failed", message: (error as Error).message } };
    }
  }

  /** Persist a session and confirm it actually authenticates, so a bad one gets
   *  immediate feedback rather than a broken-looking account later. */
  async function connect(cookie: string): Promise<CloudResult> {
    const trimmed = (cookie ?? "").trim();
    if (!SSO_COOKIE_RE.test(trimmed)) {
      return {
        status: 400,
        body: {
          error: "bad_cookie",
          message: "That doesn't look like a Starlink session — it must include Starlink.Com.Sso.",
        },
      };
    }
    writeCookie(trimmed);
    forgetSession();
    try {
      await withFreshCookie((c) => resolveIds(c));
      return { status: 200, body: { ok: true } };
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        return {
          status: 428,
          body: {
            error: "not_connected",
            message: "That session didn't authenticate — sign in at starlink.com again.",
          },
        };
      }
      return { status: 502, body: { error: "upstream_failed", message: (error as Error).message } };
    }
  }

  function disconnect(): CloudResult {
    clearCookie();
    forgetSession();
    return { status: 200, body: { ok: true } };
  }

  async function applyClientUpdate(update: RouterClientUpdate): Promise<CloudResult> {
    if (!readCookie()) return NOT_CONNECTED;
    try {
      // This callback reads the full client-config list. Keep preparation and
      // the corresponding write in one serialized critical section so a later
      // mutation cannot be built from a snapshot predating an earlier write.
      if (!prepareDeviceUpdate)
        return { status: 503, body: { error: "device_update_unavailable" } };
      await withRouterGateway(async (targetId, callGateway) => {
        const requestBytes = await prepareDeviceUpdate(update, targetId, callGateway);
        try {
          await callGateway(requestBytes);
        } catch (error) {
          if (error instanceof GrpcWebError && error.grpcStatus === 16)
            throw new SessionExpiredError();
          throw error;
        }
      });
      return { status: 200, body: { ok: true } };
    } catch (error) {
      if (error instanceof SessionExpiredError) return NOT_CONNECTED;
      if (error instanceof ControllerUnknownError) return NO_CONTROLLER;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return {
          status: 504,
          body: {
            error: "device_call_timeout",
            message: "Starlink did not answer the device update in time. Try again.",
          },
        };
      }
      return {
        status: 502,
        body: { error: "device_call_failed", message: (error as Error).message },
      };
    }
  }

  /** The renderer names a device and a change, never protobuf. Anything outside
   *  these shapes is refused before the router is read. */
  function validUpdate(update: RouterClientUpdate): boolean {
    if (update?.kind === "pause")
      return (
        Number.isInteger(update.clientId) &&
        update.clientId >= 0 &&
        update.clientId <= 0xffff_ffff &&
        typeof update.paused === "boolean"
      );
    if (update?.kind === "rename")
      return (
        Number.isInteger(update.clientId) &&
        update.clientId >= 0 &&
        update.clientId <= 0xffff_ffff &&
        typeof update.givenName === "string" &&
        update.givenName.trim().length > 0 &&
        update.givenName.length <= 64
      );
    return false;
  }

  /** Every update rewrites the router's whole client list, so two in flight would
   *  each be built from a snapshot predating the other. One queue for all of them. */
  function updateClient(update: RouterClientUpdate): Promise<CloudResult> {
    if (!validUpdate(update))
      return Promise.resolve({ status: 400, body: { error: "bad_request" } });

    const mutation = deviceMutationTail.then(() => applyClientUpdate(update));
    // A rejected mutation must not poison the queue for every later device.
    deviceMutationTail = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }

  /** Same trust boundary as validUpdate above: the renderer names a change,
   *  never protobuf. */
  function validWifiConfigUpdate(update: RouterWifiConfigUpdate): boolean {
    if (update?.kind === "dns")
      return (
        Array.isArray(update.nameservers) &&
        update.nameservers.length <= 8 &&
        update.nameservers.every((ns) => typeof ns === "string" && ns.length <= 64) &&
        typeof update.disabled === "boolean"
      );
    if (update?.kind === "bypassMode") return typeof update.enabled === "boolean";
    if (update?.kind === "contentFiltering")
      return (
        (update.level === 0 || update.level === 1 || update.level === 2) &&
        (update.allowDomains === undefined ||
          (Array.isArray(update.allowDomains) &&
            update.allowDomains.length <= 64 &&
            update.allowDomains.every((d) => typeof d === "string" && d.length <= 255)))
      );
    if (update?.kind === "ssid")
      return (
        typeof update.networkDomain === "string" &&
        update.networkDomain.length > 0 &&
        typeof update.band === "string" &&
        update.band.length > 0 &&
        typeof update.ssid === "string" &&
        update.ssid.length > 0 &&
        update.ssid.length <= 32 &&
        // Required for every security type except "open" -- see
        // routerWifiConfigUpdate.ts's own note: an absent password would
        // round-trip the router's read-back mask.
        (update.security === "open"
          ? update.password === "" || typeof update.password === "string"
          : typeof update.password === "string" && update.password.length > 0) &&
        (update.hidden === undefined || typeof update.hidden === "boolean") &&
        (update.disable === undefined || typeof update.disable === "boolean") &&
        (update.security === undefined || VALID_SECURITY_TYPES.has(update.security))
      );
    if (update?.kind === "networkSettings")
      return (
        typeof update.networkDomain === "string" &&
        update.networkDomain.length > 0 &&
        (update.mode === undefined || VALID_NETWORK_MODES.has(update.mode)) &&
        (update.ipv4 === undefined ||
          (SUBNET_OPTIONS as readonly string[]).includes(update.ipv4)) &&
        (update.dhcpv4Start === undefined ||
          (Number.isInteger(update.dhcpv4Start) &&
            update.dhcpv4Start >= 2 &&
            update.dhcpv4Start <= 254)) &&
        (update.dhcpv4End === undefined ||
          (Number.isInteger(update.dhcpv4End) &&
            update.dhcpv4End >= 2 &&
            update.dhcpv4End <= 254)) &&
        (update.dhcpv4LeaseDurationS === undefined ||
          (Number.isInteger(update.dhcpv4LeaseDurationS) &&
            update.dhcpv4LeaseDurationS > 0 &&
            update.dhcpv4LeaseDurationS <= 30 * 86400)) &&
        (update.dhcpDisabled === undefined || typeof update.dhcpDisabled === "boolean") &&
        (update.dnsDisabled === undefined || typeof update.dnsDisabled === "boolean") &&
        (update.dnsStaticEntries === undefined || validDnsStaticEntries(update.dnsStaticEntries)) &&
        (update.dnsForwardRules === undefined || validDnsForwardRules(update.dnsForwardRules)) &&
        (update.staticRoutes === undefined || validStaticRoutes(update.staticRoutes))
      );
    if (update?.kind === "addNetwork")
      return (
        typeof update.ssid === "string" &&
        update.ssid.length > 0 &&
        update.ssid.length <= 32 &&
        typeof update.password === "string" &&
        update.password.length > 0 &&
        (SUBNET_OPTIONS as readonly string[]).includes(update.ipv4) &&
        VALID_NETWORK_MODES.has(update.mode) &&
        (update.hidden === undefined || typeof update.hidden === "boolean")
      );
    if (update?.kind === "deleteNetwork")
      return typeof update.networkDomain === "string" && update.networkDomain.length > 0;
    if (update?.kind === "routerAdvanced")
      return (
        (update.disableSandboxFailOpen === undefined ||
          typeof update.disableSandboxFailOpen === "boolean") &&
        (update.txPowerLevel2ghz === undefined ||
          VALID_TX_POWER_LEVELS.has(update.txPowerLevel2ghz)) &&
        (update.txPowerLevel5ghz === undefined ||
          VALID_TX_POWER_LEVELS.has(update.txPowerLevel5ghz)) &&
        (update.txPowerLevel5ghzHigh === undefined ||
          VALID_TX_POWER_LEVELS.has(update.txPowerLevel5ghzHigh)) &&
        (update.disable2ghz === undefined || typeof update.disable2ghz === "boolean") &&
        (update.disable5ghz === undefined || typeof update.disable5ghz === "boolean") &&
        (update.disable5ghzHigh === undefined || typeof update.disable5ghzHigh === "boolean") &&
        isValidChannel(update.channel2ghz) &&
        isValidChannel(update.channel5ghz) &&
        isValidChannel(update.channel5ghzHigh) &&
        (update.wirelessMode2ghz === undefined ||
          VALID_WIRELESS_MODES.has(update.wirelessMode2ghz)) &&
        (update.wirelessMode5ghz === undefined ||
          VALID_WIRELESS_MODES.has(update.wirelessMode5ghz)) &&
        (update.wirelessMode5ghzHigh === undefined ||
          VALID_WIRELESS_MODES.has(update.wirelessMode5ghzHigh)) &&
        (update.htBandwidth2ghz === undefined || VALID_HT_BANDWIDTHS.has(update.htBandwidth2ghz)) &&
        (update.htBandwidth5ghz === undefined || VALID_HT_BANDWIDTHS.has(update.htBandwidth5ghz)) &&
        (update.htBandwidth5ghzHigh === undefined ||
          VALID_HT_BANDWIDTHS.has(update.htBandwidth5ghzHigh)) &&
        (update.vhtBandwidth === undefined || VALID_VHT_BANDWIDTHS.has(update.vhtBandwidth)) &&
        (update.vhtBandwidth5ghzHigh === undefined ||
          VALID_VHT_BANDWIDTHS.has(update.vhtBandwidth5ghzHigh)) &&
        (update.disableBandSteering === undefined ||
          typeof update.disableBandSteering === "boolean") &&
        (update.disableMeshOnboarding === undefined ||
          typeof update.disableMeshOnboarding === "boolean")
      );
    if (update?.kind === "meshTrust")
      return (
        typeof update.deviceId === "string" &&
        update.deviceId.length > 0 &&
        typeof update.trusted === "boolean"
      );
    return false;
  }

  function validStringList(value: unknown, maxCount: number, maxLen: number): boolean {
    return (
      Array.isArray(value) &&
      value.length <= maxCount &&
      value.every((v) => typeof v === "string" && v.length > 0 && v.length <= maxLen)
    );
  }

  function validDnsStaticEntries(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      value.length <= 32 &&
      value.every(
        (e) =>
          e &&
          typeof e === "object" &&
          validStringList((e as { domains?: unknown }).domains, 16, 255) &&
          validStringList((e as { addresses?: unknown }).addresses, 16, 64),
      )
    );
  }

  function validDnsForwardRules(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      value.length <= 32 &&
      value.every(
        (e) =>
          e &&
          typeof e === "object" &&
          validStringList((e as { domains?: unknown }).domains, 16, 255) &&
          validStringList((e as { serverAddresses?: unknown }).serverAddresses, 16, 64),
      )
    );
  }

  function validStaticRoutes(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      value.length <= 32 &&
      value.every(
        (r) =>
          r &&
          typeof r === "object" &&
          typeof (r as { subnet?: unknown }).subnet === "string" &&
          (r as { subnet: string }).subnet.length > 0 &&
          (r as { subnet: string }).subnet.length <= 64 &&
          typeof (r as { gateway?: unknown }).gateway === "string" &&
          (r as { gateway: string }).gateway.length > 0 &&
          (r as { gateway: string }).gateway.length <= 64,
      )
    );
  }

  async function applyWifiConfigUpdate(update: RouterWifiConfigUpdate): Promise<CloudResult> {
    if (!readCookie()) return NOT_CONNECTED;
    try {
      if (!prepareWifiConfigUpdate)
        return { status: 503, body: { error: "wifi_config_update_unavailable" } };
      const requestBytes = await prepareWifiConfigUpdate(update);
      const abortSignal = AbortSignal.timeout(deviceCallTimeoutMs);
      await withFreshCookie(async (cookie) => {
        try {
          await grpcWebUnaryCall(DEVICE_HANDLE, requestBytes, abortSignal, {
            fetch: doFetch,
            headers: { cookie },
          });
        } catch (error) {
          if (error instanceof GrpcWebError && error.grpcStatus === 16)
            throw new SessionExpiredError();
          throw error;
        }
      }, abortSignal);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      if (error instanceof SessionExpiredError) return NOT_CONNECTED;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return {
          status: 504,
          body: {
            error: "device_call_timeout",
            message: "Starlink did not answer the WiFi config update in time. Try again.",
          },
        };
      }
      return {
        status: 502,
        body: { error: "device_call_failed", message: (error as Error).message },
      };
    }
  }

  /** Shares deviceMutationTail with updateClient above: both rewrite pieces of
   *  the same router WifiConfig, so a rename in flight and a DNS change in
   *  flight must not be built from the same stale snapshot. */
  function updateWifiConfig(update: RouterWifiConfigUpdate): Promise<CloudResult> {
    if (!validWifiConfigUpdate(update))
      return Promise.resolve({ status: 400, body: { error: "bad_request" } });

    const mutation = deviceMutationTail.then(() => applyWifiConfigUpdate(update));
    deviceMutationTail = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }

  // The four windows the app itself offers for swupdate_reboot_hour (see
  // updateWindowFor in the settings UI) — the field is a uint32, but only
  // these values are ones a renderer should ever be allowed to send.
  const SWUPDATE_REBOOT_HOURS = [3, 9, 15, 21];

  /** Every key here must be a real DishConfigJson field the dish accepts --
   *  the renderer names a change, never protobuf, same trust boundary as the
   *  router validators above. */
  function validDishConfigChanges(changes: DishConfigJson): boolean {
    if (typeof changes !== "object" || changes === null) return false;
    if (!Object.keys(changes).every((key) => DISH_CONFIG_KEYS.has(key))) return false;
    return (
      (changes.snowMeltMode === undefined || VALID_SNOW_MELT_MODES.has(changes.snowMeltMode)) &&
      (changes.locationRequestMode === undefined ||
        VALID_LOCATION_MODES.has(changes.locationRequestMode)) &&
      (changes.levelDishMode === undefined || VALID_LEVEL_DISH_MODES.has(changes.levelDishMode)) &&
      (changes.powerSaveStartMinutes === undefined ||
        (Number.isInteger(changes.powerSaveStartMinutes) &&
          changes.powerSaveStartMinutes >= 0 &&
          changes.powerSaveStartMinutes < 1440)) &&
      (changes.powerSaveDurationMinutes === undefined ||
        (Number.isInteger(changes.powerSaveDurationMinutes) &&
          changes.powerSaveDurationMinutes > 0 &&
          changes.powerSaveDurationMinutes <= 1440)) &&
      (changes.powerSaveMode === undefined || typeof changes.powerSaveMode === "boolean") &&
      (changes.swupdateRebootHour === undefined ||
        SWUPDATE_REBOOT_HOURS.includes(changes.swupdateRebootHour)) &&
      (changes.swupdateThreeDayDeferralEnabled === undefined ||
        typeof changes.swupdateThreeDayDeferralEnabled === "boolean")
    );
  }

  function validDishUpdate(update: DishUpdate): boolean {
    if (update?.kind === "config")
      return validDishConfigChanges(update.changes) && Object.keys(update.changes).length > 0;
    if (update?.kind === "stow") return typeof update.unstow === "boolean";
    if (update?.kind === "clearObstructionMap") return true;
    return false;
  }

  async function applyDishUpdate(update: DishUpdate): Promise<CloudResult> {
    if (!readCookie()) return NOT_CONNECTED;
    try {
      if (!prepareDishUpdate) return { status: 503, body: { error: "dish_update_unavailable" } };
      const requestBytes = await prepareDishUpdate(update);
      const abortSignal = AbortSignal.timeout(deviceCallTimeoutMs);
      await withFreshCookie(async (cookie) => {
        try {
          await grpcWebUnaryCall(DEVICE_HANDLE, requestBytes, abortSignal, {
            fetch: doFetch,
            headers: { cookie },
          });
        } catch (error) {
          if (error instanceof GrpcWebError && error.grpcStatus === 16)
            throw new SessionExpiredError();
          throw error;
        }
      }, abortSignal);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      if (error instanceof SessionExpiredError) return NOT_CONNECTED;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return {
          status: 504,
          body: {
            error: "device_call_timeout",
            message: "Starlink did not answer the dish update in time. Try again.",
          },
        };
      }
      return {
        status: 502,
        body: { error: "device_call_failed", message: (error as Error).message },
      };
    }
  }

  /** Shares deviceMutationTail with the router mutations above. The dish is a
   *  different device and DishConfig has no shared repeated field the way
   *  WifiConfig's networks[] does, so nothing here strictly needs to queue
   *  behind a router write -- but one shared queue for every device mutation
   *  keeps the model simple and avoids firing concurrent calls at the same
   *  cloud Device.Handle endpoint. */
  function updateDishConfig(update: DishUpdate): Promise<CloudResult> {
    if (!validDishUpdate(update))
      return Promise.resolve({ status: 400, body: { error: "bad_request" } });

    const mutation = deviceMutationTail.then(() => applyDishUpdate(update));
    deviceMutationTail = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }

  async function applyRouterConfigUpdate(update: RouterConfigUpdate): Promise<CloudResult> {
    if (!readCookie()) return NOT_CONNECTED;
    let configWriteDispatched = false;
    try {
      if (!prepareRouterConfigUpdate)
        return { status: 503, body: { error: "router_config_update_unavailable" } };
      const abortSignal = AbortSignal.timeout(deviceCallTimeoutMs);
      await withFreshCookie(async (cookie) => {
        const targetId = await resolveControllerId(cookie, abortSignal);
        const callGateway = (requestBytes: Uint8Array) =>
          grpcWebUnaryCall(DEVICE_HANDLE, requestBytes, abortSignal, {
            fetch: doFetch,
            headers: { cookie },
          });
        const requestBytes = await prepareRouterConfigUpdate(update, targetId, callGateway);
        try {
          configWriteDispatched = true;
          await callGateway(requestBytes);
        } catch (error) {
          if (error instanceof GrpcWebError && error.grpcStatus === 16)
            throw new SessionExpiredError();
          throw error;
        }
      }, abortSignal);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      if (error instanceof SessionExpiredError) return NOT_CONNECTED;
      if (error instanceof ControllerUnknownError) return NO_CONTROLLER;
      // A subnet change and a bypass switch both reconfigure the LAN carrying
      // them, so a write that takes effect kills its own reply. How that surfaces
      // is the host's business: a deadline where the request is left hanging, a
      // dead socket where it is not — a service worker's fetch rejects the moment
      // the network goes. Neither is the far end refusing, and only the far end
      // can refuse.
      const seversItsOwnReply = update.kind === "subnet" || update.kind === "bypass";
      if (seversItsOwnReply && configWriteDispatched && !(error instanceof GrpcWebError)) {
        return { status: 200, body: { ok: true, applied: true } };
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return {
          status: 504,
          body: {
            error: "device_call_timeout",
            message: "Starlink did not answer the router change in time. Try again.",
          },
        };
      }
      return {
        status: 502,
        body: { error: "device_call_failed", message: (error as Error).message },
      };
    }
  }

  /** The renderer names a field and its new value, never protobuf. Anything
   *  outside these shapes is refused before the account is touched. */
  function validRouterConfig(update: RouterConfigUpdate): boolean {
    if (update?.kind === "subnet") {
      if (typeof update.subnet !== "string" || typeof update.password !== "string") return false;
      return subnetRefusal(update.subnet, update.password) === null;
    }
    if (update?.kind === "bypass") return typeof update.enabled === "boolean";
    if (update?.kind !== "customDns") return false;
    if (!Array.isArray(update.nameservers)) return false;
    if (!update.nameservers.every((server) => typeof server === "string")) return false;
    return normalizeNameservers(update.nameservers) !== null;
  }

  function updateRouterConfig(update: RouterConfigUpdate): Promise<CloudResult> {
    if (!validRouterConfig(update))
      return Promise.resolve({ status: 400, body: { error: "bad_request" } });
    return applyRouterConfigUpdate(update);
  }

  return {
    handle,
    connect,
    disconnect,
    updateClient,
    updateWifiConfig,
    updateDishConfig,
    updateRouterConfig,
  };
}
