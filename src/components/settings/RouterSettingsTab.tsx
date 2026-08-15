// Router information and maintenance — the Router half of the settings panel.
// Read-mostly by design: the one write here is a reboot.

import { useMemo } from "react";
import { Callout } from "@/components/ui/callout";
import { Loading } from "@/components/ui/loading";
import { Switch } from "@/components/ui/switch";
import { DishClient, type WifiNetworkConfigJson } from "@core/dishClient";
import type { RouterUnreachable } from "../../lib/routerDiagnosis";
import { Badge } from "@/components/ui/badge";
import { DangerAction, SectionLabel, SettingRow } from "./settingsChrome";

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

/** One row per configured network (content filtering is per-network, not
 *  per-band), labeled by its primary SSID -- falls back to the network's
 *  domain if it somehow has no SSID broadcast at all. */
function networksWithFiltering(
  wifiConfig: WifiNetworkConfigJson | null,
): [string, boolean][] {
  const networks = wifiConfig?.networks ?? [];
  return networks.map((network, index) => {
    const label = network.basicServiceSets?.[0]?.ssid ?? network.domain ?? `Network ${index + 1}`;
    return [label, Boolean(network.sandboxEnabled)];
  });
}

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
  const networksForFiltering = useMemo(() => networksWithFiltering(wifiConfig), [wifiConfig]);

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
      <Callout tone='error' className='mb-1'>
        Confirmed blocked on current firmware: every local write RPC — this router's included —
        returns Permission denied. Starlink's official app writes these through their cloud, not
        the LAN. Shown read-only below, wired up for the moment that changes.
      </Callout>

      <SettingRow
        title='Bypass mode'
        caption="Disables this router's own WiFi for a third-party router on its ethernet port"
      >
        <Switch checked={Boolean(wifiConfig.bypassMode)} disabled />
      </SettingRow>

      <SettingRow
        title='Custom DNS'
        caption={
          wifiConfig.nameservers?.length
            ? wifiConfig.nameservers.join(", ")
            : "Using Starlink's default resolvers"
        }
      >
        <Switch
          checked={Boolean(wifiConfig.nameservers?.length) && wifiConfig.customDnsDisabled !== true}
          disabled
        />
      </SettingRow>

      {networksForFiltering.map(([label, sandboxEnabled]) => (
        <SettingRow key={label} title={`Content filtering — ${label}`} caption='Sandboxes this network to an allow-list of domains'>
          <Switch checked={sandboxEnabled} disabled />
        </SettingRow>
      ))}
    </>
  );
}
