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
import { DishClient, type WifiLanNetworkJson, type WifiNetworkConfigJson } from "@core/dishClient";
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
  SUBNET_OPTIONS,
  addRouterNetwork,
  deleteRouterNetwork,
  networkModeOf,
  setRouterBypassMode,
  setRouterContentFiltering,
  setRouterCustomDns,
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

/** One row per configured network (not per SSID name -- two networks could
 *  share a name, and mode/subnet/delete are all per-network). Bands come
 *  straight off basicServiceSets, in whatever order the router reports them. */
function networksOf(wifiConfig: WifiNetworkConfigJson | null): WifiLanNetworkJson[] {
  return wifiConfig?.networks ?? [];
}

/** Edit form state for one network, seeded from its current config. */
function draftFrom(network: WifiLanNetworkJson) {
  const bands = network.basicServiceSets ?? [];
  const primary = bands[0];
  const split = new Set(bands.map((b) => b.ssid)).size > 1;
  const perBand: Record<string, { ssid: string; password: string }> = {};
  for (const b of bands) {
    if (b.band) perBand[b.band] = { ssid: b.ssid ?? "", password: "" };
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
  };
}
type NetworkDraft = ReturnType<typeof draftFrom>;

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
  const networks = useMemo(() => networksOf(wifiConfig), [wifiConfig]);
  const meshNodes = Object.values(wifiConfig?.meshConfigs ?? {});

  // Everything in this file past Mesh nodes / Router firmware writes through
  // Starlink's cloud gateway instead of the (confirmed blocked) local RPC --
  // see core/routerWifiConfigUpdate.ts for the full reasoning. All of it
  // needs the account connected.
  const cloudAccount = useCloudAccount(true);
  const cloudConnected = cloudAccount.status === "ready";

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
    if ((!draft.split && !draft.password) || (draft.split && bands.some((b) => b.band && !draft.perBand[b.band]?.password))) {
      setResult("Failed: password is required — the router masks it on read, so it must be resupplied on every write.");
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      for (const bss of bands) {
        if (!bss.band) continue;
        const { ssid, password } = draft.split ? draft.perBand[bss.band] : { ssid: draft.ssid, password: draft.password };
        await setRouterWifiSsid(network.domain, bss.band, ssid, password, draft.hidden);
      }
      await setRouterNetworkSettings(network.domain, {
        mode: draft.mode,
        ipv4: draft.ipv4,
        dhcpv4Start: Number(draft.dhcpv4Start),
        dhcpv4End: Number(draft.dhcpv4End),
        dhcpv4LeaseDurationS: Number(draft.dhcpv4LeaseDurationS),
        dhcpDisabled: draft.dhcpDisabled,
        dnsDisabled: draft.dnsDisabled,
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

  const [dnsDraft, setDnsDraft] = useState("");
  const [dnsSaving, setDnsSaving] = useState(false);
  const [dnsResult, setDnsResult] = useState<string | null>(null);
  useMemo(() => setDnsDraft(wifiConfig?.nameservers?.join(", ") ?? ""), [wifiConfig?.nameservers]);
  const saveDns = async () => {
    const nameservers = dnsDraft.split(",").map((s) => s.trim()).filter(Boolean);
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

  if (routerReachable === null) return <Loading message='Contacting the router…' />;
  // Branch on the diagnosis rather than on `routerReachable` again: it is
  // derived from that same flag, so this cannot render an empty callout.
  if (unreachable) return <Callout tone='error'>{unreachable.message}</Callout>;
  if (!wifiConfig) return null;

  return (
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
                <button className={actionButton("subtle")} onClick={() => startEditing(network)}>
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
                        <div key={bss.band} className='flex flex-col gap-1.5 border-l-2 border-hairline pl-2.5'>
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
                                    [bss.band!]: { ...draft.perBand[bss.band!], ssid: e.target.value },
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
                                    [bss.band!]: { ...draft.perBand[bss.band!], password: e.target.value },
                                  },
                                })
                              }
                            />
                          </FormRow>
                        </div>
                      ),
                  )
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
                        onChange={(e) => setDraft({ ...draft, dhcpv4LeaseDurationS: e.target.value })}
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
                  <button className={actionButton("subtle")} disabled={saving} onClick={() => setEditingDomain(null)}>
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
            <Select value={addMode} disabled={addSaving} onValueChange={(v) => setAddMode(v as NetworkMode)}>
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
            <button className={actionButton("subtle")} disabled={addSaving} onClick={() => setAddOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

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
          ? "These two write through your connected Starlink account's cloud session, not the local network -- every local write RPC on this router is confirmed blocked on current firmware (Permission denied)."
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

const textInputClass =
  "h-7 flex-1 rounded-sm border border-hairline bg-transparent px-2 text-[12px] text-ink hover:border-input";
const monoInputClass =
  "h-7 flex-1 rounded-sm border border-hairline bg-transparent px-2 font-mono text-[12px] text-ink hover:border-input";
const narrowInputClass =
  "h-7 w-24 rounded-sm border border-hairline bg-transparent px-2 font-mono text-[12px] text-ink hover:border-input";

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex items-center gap-2'>
      <span className='w-16 shrink-0 text-[12px] text-muted-foreground'>{label}</span>
      {children}
    </div>
  );
}

/** Its own armed-confirm, separate from DangerToggle (which is for a
 *  persistent switch, not a fire-once removal) -- deleting a network drops
 *  whatever is connected to it immediately. */
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
