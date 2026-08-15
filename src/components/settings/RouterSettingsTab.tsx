// Router information and maintenance — the Router half of the settings panel.
// Read-mostly by design: the one write here is a reboot.

import { useEffect, useMemo, useState } from "react";
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
import { DishClient, type WifiNetworkConfigJson } from "@core/dishClient";
import type { RouterUnreachable } from "../../lib/routerDiagnosis";
import { Badge } from "@/components/ui/badge";
import {
  DangerAction,
  DangerToggle,
  SectionLabel,
  SettingRow,
  selectContentClass,
  selectItemClass,
  triggerClass,
} from "./settingsChrome";
import { useCloudAccount } from "../../hooks/useCloudAccount";
import {
  setRouterBypassMode,
  setRouterContentFiltering,
  setRouterCustomDns,
  setRouterWifiSsid,
} from "../../lib/routerWifiConfigUpdate";

interface BandInfo {
  /** The literal band value the API needs (RF_2GHZ, ...), not the display label. */
  raw: string;
  label: string;
  hidden: boolean;
}

/** SSIDs with the bands each is broadcast on. One network can appear on several
 *  radios, so they are folded by name rather than listed once per radio. */
function ssidsWithBands(wifiConfig: WifiNetworkConfigJson | null): [string, BandInfo[]][] {
  const sets = wifiConfig?.networks?.flatMap((network) => network.basicServiceSets ?? []) ?? [];
  const byName = new Map<string, BandInfo[]>();
  for (const set of sets) {
    if (!set.ssid || !set.band) continue;
    const bands = byName.get(set.ssid) ?? [];
    bands.push({
      raw: set.band,
      label: set.band.replace("RF_", "").replace("GHZ", " GHz").replace("5 GHz_HIGH", "5 GHz hi"),
      hidden: Boolean(set.hidden),
    });
    byName.set(set.ssid, bands);
  }
  return [...byName.entries()];
}

const FILTERING_LABEL: Record<0 | 1 | 2, string> = {
  0: "No filtering",
  1: "Malware",
  2: "Malware and adult content",
};

export function RouterSettingsTab({
  wifiConfig,
  routerReachable,
  unreachable,
}: {
  wifiConfig: WifiNetworkConfigJson | null;
  routerReachable: boolean | null;
  /** Why the router is silent, when it is. Null while it is answering. */
  unreachable: RouterUnreachable | null;
}) {
  const ssids = useMemo(() => ssidsWithBands(wifiConfig), [wifiConfig]);
  const meshNodes = Object.values(wifiConfig?.meshConfigs ?? {});

  // The three settings below all write through Starlink's cloud gateway
  // instead of the (confirmed blocked) local RPC -- see
  // core/routerWifiConfigUpdate.ts for the full reasoning and the account
  // requirement. All need the account connected.
  const cloudAccount = useCloudAccount(true);
  const cloudConnected = cloudAccount.status === "ready";

  const [dnsDraft, setDnsDraft] = useState("");
  const [dnsSaving, setDnsSaving] = useState(false);
  const [dnsResult, setDnsResult] = useState<string | null>(null);
  useEffect(() => {
    setDnsDraft(wifiConfig?.nameservers?.join(", ") ?? "");
  }, [wifiConfig?.nameservers]);

  const saveDns = async () => {
    const nameservers = dnsDraft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setDnsSaving(true);
    setDnsResult(null);
    try {
      await setRouterCustomDns(nameservers, nameservers.length === 0);
      setDnsResult(nameservers.length ? "Saved — the router will pick it up shortly." : "Cleared.");
    } catch (error) {
      setDnsResult(`Failed: ${(error as Error).message}`);
    } finally {
      setDnsSaving(false);
      window.setTimeout(() => setDnsResult(null), 4000);
    }
  };

  // One SSID group editable at a time. A rename applies to every band that
  // SSID currently broadcasts on -- sequential cloud writes, safe because
  // they share updateWifiConfig's own serialization queue.
  const [editingSsid, setEditingSsid] = useState<string | null>(null);
  const [ssidDraft, setSsidDraft] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [hiddenDraft, setHiddenDraft] = useState(false);
  const [ssidSaving, setSsidSaving] = useState(false);
  const [ssidResult, setSsidResult] = useState<string | null>(null);

  const startEditingSsid = (ssid: string, bands: BandInfo[]) => {
    setEditingSsid(ssid);
    setSsidDraft(ssid);
    setPasswordDraft("");
    setHiddenDraft(bands[0]?.hidden ?? false);
    setSsidResult(null);
  };

  const saveSsid = async (bands: BandInfo[]) => {
    if (!passwordDraft) {
      setSsidResult("Failed: password is required — the router masks it on read, so it must be resupplied on every write.");
      return;
    }
    setSsidSaving(true);
    setSsidResult(null);
    try {
      for (const band of bands) {
        await setRouterWifiSsid(band.raw, ssidDraft, passwordDraft, hiddenDraft);
      }
      setSsidResult("Saved — the router will pick it up shortly.");
      setEditingSsid(null);
    } catch (error) {
      setSsidResult(`Failed: ${(error as Error).message}`);
    } finally {
      setSsidSaving(false);
    }
  };

  // Applies to every configured network in one write (matching the official
  // app's single toggle, not a per-SSID one) -- read back from the first
  // network, since a write always sets them all to the same level.
  const filteringLevel = (wifiConfig?.networks?.[0]?.sandboxId ?? 0) as 0 | 1 | 2;
  const [filteringSaving, setFilteringSaving] = useState(false);
  const [filteringResult, setFilteringResult] = useState<string | null>(null);
  const saveFiltering = async (level: 0 | 1 | 2) => {
    setFilteringSaving(true);
    setFilteringResult(null);
    try {
      await setRouterContentFiltering(level);
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

  if (routerReachable === null) return <Loading message='Contacting the router…' />;
  // Branch on the diagnosis rather than on `routerReachable` again: it is
  // derived from that same flag, so this cannot render an empty callout.
  if (unreachable) return <Callout tone='error'>{unreachable.message}</Callout>;
  if (!wifiConfig) return null;

  return (
    <>
      <SectionLabel>Networks</SectionLabel>
      {ssids.map(([ssid, bands]) => (
        <div key={ssid}>
          <SettingRow
            title={ssid}
            caption={
              cloudConnected
                ? "Rename or re-key this network, written through your connected Starlink account"
                : "WPA2 · password managed in the Starlink app"
            }
            note={editingSsid === ssid ? ssidResult : null}
          >
            {[...new Set(bands.map((b) => b.label))].map((label) => (
              <Badge key={label}>{label}</Badge>
            ))}
            {cloudConnected && editingSsid !== ssid && (
              <button
                className={actionButton("subtle")}
                onClick={() => startEditingSsid(ssid, bands)}
              >
                Edit
              </button>
            )}
          </SettingRow>
          {editingSsid === ssid && (
            <div className='mb-2.5 flex flex-col gap-2 rounded-md border border-hairline bg-[color-mix(in_srgb,var(--ink)_4%,var(--surface))] p-3'>
              <div className='flex items-center gap-2'>
                <span className='w-16 shrink-0 text-[12px] text-muted-foreground'>Name</span>
                <input
                  type='text'
                  className='h-7 flex-1 rounded-sm border border-hairline bg-transparent px-2 text-[12px] text-ink hover:border-input'
                  value={ssidDraft}
                  disabled={ssidSaving}
                  onChange={(event) => setSsidDraft(event.target.value)}
                />
              </div>
              <div className='flex items-center gap-2'>
                <span className='w-16 shrink-0 text-[12px] text-muted-foreground'>Password</span>
                <input
                  type='text'
                  placeholder='required — not read back from the router'
                  className='h-7 flex-1 rounded-sm border border-hairline bg-transparent px-2 font-mono text-[12px] text-ink hover:border-input'
                  value={passwordDraft}
                  disabled={ssidSaving}
                  onChange={(event) => setPasswordDraft(event.target.value)}
                />
              </div>
              <label className='flex items-center gap-2 text-[12px] text-muted-foreground'>
                <Switch checked={hiddenDraft} disabled={ssidSaving} onCheckedChange={setHiddenDraft} />
                Hide this network
              </label>
              <div className='flex items-center gap-2'>
                <button
                  className={actionButton("subtle")}
                  disabled={ssidSaving}
                  onClick={() => void saveSsid(bands)}
                >
                  {ssidSaving ? "Saving…" : "Save"}
                </button>
                <button
                  className={actionButton("subtle")}
                  disabled={ssidSaving}
                  onClick={() => setEditingSsid(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {meshNodes.length > 0 && (
        <>
          <SectionLabel>Mesh nodes</SectionLabel>
          {meshNodes.map((node, nodeIndex) => (
            <SettingRow
              key={nodeIndex}
              title={node.displayName ?? "Mesh node"}
              caption={node.hardwareVersion ? `hardware ${node.hardwareVersion}` : undefined}
            >
              <Badge tone={node.auth !== "MESH_AUTH_TRUSTED" ? "critical" : "neutral"}>
                {node.auth === "MESH_AUTH_TRUSTED" ? "trusted" : (node.auth ?? "unknown")}
              </Badge>
            </SettingRow>
          ))}
        </>
      )}

      {wifiConfig.boot?.evenSideSoftwareVersion && (
        <SettingRow title='Router firmware' caption={`country ${wifiConfig.countryCode ?? "—"}`}>
          <span className='font-mono text-[12px] text-muted-foreground tabular-nums'>
            {wifiConfig.boot.evenSideSoftwareVersion}
          </span>
        </SettingRow>
      )}

      <SectionLabel>Maintenance</SectionLabel>
      <DangerAction
        title='Reboot router'
        caption='WiFi drops for a minute or two; the dish stays up'
        buttonLabel='Reboot'
        confirmLabel='Yes, reboot router'
        onRun={async () => {
          const routerClient = await DishClient.load("router");
          await routerClient.reboot();
          return "Reboot sent — the router is restarting.";
        }}
      />
      <SectionLabel>Advanced</SectionLabel>
      <Callout tone={cloudConnected ? "info" : "error"} className='mb-1'>
        {cloudConnected
          ? "These three write through your connected Starlink account's cloud session, not the local network -- every local write RPC on this router is confirmed blocked on current firmware (Permission denied)."
          : "Confirmed blocked on current firmware (Permission denied on every local write RPC). Connect your Starlink account in the App tab to write these through the cloud instead."}
      </Callout>

      <DangerToggle
        title='Bypass mode'
        caption="Disables this router's own WiFi for a third-party router on its ethernet port"
        checked={Boolean(wifiConfig.bypassMode)}
        disabled={!cloudConnected}
        dangerousWhen={true}
        warning="This will disconnect this router's own WiFi immediately, including whatever you're using to reach it right now. There's no local undo -- recovery needs a factory reset from the Starlink app itself. Only continue if a third-party router is already wired in and ready to take over."
        confirmLabel='Yes, enable bypass mode'
        onConfirm={async (enabled) => {
          await setRouterBypassMode(enabled);
          return enabled ? "Enabled — this router's WiFi will drop shortly." : "Disabled.";
        }}
      />

      <SettingRow
        title='Custom DNS'
        caption={
          cloudConnected
            ? "Comma-separated resolvers; empty clears it. Overridden while content filtering below is on."
            : wifiConfig.nameservers?.length
              ? wifiConfig.nameservers.join(", ")
              : "Using Starlink's default resolvers — connect your account above to change this"
        }
        note={dnsResult}
      >
        {cloudConnected ? (
          <>
            <input
              type='text'
              placeholder='1.1.1.1, 8.8.8.8'
              className='h-7 w-56 rounded-sm border border-hairline bg-transparent px-2 font-mono text-[12px] text-ink hover:border-input'
              value={dnsDraft}
              disabled={dnsSaving}
              onChange={(event) => setDnsDraft(event.target.value)}
            />
            <button className={actionButton("subtle")} disabled={dnsSaving} onClick={() => void saveDns()}>
              {dnsSaving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <Switch
            checked={Boolean(wifiConfig.nameservers?.length) && wifiConfig.customDnsDisabled !== true}
            disabled
          />
        )}
      </SettingRow>

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
    </>
  );
}
