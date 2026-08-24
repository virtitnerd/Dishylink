// Router information and maintenance — the Router half of the settings panel.
// Read-mostly by design: the one write here is a reboot.

import { useMemo, useState } from "react";
import { Callout } from "@/components/ui/callout";
import { Loading } from "@/components/ui/loading";
import { Switch } from "@/components/ui/switch";
import { actionButton } from "@/components/ui/action-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DishClient,
  type HtBandwidth,
  type TxPowerLevel,
  type VhtBandwidth,
  type WifiBasicServiceSetJson,
  type WifiLanNetworkJson,
  type WifiNetworkConfigJson,
  type WifiSecurityType,
  type WirelessMode,
} from "@core/dishClient";
import type { RouterUnreachable } from "../../lib/routerDiagnosis";
import { Badge } from "@/components/ui/badge";
import {
  DangerAction,
  SectionLabel,
  SettingRow,
  selectContentClass,
  selectItemClass,
  triggerClass,
} from "./settingsChrome";
import { RouterAddressRow } from "./RouterAddressRow";
import { SubnetSection } from "./SubnetSection";
import { CustomDnsSection } from "./CustomDnsSection";
import { BypassSection } from "./BypassSection";
import type { CloudAccount } from "../../lib/starlinkCloud";
import { routerAddressForSubnet } from "@core/routerConfigUpdate";
import { routerAddressHost } from "../../lib/routerAddressHost";
import { applyRouterConfigUpdate } from "../../lib/routerConfigUpdate";
import { useCloudAccount, useCloudRouterSubnet } from "../../hooks/useCloudAccount";
import { useRouterAddressState } from "../../hooks/useRouterAddress";
import { routerPresence } from "@core/routerPresence";
import type { DishStatusJson } from "@core/dishClient";
import {
  SUBNET_OPTIONS,
  addRouterNetwork,
  deleteRouterNetwork,
  networkModeOf,
  setMeshNodeTrust,
  setRouterAdvanced,
  setRouterContentFiltering,
  setRouterNetworkSettings,
  setRouterWifiSsid,
  type NetworkMode,
} from "../../lib/routerWifiConfigUpdate";

const BAND_LABEL: Record<string, string> = {
  RF_2GHZ: "2 GHz",
  RF_5GHZ: "5 GHz",
  RF_5GHZ_HIGH: "5 GHz hi",
};

const MODE_LABEL: Record<NetworkMode, string> = {
  default: "Default",
  guest: "Guest",
  auto: "Auto",
};

const FILTERING_LABEL: Record<0 | 1 | 2, string> = {
  0: "No filtering",
  1: "Malware",
  2: "Malware and adult content",
};

const SECURITY_LABEL: Record<WifiSecurityType, string> = {
  wpa2: "WPA2",
  wpa3: "WPA3",
  wpa2wpa3: "WPA2/WPA3",
  open: "Open (no password)",
};
const SECURITY_OPTIONS = Object.keys(SECURITY_LABEL) as WifiSecurityType[];

const TX_POWER_LABEL: Record<TxPowerLevel, string> = {
  TX_POWER_LEVEL_100: "100%",
  TX_POWER_LEVEL_80: "80%",
  TX_POWER_LEVEL_50: "50%",
  TX_POWER_LEVEL_25: "25%",
  TX_POWER_LEVEL_12: "12%",
  TX_POWER_LEVEL_6: "6%",
};
const TX_POWER_OPTIONS = Object.keys(TX_POWER_LABEL) as TxPowerLevel[];

const WIRELESS_MODE_LABEL: Record<WirelessMode, string> = {
  WIRELESS_MODE_DEFAULT: "Auto",
  A_ONLY: "802.11a only",
  B_ONLY: "802.11b only",
  G_ONLY: "802.11g only",
  N_ONLY: "802.11n only",
  B_G_MIXED: "802.11 b/g",
  A_N_MIXED: "802.11 a/n",
  G_N_MIXED: "802.11 g/n",
  B_G_N_MIXED: "802.11 b/g/n",
  A_AN_AC_MIXED: "802.11 a/n/ac",
  AN_AC_MIXED: "802.11 n/ac",
  B_G_N_AX_MIXED: "802.11 b/g/n/ax",
  A_AN_AC_AX_MIXED: "802.11 a/n/ac/ax",
};
const WIRELESS_MODE_OPTIONS = Object.keys(WIRELESS_MODE_LABEL) as WirelessMode[];

const HT_BANDWIDTH_LABEL: Record<HtBandwidth, string> = {
  HT_BANDWIDTH_DEFAULT: "Auto",
  HT_BANDWIDTH_20_MHZ: "20 MHz",
  HT_BANDWIDTH_20_OR_40_MHZ: "20/40 MHz",
};
const HT_BANDWIDTH_OPTIONS = Object.keys(HT_BANDWIDTH_LABEL) as HtBandwidth[];

const VHT_BANDWIDTH_LABEL: Record<VhtBandwidth, string> = {
  VHT_BANDWIDTH_DEFAULT: "Auto",
  VHT_BANDWIDTH_DISABLED: "Off",
  VHT_BANDWIDTH_80_MHZ: "80 MHz",
  VHT_BANDWIDTH_160_MHZ: "160 MHz",
  VHT_BANDWIDTH_80_PLUS_80_MHZ: "80+80 MHz",
};
const VHT_BANDWIDTH_OPTIONS = Object.keys(VHT_BANDWIDTH_LABEL) as VhtBandwidth[];

/** One row per configured network (not per SSID name -- two networks could
 *  share a name, and mode/subnet/delete are all per-network). Bands come
 *  straight off basicServiceSets, in whatever order the router reports them. */
function networksOf(wifiConfig: WifiNetworkConfigJson | null): WifiLanNetworkJson[] {
  return wifiConfig?.networks ?? [];
}

/** Which auth_* sub-message is present tells the band's current security type
 *  -- absent everything reads as WPA2, since that's this schema's zero value. */
function securityOf(bss: WifiBasicServiceSetJson | undefined): WifiSecurityType {
  if (!bss) return "wpa2";
  if (bss.authWpa3) return "wpa3";
  if (bss.authWpa2Wpa3) return "wpa2wpa3";
  if (bss.authOpen) return "open";
  return "wpa2";
}

/** "domain,domain=addr,addr" per line -- a plain-text editor for the two DNS
 *  override lists and static routes, since a full add/remove-row UI for a
 *  handful of rarely-touched entries isn't worth the extra state machinery. */
function parseEntryPairs(text: string): { left: string[]; right: string[] }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [left, right] = line.split("=");
      return {
        left: (left ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        right: (right ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    })
    .filter((e) => e.left.length > 0 && e.right.length > 0);
}

function parseRoutePairs(text: string): { subnet: string; gateway: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [subnet, gateway] = line.split("=").map((s) => s.trim());
      return { subnet: subnet ?? "", gateway: gateway ?? "" };
    })
    .filter((r) => r.subnet && r.gateway);
}

/** Edit form state for one network, seeded from its current config. */
function draftFrom(network: WifiLanNetworkJson) {
  const bands = network.basicServiceSets ?? [];
  const primary = bands[0];
  const split = new Set(bands.map((b) => b.ssid)).size > 1;
  const perBand: Record<
    string,
    { ssid: string; password: string; disable: boolean; security: WifiSecurityType }
  > = {};
  for (const b of bands) {
    if (b.band)
      perBand[b.band] = {
        ssid: b.ssid ?? "",
        password: "",
        disable: Boolean(b.disable),
        security: securityOf(b),
      };
  }
  return {
    ssid: primary?.ssid ?? "",
    password: "",
    hidden: Boolean(primary?.hidden),
    split,
    perBand,
    mode: networkModeOf(network) ?? ("default" as NetworkMode),
    ipv4: network.ipv4 ?? SUBNET_OPTIONS[0],
    advancedOpen: false,
    dhcpv4Start: String(network.dhcpv4Start ?? 20),
    dhcpv4End: String(network.dhcpv4End ?? 254),
    dhcpv4LeaseDurationS: String(network.dhcpv4LeaseDurationS ?? 3600),
    dhcpDisabled: Boolean(network.dhcpDisabled),
    dnsDisabled: Boolean(network.dnsDisabled),
    dnsStaticEntriesText: (network.dnsStaticEntries ?? [])
      .map((e) => `${(e.domains ?? []).join(",")}=${(e.addresses ?? []).join(",")}`)
      .join("\n"),
    dnsForwardRulesText: (network.dnsForwardRules ?? [])
      .map((e) => `${(e.domains ?? []).join(",")}=${(e.serverAddresses ?? []).join(",")}`)
      .join("\n"),
    staticRoutesText: (network.staticRoutes ?? [])
      .map((r) => `${r.subnet ?? ""}=${r.gateway ?? ""}`)
      .join("\n"),
  };
}
type NetworkDraft = ReturnType<typeof draftFrom>;

/** The controller's bypass state, or null when the account has not said. A mesh
 *  node reports as a router too and is never the bypassed one, so the controller
 *  is picked the way the cloud handler picks its write target: zero hops. */
function controllerBypassed(account: CloudAccount | null): boolean | null {
  for (const device of Object.values(account?.deviceTelemetry ?? {})) {
    if (device.kind === "router" && device.hops === 0) return device.isBypassed ?? null;
  }
  return null;
}

export function RouterSettingsTab({
  wifiConfig,
  dishStatus,
  routerReachable,
  viaAccount,
  unreachable,
  onConfigChanged,
}: {
  wifiConfig: WifiNetworkConfigJson | null;
  dishStatus: DishStatusJson | null;
  routerReachable: boolean | null;
  /** Whether `wifiConfig` was read through the account because the LAN could not
   *  serve it. What it says is the same either way; what still cannot be done
   *  from here is anything that dials the router directly. */
  viaAccount: boolean;
  /** Why the router is silent, when it is. Null while it is answering. */
  unreachable: RouterUnreachable | null;
  /** For a write that leaves the router up, which nothing else would re-read.
   *  A write that takes it down is covered by the read on its return instead. */
  onConfigChanged: () => void;
}) {
  const networks = useMemo(() => networksOf(wifiConfig), [wifiConfig]);
  const meshNodes = Object.entries(wifiConfig?.meshConfigs ?? {});

  // Everything in this file past Mesh nodes / Router firmware writes through
  // Starlink's cloud gateway instead of the (confirmed blocked) local RPC --
  // see core/routerWifiConfigUpdate.ts for the full reasoning. All of it
  // needs the account connected.
  const cloudAccount = useCloudAccount(true);
  const cloudConnected = cloudAccount.status === "ready";

  // The subnet write has no local path (the router may not even be on the LAN
  // once the account is the only way to reach it), so the control is disabled
  // up front rather than failing at the moment Save is pressed.
  const [addresses, setAddresses] = useRouterAddressState();
  // A store still on its first read says nothing either way, and the retry loop
  // keeps flicking it back through "loading", so the first answer is remembered.
  const [accountAnswered, setAccountAnswered] = useState(false);
  if (!accountAnswered && cloudAccount.status !== "loading") setAccountAnswered(true);
  const lanSubnet = wifiConfig?.networks?.[0]?.ipv4 ?? null;
  // The account is asked only when the router itself cannot answer, which costs
  // a round trip to Starlink for something the LAN gives away for free.
  const { data: cloudSubnet, reload: rereadCloudSubnet } = useCloudRouterSubnet(
    cloudConnected && lanSubnet === null,
  );

  // Only the rows that ask the router something over the LAN wait on it. Bypass
  // mode is the one Advanced control that must keep working when this is false --
  // that's the whole point of it riding the account instead (see BypassSection's
  // own header comment).
  const answering = routerReachable !== null && !unreachable && wifiConfig !== null;
  // What the config says is worth showing however it arrived -- and the writes
  // beside it go through the account, not the LAN, so they were never waiting on
  // the router to answer here in the first place.
  const configKnown = wifiConfig !== null && (answering || viaAccount);
  const showDns = configKnown && !wifiConfig?.customDnsDisabled;
  // Read from the account rather than the router: a bypassed router answers
  // nothing on the LAN, so `wifiConfig` is silent exactly when the answer is yes.
  const bypassed = controllerBypassed(cloudAccount.data);

  const [editingDomain, setEditingDomain] = useState<string | null>(null);
  const [draft, setDraft] = useState<NetworkDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const startEditing = (network: WifiLanNetworkJson) => {
    setEditingDomain(network.domain ?? null);
    setDraft(draftFrom(network));
    setResult(null);
  };

  const saveNetwork = async (network: WifiLanNetworkJson) => {
    if (!draft || !network.domain) return;
    const bands = network.basicServiceSets ?? [];
    const passwordFor = (band: string) =>
      draft.split ? draft.perBand[band]?.password : draft.password;
    const missingPassword = bands.some((b) => {
      if (!b.band) return false;
      const security = draft.perBand[b.band]?.security ?? "wpa2";
      return security !== "open" && !passwordFor(b.band);
    });
    if (missingPassword) {
      setResult(
        "Failed: password is required for every secured band — the router masks it on read, so it must be resupplied on every write.",
      );
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      for (const bss of bands) {
        if (!bss.band) continue;
        const perBand = draft.perBand[bss.band];
        const ssid = draft.split ? (perBand?.ssid ?? "") : draft.ssid;
        const password = draft.split ? (perBand?.password ?? "") : draft.password;
        await setRouterWifiSsid(network.domain, bss.band, ssid, password, {
          hidden: draft.hidden,
          disable: perBand?.disable,
          security: perBand?.security,
        });
      }
      await setRouterNetworkSettings(network.domain, {
        mode: draft.mode,
        ipv4: draft.ipv4,
        dhcpv4Start: Number(draft.dhcpv4Start),
        dhcpv4End: Number(draft.dhcpv4End),
        dhcpv4LeaseDurationS: Number(draft.dhcpv4LeaseDurationS),
        dhcpDisabled: draft.dhcpDisabled,
        dnsDisabled: draft.dnsDisabled,
        dnsStaticEntries: parseEntryPairs(draft.dnsStaticEntriesText).map((e) => ({
          domains: e.left,
          addresses: e.right,
        })),
        dnsForwardRules: parseEntryPairs(draft.dnsForwardRulesText).map((e) => ({
          domains: e.left,
          serverAddresses: e.right,
        })),
        staticRoutes: parseRoutePairs(draft.staticRoutesText),
      });
      setResult("Saved — the router will pick it up shortly.");
      setEditingDomain(null);
    } catch (error) {
      setResult(`Failed: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const [deletingDomain, setDeletingDomain] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addSsid, setAddSsid] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [addIpv4, setAddIpv4] = useState<string>(SUBNET_OPTIONS[0]);
  const [addMode, setAddMode] = useState<NetworkMode>("default");
  const [addSaving, setAddSaving] = useState(false);
  const [addResult, setAddResult] = useState<string | null>(null);

  const usedSubnets = new Set(networks.map((n) => n.ipv4).filter(Boolean));
  const availableSubnets = SUBNET_OPTIONS.filter((s) => !usedSubnets.has(s));

  const createNetwork = async () => {
    if (!addSsid || !addPassword) {
      setAddResult("Failed: name and password are both required.");
      return;
    }
    setAddSaving(true);
    setAddResult(null);
    try {
      await addRouterNetwork(addSsid, addPassword, addIpv4, addMode);
      setAddResult("Created — the router will pick it up shortly.");
      setAddOpen(false);
      setAddSsid("");
      setAddPassword("");
    } catch (error) {
      setAddResult(`Failed: ${(error as Error).message}`);
    } finally {
      setAddSaving(false);
    }
  };

  // Applies to every configured network in one write (matching the official
  // app's single toggle, not a per-SSID one) -- read back from the first
  // network, since a write always sets them all to the same level.
  const filteringLevel = (wifiConfig?.networks?.[0]?.sandboxId ?? 0) as 0 | 1 | 2;
  const [filteringSaving, setFilteringSaving] = useState(false);
  const [filteringResult, setFilteringResult] = useState<string | null>(null);
  const [allowDomainsDraft, setAllowDomainsDraft] = useState(() =>
    (wifiConfig?.networks?.[0]?.sandboxDomainAllowList ?? []).join(", "),
  );
  // Re-sync the draft whenever a fresh poll brings a new networks array, without an
  // effect -- React's "adjust state during render" pattern avoids the extra render
  // an effect would cost, and setAllowDomainsDraft here is a render-time update
  // guarded by the identity check, not an unconditional side effect.
  const [prevNetworksForDraft, setPrevNetworksForDraft] = useState(wifiConfig?.networks);
  if (wifiConfig?.networks !== prevNetworksForDraft) {
    setPrevNetworksForDraft(wifiConfig?.networks);
    setAllowDomainsDraft((wifiConfig?.networks?.[0]?.sandboxDomainAllowList ?? []).join(", "));
  }
  const saveFiltering = async (level: 0 | 1 | 2, allowDomains?: string[]) => {
    setFilteringSaving(true);
    setFilteringResult(null);
    try {
      await setRouterContentFiltering(level, allowDomains);
      setFilteringResult(
        level === 0
          ? "Cleared."
          : "Saved — this overrides any custom DNS on the router while it's on.",
      );
    } catch (error) {
      setFilteringResult(`Failed: ${(error as Error).message}`);
    } finally {
      setFilteringSaving(false);
      window.setTimeout(() => setFilteringResult(null), 4000);
    }
  };

  // Every radio/onboarding control below fires its own write immediately on
  // change (no separate edit-then-save step -- there's nothing to batch, each
  // is a single flat WifiConfig field), sharing one busy/result pair keyed by
  // field name the same way StarlinkSettingsTab's dish controls do.
  const [radioBusy, setRadioBusy] = useState(false);
  const [radioResult, setRadioResult] = useState<{ field: string; message: string } | null>(null);
  const radioNoteFor = (field: string) =>
    radioResult?.field === field ? radioResult.message : undefined;
  const saveRadio = (field: string, patch: Parameters<typeof setRouterAdvanced>[0]) => {
    setRadioBusy(true);
    setRadioResult(null);
    void setRouterAdvanced(patch)
      .then(() => setRadioResult({ field, message: "Saved — the router will pick it up shortly." }))
      .catch((error) => setRadioResult({ field, message: `Failed: ${(error as Error).message}` }))
      .finally(() => {
        setRadioBusy(false);
        window.setTimeout(() => setRadioResult((r) => (r?.field === field ? null : r)), 4000);
      });
  };
  const radioDisabled = radioBusy || !cloudConnected;

  const [channelDrafts, setChannelDrafts] = useState<Record<string, string>>({});
  const channelValue = (field: "channel2ghz" | "channel5ghz" | "channel5ghzHigh") =>
    channelDrafts[field] ?? String(wifiConfig?.[field] ?? "");

  const [meshBusyId, setMeshBusyId] = useState<string | null>(null);
  const [meshResult, setMeshResult] = useState<{ id: string; message: string } | null>(null);
  const toggleMeshTrust = async (deviceId: string, trusted: boolean) => {
    setMeshBusyId(deviceId);
    setMeshResult(null);
    try {
      await setMeshNodeTrust(deviceId, trusted);
      setMeshResult({ id: deviceId, message: trusted ? "Trusted." : "Untrusted." });
    } catch (error) {
      setMeshResult({ id: deviceId, message: `Failed: ${(error as Error).message}` });
    } finally {
      setMeshBusyId(null);
      window.setTimeout(() => setMeshResult((r) => (r?.id === deviceId ? null : r)), 4000);
    }
  };

  return (
    <>
      {routerReachable === null && <Loading message='Contacting the router…' />}
      {/* Branch on the diagnosis rather than on `routerReachable` again: it is
          derived from that same flag, so this cannot render an empty callout. */}
      {unreachable && <Callout tone='error'>{unreachable.message}</Callout>}

      {configKnown && (
        <>
          <SectionLabel>Networks</SectionLabel>
          {networks.map((network, index) => {
            const bands = network.basicServiceSets ?? [];
            const primarySsid = bands[0]?.ssid ?? network.domain ?? `Network ${index + 1}`;
            const isEditing = editingDomain === network.domain;
            const isFirst = index === 0;

            return (
              <div key={network.domain ?? index}>
                <SettingRow
                  title={primarySsid}
                  caption={
                    cloudConnected
                      ? `${MODE_LABEL[networkModeOf(network) ?? "default"]} · ${network.ipv4 ?? "—"}`
                      : "WPA2 · password managed in the Starlink app"
                  }
                  note={isEditing ? result : null}
                >
                  {[...new Set(bands.map((b) => b.band).filter(Boolean))].map((band) => (
                    <Badge key={band}>{BAND_LABEL[band!] ?? band}</Badge>
                  ))}
                  {cloudConnected && !isEditing && (
                    <button
                      className={actionButton("subtle")}
                      onClick={() => startEditing(network)}
                    >
                      Edit
                    </button>
                  )}
                </SettingRow>

                {isEditing && draft && (
                  <div className='mb-2.5 flex flex-col gap-2.5 rounded-md border border-hairline bg-[color-mix(in_srgb,var(--ink)_4%,var(--surface))] p-3'>
                    <label className='flex items-center gap-2 text-[12px] text-muted-foreground'>
                      <Switch
                        checked={draft.split}
                        disabled={saving}
                        onCheckedChange={(split) => setDraft({ ...draft, split })}
                      />
                      Use different names for 2.4GHz and 5GHz
                    </label>

                    {!draft.split ? (
                      <>
                        <FormRow label='Name'>
                          <input
                            type='text'
                            className={textInputClass}
                            value={draft.ssid}
                            disabled={saving}
                            onChange={(e) => setDraft({ ...draft, ssid: e.target.value })}
                          />
                        </FormRow>
                        <FormRow label='Password'>
                          <input
                            type='text'
                            placeholder='required — not read back from the router'
                            className={monoInputClass}
                            value={draft.password}
                            disabled={saving}
                            onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                          />
                        </FormRow>
                      </>
                    ) : (
                      bands.map(
                        (bss) =>
                          bss.band && (
                            <div
                              key={bss.band}
                              className='flex flex-col gap-1.5 border-l-2 border-hairline pl-2.5'
                            >
                              <span className='text-[11px] font-medium text-muted-foreground'>
                                {BAND_LABEL[bss.band] ?? bss.band}
                              </span>
                              <FormRow label='Name'>
                                <input
                                  type='text'
                                  className={textInputClass}
                                  value={draft.perBand[bss.band]?.ssid ?? ""}
                                  disabled={saving}
                                  onChange={(e) =>
                                    setDraft({
                                      ...draft,
                                      perBand: {
                                        ...draft.perBand,
                                        [bss.band!]: {
                                          ...draft.perBand[bss.band!],
                                          ssid: e.target.value,
                                        },
                                      },
                                    })
                                  }
                                />
                              </FormRow>
                              <FormRow label='Password'>
                                <input
                                  type='text'
                                  placeholder='required'
                                  className={monoInputClass}
                                  value={draft.perBand[bss.band]?.password ?? ""}
                                  disabled={saving}
                                  onChange={(e) =>
                                    setDraft({
                                      ...draft,
                                      perBand: {
                                        ...draft.perBand,
                                        [bss.band!]: {
                                          ...draft.perBand[bss.band!],
                                          password: e.target.value,
                                        },
                                      },
                                    })
                                  }
                                />
                              </FormRow>
                            </div>
                          ),
                      )
                    )}

                    {/* Security type and per-band disable, independent of the
                    split-name choice above -- the schema carries both on each
                    BasicServiceSet regardless of whether its name is shared. */}
                    {bands.map(
                      (bss) =>
                        bss.band && (
                          <div key={`sec-${bss.band}`} className='flex items-center gap-2'>
                            <span className='w-16 shrink-0 text-[12px] text-muted-foreground'>
                              {BAND_LABEL[bss.band] ?? bss.band}
                            </span>
                            <Select
                              value={draft.perBand[bss.band]?.security ?? "wpa2"}
                              disabled={saving}
                              onValueChange={(security) =>
                                setDraft({
                                  ...draft,
                                  perBand: {
                                    ...draft.perBand,
                                    [bss.band!]: {
                                      ...draft.perBand[bss.band!],
                                      security: security as WifiSecurityType,
                                    },
                                  },
                                })
                              }
                            >
                              <SelectTrigger className={triggerClass} style={{ width: 150 }}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className={selectContentClass}>
                                {SECURITY_OPTIONS.map((opt) => (
                                  <SelectItem key={opt} value={opt} className={selectItemClass}>
                                    {SECURITY_LABEL[opt]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <label className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
                              <Switch
                                checked={Boolean(draft.perBand[bss.band]?.disable)}
                                disabled={saving}
                                onCheckedChange={(disable) =>
                                  setDraft({
                                    ...draft,
                                    perBand: {
                                      ...draft.perBand,
                                      [bss.band!]: { ...draft.perBand[bss.band!], disable },
                                    },
                                  })
                                }
                              />
                              Off
                            </label>
                          </div>
                        ),
                    )}

                    <label className='flex items-center gap-2 text-[12px] text-muted-foreground'>
                      <Switch
                        checked={draft.hidden}
                        disabled={saving}
                        onCheckedChange={(hidden) => setDraft({ ...draft, hidden })}
                      />
                      Hide this network
                    </label>

                    <FormRow label='Mode'>
                      <Select
                        value={draft.mode}
                        disabled={saving}
                        onValueChange={(mode) => setDraft({ ...draft, mode: mode as NetworkMode })}
                      >
                        <SelectTrigger className={triggerClass} style={{ width: 140 }}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className={selectContentClass}>
                          {(["default", "guest", "auto"] as const).map((mode) => (
                            <SelectItem key={mode} value={mode} className={selectItemClass}>
                              {MODE_LABEL[mode]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormRow>

                    <FormRow label='Subnet'>
                      <Select
                        value={draft.ipv4}
                        disabled={saving}
                        onValueChange={(ipv4) => setDraft({ ...draft, ipv4 })}
                      >
                        <SelectTrigger className={triggerClass} style={{ width: 160 }}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className={selectContentClass}>
                          {SUBNET_OPTIONS.map((subnet) => (
                            <SelectItem
                              key={subnet}
                              value={subnet}
                              className={selectItemClass}
                              disabled={usedSubnets.has(subnet) && subnet !== network.ipv4}
                            >
                              {subnet}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormRow>

                    <button
                      className={`${actionButton("subtle")} w-fit`}
                      onClick={() => setDraft({ ...draft, advancedOpen: !draft.advancedOpen })}
                    >
                      {draft.advancedOpen ? "Hide advanced" : "Advanced (not in the official app)"}
                    </button>
                    {draft.advancedOpen && (
                      <div className='flex flex-col gap-2 border-l-2 border-hairline pl-2.5'>
                        <FormRow label='DHCP start'>
                          <input
                            type='number'
                            className={narrowInputClass}
                            value={draft.dhcpv4Start}
                            disabled={saving}
                            onChange={(e) => setDraft({ ...draft, dhcpv4Start: e.target.value })}
                          />
                        </FormRow>
                        <FormRow label='DHCP end'>
                          <input
                            type='number'
                            className={narrowInputClass}
                            value={draft.dhcpv4End}
                            disabled={saving}
                            onChange={(e) => setDraft({ ...draft, dhcpv4End: e.target.value })}
                          />
                        </FormRow>
                        <FormRow label='Lease (s)'>
                          <input
                            type='number'
                            className={narrowInputClass}
                            value={draft.dhcpv4LeaseDurationS}
                            disabled={saving}
                            onChange={(e) =>
                              setDraft({ ...draft, dhcpv4LeaseDurationS: e.target.value })
                            }
                          />
                        </FormRow>
                        <label className='flex items-center gap-2 text-[12px] text-muted-foreground'>
                          <Switch
                            checked={draft.dhcpDisabled}
                            disabled={saving}
                            onCheckedChange={(v) => setDraft({ ...draft, dhcpDisabled: v })}
                          />
                          Disable DHCP on this network
                        </label>
                        <label className='flex items-center gap-2 text-[12px] text-muted-foreground'>
                          <Switch
                            checked={draft.dnsDisabled}
                            disabled={saving}
                            onCheckedChange={(v) => setDraft({ ...draft, dnsDisabled: v })}
                          />
                          Disable DNS on this network
                        </label>
                        <div className='flex flex-col gap-1'>
                          <span className='text-[12px] text-muted-foreground'>
                            Static DNS — one per line, domain(s)=address(es)
                          </span>
                          <textarea
                            className={textareaClass}
                            placeholder='myserver.local=192.168.1.50'
                            rows={2}
                            value={draft.dnsStaticEntriesText}
                            disabled={saving}
                            onChange={(e) =>
                              setDraft({ ...draft, dnsStaticEntriesText: e.target.value })
                            }
                          />
                        </div>
                        <div className='flex flex-col gap-1'>
                          <span className='text-[12px] text-muted-foreground'>
                            DNS forwarding — one per line, domain(s)=server(s)
                          </span>
                          <textarea
                            className={textareaClass}
                            placeholder='corp.example=10.0.0.1'
                            rows={2}
                            value={draft.dnsForwardRulesText}
                            disabled={saving}
                            onChange={(e) =>
                              setDraft({ ...draft, dnsForwardRulesText: e.target.value })
                            }
                          />
                        </div>
                        <div className='flex flex-col gap-1'>
                          <span className='text-[12px] text-muted-foreground'>
                            Static routes — one per line, subnet=gateway
                          </span>
                          <textarea
                            className={textareaClass}
                            placeholder='10.10.0.0/24=192.168.1.5'
                            rows={2}
                            value={draft.staticRoutesText}
                            disabled={saving}
                            onChange={(e) =>
                              setDraft({ ...draft, staticRoutesText: e.target.value })
                            }
                          />
                        </div>
                      </div>
                    )}

                    <div className='flex items-center gap-2'>
                      <button
                        className={actionButton("subtle")}
                        disabled={saving}
                        onClick={() => void saveNetwork(network)}
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                      <button
                        className={actionButton("subtle")}
                        disabled={saving}
                        onClick={() => setEditingDomain(null)}
                      >
                        Cancel
                      </button>
                      {!isFirst && deletingDomain !== network.domain && (
                        <button
                          className={actionButton("danger")}
                          disabled={saving}
                          onClick={() => setDeletingDomain(network.domain ?? null)}
                        >
                          Delete network
                        </button>
                      )}
                    </div>

                    {deletingDomain === network.domain && (
                      <DeleteNetworkConfirm
                        domain={network.domain!}
                        onCancel={() => setDeletingDomain(null)}
                        onDeleted={() => {
                          setDeletingDomain(null);
                          setEditingDomain(null);
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {cloudConnected && !addOpen && (
            <SettingRow title='Add a network' caption='Broadcasts on both 2.4GHz and 5GHz to start'>
              <button className={actionButton("subtle")} onClick={() => setAddOpen(true)}>
                Add
              </button>
            </SettingRow>
          )}
          {addOpen && (
            <div className='mb-2.5 flex flex-col gap-2.5 rounded-md border border-hairline bg-[color-mix(in_srgb,var(--ink)_4%,var(--surface))] p-3'>
              <FormRow label='Name'>
                <input
                  type='text'
                  className={textInputClass}
                  value={addSsid}
                  disabled={addSaving}
                  onChange={(e) => setAddSsid(e.target.value)}
                />
              </FormRow>
              <FormRow label='Password'>
                <input
                  type='text'
                  className={monoInputClass}
                  value={addPassword}
                  disabled={addSaving}
                  onChange={(e) => setAddPassword(e.target.value)}
                />
              </FormRow>
              <FormRow label='Mode'>
                <Select
                  value={addMode}
                  disabled={addSaving}
                  onValueChange={(v) => setAddMode(v as NetworkMode)}
                >
                  <SelectTrigger className={triggerClass} style={{ width: 140 }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={selectContentClass}>
                    {(["default", "guest", "auto"] as const).map((mode) => (
                      <SelectItem key={mode} value={mode} className={selectItemClass}>
                        {MODE_LABEL[mode]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormRow>
              <FormRow label='Subnet'>
                <Select value={addIpv4} disabled={addSaving} onValueChange={setAddIpv4}>
                  <SelectTrigger className={triggerClass} style={{ width: 160 }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={selectContentClass}>
                    {SUBNET_OPTIONS.map((subnet) => (
                      <SelectItem
                        key={subnet}
                        value={subnet}
                        className={selectItemClass}
                        disabled={usedSubnets.has(subnet)}
                      >
                        {subnet}
                        {usedSubnets.has(subnet) ? " (in use)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormRow>
              {availableSubnets.length === 0 && (
                <Callout tone='error'>Every predefined subnet is already in use.</Callout>
              )}
              {addResult && <div className='text-[12px] text-muted-foreground'>{addResult}</div>}
              <div className='flex items-center gap-2'>
                <button
                  className={actionButton("subtle")}
                  disabled={addSaving || availableSubnets.length === 0}
                  onClick={() => void createNetwork()}
                >
                  {addSaving ? "Creating…" : "Create"}
                </button>
                <button
                  className={actionButton("subtle")}
                  disabled={addSaving}
                  onClick={() => setAddOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {meshNodes.length > 0 && (
            <>
              <SectionLabel>Mesh nodes</SectionLabel>
              {meshNodes.map(([deviceId, node]) => {
                const trusted = node.auth === "MESH_AUTH_TRUSTED";
                return (
                  <SettingRow
                    key={deviceId}
                    title={node.displayName ?? "Mesh node"}
                    caption={node.hardwareVersion ? `hardware ${node.hardwareVersion}` : undefined}
                    note={meshResult?.id === deviceId ? meshResult.message : null}
                  >
                    <Badge tone={!trusted ? "critical" : "neutral"}>
                      {trusted ? "trusted" : (node.auth ?? "unknown")}
                    </Badge>
                    {cloudConnected && (
                      <button
                        className={actionButton("subtle")}
                        disabled={meshBusyId === deviceId}
                        onClick={() => void toggleMeshTrust(deviceId, !trusted)}
                      >
                        {meshBusyId === deviceId ? "Saving…" : trusted ? "Untrust" : "Trust"}
                      </button>
                    )}
                  </SettingRow>
                );
              })}
            </>
          )}

          {wifiConfig.boot?.evenSideSoftwareVersion && (
            <SettingRow
              title='Router firmware'
              caption={`country ${wifiConfig.countryCode ?? "—"}`}
            >
              <span className='font-mono text-[12px] text-muted-foreground tabular-nums'>
                {wifiConfig.boot.evenSideSoftwareVersion}
              </span>
            </SettingRow>
          )}
        </>
      )}

      <SectionLabel>Maintenance</SectionLabel>
      <DangerAction
        title='Reboot router'
        caption={
          answering
            ? "WiFi drops for a minute or two; the dish stays up"
            : "Unavailable until the router answers"
        }
        buttonLabel='Reboot'
        slideLabel='Slide to reboot router'
        confirmLabel='Reboot router'
        disabled={!answering}
        onRun={async () => {
          const routerClient = await DishClient.load("router");
          await routerClient.reboot();
          return "Reboot sent — the router is restarting.";
        }}
      />
      <DangerAction
        title='Factory reset router'
        caption={
          answering || cloudConnected
            ? "Wipes the WiFi name, password and every router setting. Not reversible."
            : "Needs the router on this network, or your Starlink account"
        }
        buttonLabel='Factory reset'
        slideLabel='Slide to factory reset the router'
        confirmLabel='Factory reset router'
        warning='Factory reset will clear your WiFi network name, password, and other settings. This will interrupt your service until you set it up again.'
        disabled={!answering && !cloudConnected}
        onRun={async () => {
          // A bypassed router is off the LAN, which is exactly when a reset is
          // wanted: the account reaches it there and nothing local does.
          if (!answering) {
            await applyRouterConfigUpdate({ kind: "factoryReset" });
            return "Factory reset sent through your Starlink account — the router is wiping and restarting.";
          }
          await (await DishClient.load("router")).factoryReset();
          return "Factory reset sent — the router is wiping and restarting.";
        }}
      />
      {addresses && (
        <>
          <SectionLabel>Connection</SectionLabel>
          <RouterAddressRow
            addresses={addresses}
            onChanged={(next) => {
              setAddresses(next);
              onConfigChanged();
            }}
          />
        </>
      )}
      <SectionLabel>Network</SectionLabel>
      <SubnetSection
        currentSubnet={lanSubnet ?? cloudSubnet}
        disabled={!cloudConnected}
        onSave={async (subnet, password) => {
          await applyRouterConfigUpdate({ kind: "subnet", password, subnet });
          // The router is about to answer somewhere else, and this is the
          // setting that decides where the app looks for it next.
          const updatedAddresses = await routerAddressHost()?.write(routerAddressForSubnet(subnet));
          if (updatedAddresses?.ok) setAddresses(updatedAddresses.addresses);
          rereadCloudSubnet();
          onConfigChanged();
        }}
      />

      {showDns && (
        <>
          <SectionLabel>DNS</SectionLabel>
          <CustomDnsSection
            nameservers={wifiConfig?.nameservers ?? []}
            disabled={!cloudConnected}
            onSave={async (nameservers) => {
              await applyRouterConfigUpdate({ kind: "customDns", nameservers });
              onConfigChanged();
            }}
          />
        </>
      )}
      <SectionLabel>Bypass</SectionLabel>
      <BypassSection
        reported={bypassed}
        routerAnswering={answering}
        dishPresence={routerPresence(dishStatus)}
        // A failed read is not an absent session, and bypass is what fails reads.
        disabled={!accountAnswered || cloudAccount.status === "not-connected"}
        accountAnswering={cloudConnected}
        onReload={cloudAccount.reload}
        onSave={async (enabled) => {
          await applyRouterConfigUpdate({ kind: "bypass", enabled });
        }}
      />

      {answering && wifiConfig && (
        <>
          <SectionLabel>Advanced</SectionLabel>
          <Callout tone='info' className='mb-1'>
            These write through your connected Starlink account's cloud session, not the local
            network -- every local write RPC on this router is confirmed blocked on current firmware
            (Permission denied).
          </Callout>

          <SettingRow
            title='Content filtering'
            caption='Applies to every network on this router. Overrides custom DNS above while enabled.'
            note={filteringResult}
          >
            {cloudConnected ? (
              <Select
                value={String(filteringLevel)}
                disabled={filteringSaving}
                onValueChange={(value) => void saveFiltering(Number(value) as 0 | 1 | 2)}
              >
                <SelectTrigger className={triggerClass} style={{ width: 200 }}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={selectContentClass}>
                  {([0, 1, 2] as const).map((level) => (
                    <SelectItem key={level} value={String(level)} className={selectItemClass}>
                      {FILTERING_LABEL[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Badge>{FILTERING_LABEL[filteringLevel]}</Badge>
            )}
          </SettingRow>
          {cloudConnected && filteringLevel > 0 && (
            <div className='mb-2.5 flex items-center gap-2 pl-0.5'>
              <span className='w-16 shrink-0 text-[12px] text-muted-foreground'>Allow list</span>
              <input
                type='text'
                placeholder='example.com, another.com'
                className='h-7 flex-1 rounded-sm border border-hairline bg-transparent px-2 font-mono text-[12px] text-ink hover:border-input'
                value={allowDomainsDraft}
                disabled={filteringSaving}
                onChange={(e) => setAllowDomainsDraft(e.target.value)}
              />
              <button
                className={actionButton("subtle")}
                disabled={filteringSaving}
                onClick={() =>
                  void saveFiltering(
                    filteringLevel,
                    allowDomainsDraft
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  )
                }
              >
                Save
              </button>
            </div>
          )}
          <SettingRow
            title='Fail open'
            caption='If content filtering itself becomes unreachable, keep internet working unfiltered rather than blocking it entirely'
            note={radioNoteFor("failOpen")}
          >
            <Switch
              checked={!wifiConfig.disableSandboxFailOpen}
              disabled={radioDisabled}
              onCheckedChange={(failOpen) =>
                saveRadio("failOpen", { disableSandboxFailOpen: !failOpen })
              }
            />
          </SettingRow>

          <SectionLabel>Radio</SectionLabel>
          {(
            [
              ["2.4GHz", "2ghz"],
              ["5GHz", "5ghz"],
              ["5GHz high", "5ghzHigh"],
            ] as const
          ).map(([label, suffix]) => {
            const disableField = `disable${suffix[0].toUpperCase()}${suffix.slice(1)}` as
              "disable2ghz" | "disable5ghz" | "disable5ghzHigh";
            const txField = `txPowerLevel${suffix[0].toUpperCase()}${suffix.slice(1)}` as
              "txPowerLevel2ghz" | "txPowerLevel5ghz" | "txPowerLevel5ghzHigh";
            const channelField = `channel${suffix[0].toUpperCase()}${suffix.slice(1)}` as
              "channel2ghz" | "channel5ghz" | "channel5ghzHigh";
            const modeField = `wirelessMode${suffix[0].toUpperCase()}${suffix.slice(1)}` as
              "wirelessMode2ghz" | "wirelessMode5ghz" | "wirelessMode5ghzHigh";
            const htField = `htBandwidth${suffix[0].toUpperCase()}${suffix.slice(1)}` as
              "htBandwidth2ghz" | "htBandwidth5ghz" | "htBandwidth5ghzHigh";
            return (
              <div key={suffix} className='mb-2 flex flex-col gap-1.5'>
                <span className='font-mono text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase'>
                  {label}
                </span>
                <SettingRow title='Enabled' note={radioNoteFor(disableField)}>
                  <Switch
                    checked={!wifiConfig[disableField]}
                    disabled={radioDisabled}
                    onCheckedChange={(enabled) =>
                      saveRadio(disableField, { [disableField]: !enabled })
                    }
                  />
                </SettingRow>
                <SettingRow title='Transmit power' note={radioNoteFor(txField)}>
                  <Select
                    value={(wifiConfig[txField] as string | undefined) ?? "TX_POWER_LEVEL_100"}
                    disabled={radioDisabled}
                    onValueChange={(v) => saveRadio(txField, { [txField]: v as TxPowerLevel })}
                  >
                    <SelectTrigger className={triggerClass} style={{ width: 90 }}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={selectContentClass}>
                      {TX_POWER_OPTIONS.map((opt) => (
                        <SelectItem key={opt} value={opt} className={selectItemClass}>
                          {TX_POWER_LABEL[opt]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow
                  title='Channel'
                  caption='0 or blank = Auto'
                  note={radioNoteFor(channelField)}
                >
                  <input
                    type='number'
                    className={narrowInputClass}
                    value={channelValue(channelField)}
                    disabled={radioDisabled}
                    onChange={(e) =>
                      setChannelDrafts({ ...channelDrafts, [channelField]: e.target.value })
                    }
                    onBlur={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isInteger(n) && n >= 0 && n <= 200)
                        saveRadio(channelField, { [channelField]: n });
                    }}
                  />
                </SettingRow>
                <SettingRow title='Compatibility mode' note={radioNoteFor(modeField)}>
                  <Select
                    value={(wifiConfig[modeField] as string | undefined) ?? "WIRELESS_MODE_DEFAULT"}
                    disabled={radioDisabled}
                    onValueChange={(v) => saveRadio(modeField, { [modeField]: v as WirelessMode })}
                  >
                    <SelectTrigger className={triggerClass} style={{ width: 170 }}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={selectContentClass}>
                      {WIRELESS_MODE_OPTIONS.map((opt) => (
                        <SelectItem key={opt} value={opt} className={selectItemClass}>
                          {WIRELESS_MODE_LABEL[opt]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow title='Channel width' note={radioNoteFor(htField)}>
                  <Select
                    value={(wifiConfig[htField] as string | undefined) ?? "HT_BANDWIDTH_DEFAULT"}
                    disabled={radioDisabled}
                    onValueChange={(v) => saveRadio(htField, { [htField]: v as HtBandwidth })}
                  >
                    <SelectTrigger className={triggerClass} style={{ width: 110 }}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={selectContentClass}>
                      {HT_BANDWIDTH_OPTIONS.map((opt) => (
                        <SelectItem key={opt} value={opt} className={selectItemClass}>
                          {HT_BANDWIDTH_LABEL[opt]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>
                {suffix !== "2ghz" && (
                  <SettingRow title='VHT width (802.11ac)' note={radioNoteFor(`vht${suffix}`)}>
                    <Select
                      value={
                        ((suffix === "5ghz"
                          ? wifiConfig.vhtBandwidth
                          : wifiConfig.vhtBandwidth5ghzHigh) as string | undefined) ??
                        "VHT_BANDWIDTH_DEFAULT"
                      }
                      disabled={radioDisabled}
                      onValueChange={(v) =>
                        saveRadio(
                          `vht${suffix}`,
                          suffix === "5ghz"
                            ? { vhtBandwidth: v as VhtBandwidth }
                            : { vhtBandwidth5ghzHigh: v as VhtBandwidth },
                        )
                      }
                    >
                      <SelectTrigger className={triggerClass} style={{ width: 110 }}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={selectContentClass}>
                        {VHT_BANDWIDTH_OPTIONS.map((opt) => (
                          <SelectItem key={opt} value={opt} className={selectItemClass}>
                            {VHT_BANDWIDTH_LABEL[opt]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingRow>
                )}
              </div>
            );
          })}
          <SettingRow
            title='Band steering'
            caption='Push dual-band devices onto 5GHz automatically'
            note={radioNoteFor("bandSteering")}
          >
            <Switch
              checked={!wifiConfig.disableBandSteering}
              disabled={radioDisabled}
              onCheckedChange={(enabled) =>
                saveRadio("bandSteering", { disableBandSteering: !enabled })
              }
            />
          </SettingRow>
          <SettingRow title='Allow new mesh nodes to pair' note={radioNoteFor("meshOnboarding")}>
            <Switch
              checked={!wifiConfig.disableMeshOnboarding}
              disabled={radioDisabled}
              onCheckedChange={(enabled) =>
                saveRadio("meshOnboarding", { disableMeshOnboarding: !enabled })
              }
            />
          </SettingRow>
        </>
      )}
    </>
  );
}

const textInputClass =
  "h-7 flex-1 rounded-sm border border-hairline bg-transparent px-2 text-[12px] text-ink hover:border-input";
const monoInputClass =
  "h-7 flex-1 rounded-sm border border-hairline bg-transparent px-2 font-mono text-[12px] text-ink hover:border-input";
const narrowInputClass =
  "h-7 w-24 rounded-sm border border-hairline bg-transparent px-2 font-mono text-[12px] text-ink hover:border-input";
const textareaClass =
  "w-full resize-y rounded-sm border border-hairline bg-transparent px-2 py-1.5 font-mono text-[12px] text-ink hover:border-input";

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex items-center gap-2'>
      <span className='w-16 shrink-0 text-[12px] text-muted-foreground'>{label}</span>
      {children}
    </div>
  );
}

/** Its own armed-confirm, for a fire-once removal rather than a persistent
 *  switch -- deleting a network drops whatever is connected to it immediately. */
function DeleteNetworkConfirm({
  domain,
  onCancel,
  onDeleted,
}: {
  domain: string;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className='flex flex-col gap-2 rounded-md border border-status-critical/40 bg-[color-mix(in_srgb,var(--status-critical)_8%,transparent)] p-3'>
      <p className='m-0 text-[12.5px] leading-relaxed text-status-critical'>
        This deletes the network entirely -- anything connected to it drops immediately and has to
        rejoin a different network. This can't be undone from here.
      </p>
      {error && <p className='m-0 text-[12px] text-status-critical'>{error}</p>}
      <div className='flex items-center gap-2'>
        <button
          className={actionButton("danger")}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await deleteRouterNetwork(domain);
              onDeleted();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Yes, delete this network"}
        </button>
        <button className={actionButton("subtle")} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
