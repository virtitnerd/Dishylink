# Dishylink

Live dashboard plus an always-on recorder (the "historian") for a Starlink kit. The dev machine
is on the Starlink network itself — changes are verified against real hardware.

## Hardware safety — read before touching anything router-facing

- **NEVER call or poll the router's `get_ping` (field 1009), at any cadence.** Trialled three
  times on 2026-07-20 (2s, 5s, and 30s); each trial was followed within ~15 minutes by a router
  watchdog reboot that took the network down. Router ping success comes from `get_status`'s
  `popPingDropRate5m` (lowercase trailing `m`), which rides a reply we already fetch.
- `wifi_get_ping_metrics` (3007) and `set_config` answer PERMISSION_DENIED to anonymous LAN
  clients on current firmware. The official app gets its cloud data through an authenticated
  `api.starlink.com` session, not the LAN.
- The router is a small embedded box and has rebooted under ordinary load: **never add a new
  poll against it without the user's explicit approval.** Reuse replies already being fetched —
  `routerStatusFeed` in the browser, the 5s status poll in the recorder.
- **Every `WifiConfig` write's `basicServiceSets[]` entries need exactly one of `bssid` or an
  auth field (`authWpa2`/`authWpa3`/`authWpa2Wpa3`/`authOpen`), never both, never neither.**
  Confirmed 2026-08-15: sending both gets an "Incorrect bss specification, must have a bssid
  XOR password" error; sending bssid alone (auth stripped) gets two errors together, "Bssid must
  not be specified" and "Bss has unknown auth type: nil". The correct rule is to never send
  bssid at all (it's read-only/router-assigned) and always keep some auth field, including the
  masked `"•••••"` password on a band left untouched. Getting this wrong doesn't error at the
  transport level — Starlink's cloud gateway returns 200 OK with the rejection buried in the
  response body's `status` field, so a write can silently no-op unless that field is checked.
  See `backend/starlink_cloud.py`'s `ApplicationRejectedError` /
  `core/routerWifiConfigUpdate.ts`'s `stripBssid`/`stripForNewAuth`, and `LOCAL-API.md`'s
  "Authenticated cloud router writes" section.

## Working with this user

- **Findings before code.** Report what you found and the plan, then wait for approval before
  editing. When the user says "leave this for now", stop editing entirely until redirected.
- **If the user's message contains a question, answer it fully before any further tool calls.**
  Deferring the answer while continuing to edit counts as ignoring them.
- Never `git add -A` or `git stash`; commit only the files you yourself changed.

## Process facts

- There are **two independent historians**, not one shared service. `collector/historian.mts` is
  the TS one, run by launchd as `com.dishylink.historian` for the desktop app and extension;
  edits under `collector/` need `launchctl kickstart -k gui/$UID/com.dishylink.historian` to take
  effect, and its recordings live in `collector/data`. `backend/historian.py` is the Python one,
  part of the standalone server (`backend/server.py`); it has no separate service manager — it's
  an `asyncio` task inside the server process, so restarting the server (`backend/stop.sh` then
  `backend/start.sh`) is what picks up a change, and its recordings live in `backend/history`.
  `tsc`/`vitest` pass regardless of either being running.
- "Historian" is the component's name in code, service, and docs. User-facing copy stays plain
  English — "history recorder" or "recording" — because UI readers aren't assumed to know the
  industrial term.
- **`backend/server.py` does not hot-reload.** Restart it (`cd backend && ./stop.sh && ./start.sh`)
  after editing any `.py` file there before checking whether a fix landed — `server.log` and
  `server.pid` track the background process `start.sh` launches. The web dev harness's `npm run
dev` proxies `/api/*` to this server (`vite.config.ts`), so a stale server silently serves stale
  data to the browser too, not just to the standalone deployment.
- The user's pasted starlink.com session lives in `.starlink-cookie` at the repo root when written
  by `dev/starlinkCloudProxy.ts` (web dev harness), or under `backend/cache/starlink-cookie` when
  written by `backend/starlink_cloud.py` (standalone server) — two separate files, not shared. Both
  are live credentials: never print them, never commit them.
