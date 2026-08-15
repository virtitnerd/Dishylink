// App-level display choices — the ones that are about Dishylink itself, not the
// dish or the router. Kept in their own tab so the two device tabs stay a mirror
// of the official app and app preferences don't masquerade as dish config.
//
// The toolbar choice is universal (web, extension, desktop); the throughput
// readout is a desktop feature — the macOS menu bar or the Windows taskbar — so
// that row appears only where the desktop host actually exposes it. Presence of
// the method is the whole gate; the host's `platform` only words the copy.

import { useEffect, useState, useSyncExternalStore } from "react";
import { Switch } from "@/components/ui/switch";
import { actionButton } from "@/components/ui/action-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionLabel, SettingRow, selectContentClass, selectItemClass, triggerClass } from "./settingsChrome";
import {
  readToolbarStyle,
  setToolbarStyle,
  subscribeToToolbarStyle,
  type ToolbarStyle,
} from "../../lib/toolbarStyle";
import { apiRequest } from "../../lib/apiHost";

interface WebhookConfig {
  url: string;
  enabled: boolean;
}

/**
 * Fires server-side, from the historian's own poll loop (see backend/webhook.py)
 * -- not "the browser noticed an alert and called a relay endpoint", which is
 * this project's own earlier approach and only works while a tab is open. A
 * webhook's whole point is to reach you when you're *not* looking at the page.
 */
function useWebhookSettings() {
  const [config, setConfig] = useState<WebhookConfig | null>(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiRequest("/api/settings/webhook")
      .then((res) => res.json())
      .then((payload: { ok: boolean; data?: WebhookConfig }) => {
        if (cancelled || !payload.ok || !payload.data) return;
        setConfig(payload.data);
        setDraftUrl(payload.data.url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (patch: Partial<WebhookConfig>) => {
    const next = { url: draftUrl, enabled: Boolean(config?.enabled), ...config, ...patch };
    setSaving(true);
    setError(null);
    try {
      const res = await apiRequest("/api/settings/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const payload = (await res.json()) as { ok: boolean; data?: WebhookConfig; error?: string };
      if (!payload.ok) {
        setError(payload.error ?? "failed to save");
        return;
      }
      setConfig(payload.data ?? null);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTestState("sending");
    try {
      const res = await apiRequest("/api/settings/webhook/test", { method: "POST" });
      const payload = (await res.json()) as { ok: boolean };
      setTestState(payload.ok ? "sent" : "failed");
    } catch {
      setTestState("failed");
    } finally {
      window.setTimeout(() => setTestState("idle"), 2500);
    }
  };

  return { config, draftUrl, setDraftUrl, saving, error, save, testState, sendTest };
}

/** The desktop host's throughput-readout bridge, exposed only in the macOS and
 *  Windows desktop apps (the preload gates it on those platforms). Null everywhere
 *  else — a browser tab, the extension, Linux — which is what keeps the row from
 *  rendering there. A dev run shows it too: the toggle and the window-open readout
 *  work, and only the window-closed feed is dark, since the recorder that drives it
 *  runs solely in the packaged app. */
function menuBarHost() {
  const host = window.dishlink;
  return typeof host?.setMenuBarThroughput === "function" ? host : null;
}

/** Follows the menu-bar preference the main process owns: seeded once, then kept
 *  in step with the tray checkbox through the host's change feed. */
function useMenuBarThroughput(): [boolean, (on: boolean) => void] | null {
  const host = menuBarHost();
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!host) return;
    let active = true;
    void host.menuBarThroughput?.().then((value) => {
      if (active) setOn(value);
    });
    const unsubscribe = host.onMenuBarThroughput?.((value) => setOn(value));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [host]);

  if (!host) return null;
  // Optimistic locally, then reconciled with what main reports back, so the switch
  // never lags the click by a round trip.
  const toggle = (next: boolean) => {
    setOn(next);
    void host.setMenuBarThroughput?.(next).then(setOn);
  };
  return [on, toggle];
}

export function AppSettingsTab() {
  const toolbarStyle = useSyncExternalStore(subscribeToToolbarStyle, readToolbarStyle);
  const menuBar = useMenuBarThroughput();
  const webhook = useWebhookSettings();
  // The readout lives in the menu bar on macOS and the taskbar on Windows; name
  // whichever this host is. Only reached when the bridge is present, i.e. desktop.
  const surface = window.dishlink?.platform === "win32" ? "taskbar" : "menu bar";

  return (
    <>
      <SettingRow title='App toolbar' caption='Floating dock or a left rail for the section links'>
        <Select
          value={toolbarStyle}
          onValueChange={(value) => setToolbarStyle(value as ToolbarStyle)}
        >
          <SelectTrigger className={triggerClass} style={{ width: 118 }}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={selectContentClass}>
            <SelectItem value='dock' className={selectItemClass}>
              Dock
            </SelectItem>
            <SelectItem value='rail' className={selectItemClass}>
              Left rail
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      {menuBar && (
        <SettingRow
          title={`Throughput in ${surface}`}
          caption={`Show the live ↓/↑ rate in the ${surface}`}
        >
          <Switch checked={menuBar[0]} onCheckedChange={menuBar[1]} />
        </SettingRow>
      )}

      <SectionLabel>Webhook notifications</SectionLabel>
      <SettingRow
        title='Enabled'
        caption='Fires from the backend itself on every alert transition -- works even with no browser tab open'
      >
        <Switch
          checked={Boolean(webhook.config?.enabled)}
          disabled={webhook.saving || !webhook.draftUrl}
          onCheckedChange={(enabled) => void webhook.save({ enabled })}
        />
      </SettingRow>
      <div className='flex items-center gap-2 pb-[8px]'>
        <input
          type='text'
          placeholder='https://hooks.slack.com/... or a Discord/generic JSON webhook URL'
          className='h-7 flex-1 rounded-sm border border-hairline bg-transparent px-2 text-[12px] text-ink hover:border-input'
          value={webhook.draftUrl}
          disabled={webhook.saving}
          onChange={(event) => webhook.setDraftUrl(event.target.value)}
          onBlur={() => {
            if (webhook.draftUrl !== webhook.config?.url) void webhook.save({ url: webhook.draftUrl });
          }}
        />
        <button
          className={actionButton("subtle")}
          disabled={webhook.testState === "sending" || !webhook.config?.url}
          onClick={() => void webhook.sendTest()}
        >
          {webhook.testState === "sending"
            ? "Sending…"
            : webhook.testState === "sent"
              ? "Sent ✓"
              : webhook.testState === "failed"
                ? "Failed"
                : "Send test"}
        </button>
      </div>
      {webhook.error && <div className='pb-[8px] text-[12px] text-destructive'>{webhook.error}</div>}
    </>
  );
}
