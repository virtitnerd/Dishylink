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
} from "../../lib/routerWifiConfigUpdate";

/** SSIDs with the bands each is broadcast on. One network can appear on several
 *  radios, so they are folded by name rather than listed once per radio. */
function ssidsWithBands(wifiConfig: WifiNetworkConfigJson | null): [string, string[]][] {
  const sets = wifiConfig?.networks?.flatMap((network) => network.basicServiceSets ?? []) ?? [];
  const byName = new Map<string, string[]>();
  for (const set of sets) {
    if (!set.ssid) continue;
    const bands = byName.get(set.ssid) ?? [];
    if (set.band) {
      bands.push(
        set.band.replace("RF_", "").replace("GHZ", " GHz").replace("5 GHz_HIGH", "5 GHz hi"),
      );
    }
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

  const [bypassSaving, setBypassSaving] = useState(false);
  const [bypassResult, setBypassResult] = useState<string | null>(null);
  const saveBypass = async (enabled: boolean) => {
    setBypassSaving(true);
    setBypassResult(null);
    try {
      await setRouterBypassMode(enabled);
      setBypassResult(enabled ? "Enabled — this router's WiFi will drop shortly." : "Disabled.");
    } catch (error) {
      setBypassResult(`Failed: ${(error as Error).message}`);
    } finally {
      setBypassSaving(false);
      window.setTimeout(() => setBypassResult(null), 4000);
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
        <SettingRow key={ssid} title={ssid} caption='WPA2 · password managed in the Starlink app'>
          {[...new Set(bands)].map((band) => (
            <Badge key={band}>{band}</Badge>
          ))}
        </SettingRow>
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

      <SettingRow
        title='Bypass mode'
        caption="Disables this router's own WiFi for a third-party router on its ethernet port -- WiFi drops the moment this is enabled"
        note={bypassResult}
      >
        <Switch
          checked={Boolean(wifiConfig.bypassMode)}
          disabled={!cloudConnected || bypassSaving}
          onCheckedChange={(enabled) => void saveBypass(enabled)}
        />
      </SettingRow>

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
