"""
Local web dashboard for a Starlink dish's diagnostics API.

Run: python server.py
Then open http://127.0.0.1:8787
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import client_totals
import obstruction_snapshots
import starlink_cloud
import usage_energy
from historian import Historian, JsonlSink, downsample
from starlink_client import StarlinkError, get_client
import webhook


def safe(fn):
    try:
        return {"ok": True, "data": fn()}
    except StarlinkError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 -- API boundary: never let a route 500, always return JSON
        return {"ok": False, "error": f"unexpected error: {exc}"}


def collect_sample() -> dict:
    """One flat, timestamped row of the metrics worth keeping long-term. Shared by
    the historian's poll loop and /metrics, so the two can't drift apart on field names.

    Also carries a snapshot of the live alert flags (dish + router) and the
    dish's own short-lived event log -- not for /metrics (which only reads the
    numeric fields above), but so /api/alerts, /api/thermal and /api/outages
    can derive durable history by scanning transitions across stored samples,
    reaching back further than the dish's own rolling buffers do."""
    client = get_client()
    status = client.get_status()
    obstruction = status.get("obstructionStats", {}) or {}
    gps = status.get("gpsStats", {}) or {}
    row = {
        "ts": time.time(),
        "downlink_bps": status.get("downlinkThroughputBps"),
        "uplink_bps": status.get("uplinkThroughputBps"),
        "latency_ms": status.get("popPingLatencyMs"),
        "obstruction_fraction": obstruction.get("fractionObstructed"),
        "uptime_s": float(status["deviceState"]["uptimeS"]) if status.get("deviceState", {}).get("uptimeS") else None,
        "gps_sats": gps.get("gpsSats"),
        "alerts": status.get("alerts") or {},
    }
    try:
        h = client.get_history()
        power = h.get("powerIn") or []
        row["power_w"] = power[-1] if power else None
        drop = h.get("popPingDropRate") or []
        row["ping_drop_rate"] = drop[-1] if drop else None
        row["events"] = h.get("eventLog", {}).get("events") or []
    except StarlinkError:
        row["power_w"] = None
        row["ping_drop_rate"] = None
        row["events"] = []
    try:
        row["router_alerts"] = client.get_router_status().get("alerts") or {}
    except StarlinkError:
        row["router_alerts"] = {}
    try:
        clients = client.get_wifi_clients().get("clients") or []
        row["clients"] = [
            {
                "clientId": c.get("clientId"),
                "mac": c.get("macAddress") or "",
                "name": c.get("givenName") or c.get("name"),
                "rx": int((c.get("rxStats") or {}).get("bytes") or 0),
                "tx": int((c.get("txStats") or {}).get("bytes") or 0),
            }
            for c in clients
        ]
    except StarlinkError:
        row["clients"] = []
    return row


client_totals_store = client_totals.ClientTotals()
client_totals_store.load()


def collect_sample_and_notify() -> dict:
    """The historian's own collect_fn -- collect_sample() plus side effects
    that must only run once per real poll: the webhook check, folding this
    poll's client byte counters into the usage odometer, and (throttled to
    roughly hourly inside the module itself) an obstruction-map snapshot.
    Kept separate from collect_sample() itself, which /metrics also calls
    directly -- an external Prometheus scraper polling independently of the
    historian must not also drive (and fight over) this state."""
    row = collect_sample()
    webhook.check_transitions(row)
    for c in row.get("clients") or []:
        client_totals_store.observe(c.get("clientId"), c.get("mac") or "", c.get("rx", 0), c.get("tx", 0), row["ts"], c.get("name"))
    if row.get("clients"):
        client_totals_store.compact(row["ts"])
        client_totals_store.save()
    try:
        obstruction_snapshots.maybe_capture(get_client().get_obstruction_map, row["ts"])
    except StarlinkError:
        pass
    return row


sink = JsonlSink()
historian = Historian(collect_sample_and_notify, [sink])


@asynccontextmanager
async def lifespan(_app: FastAPI):
    historian.start()
    yield
    await historian.stop()


app = FastAPI(title="Starlink Dashboard", lifespan=lifespan)


@app.get("/api/status")
def api_status():
    client = get_client()
    return JSONResponse(safe(client.get_status))


@app.get("/api/diagnostics")
def api_diagnostics():
    client = get_client()
    return JSONResponse(safe(client.get_diagnostics))


@app.get("/api/device-info")
def api_device_info():
    client = get_client()
    return JSONResponse(safe(client.get_device_info))


@app.get("/api/history")
def api_history():
    client = get_client()
    return JSONResponse(safe(client.get_history))


HISTORY_RANGES = {"day": 86400, "week": 7 * 86400, "month": 30 * 86400}
HISTORY_FIELDS = ["downlink_bps", "uplink_bps", "latency_ms", "obstruction_fraction", "power_w", "ping_drop_rate", "gps_sats"]


@app.get("/api/history/long")
def api_history_long(range: str = "day", max_points: int = 300):
    """Beyond the dish's own ~12h ring buffer -- reads back what our own historian
    has recorded locally. Empty/thin results are expected until it's had time to run."""
    if range not in HISTORY_RANGES:
        return JSONResponse({"ok": False, "error": f"range must be one of {list(HISTORY_RANGES)}"})
    now = time.time()
    samples = sink.read_range(now - HISTORY_RANGES[range], now)
    samples.sort(key=lambda s: s["ts"])
    return JSONResponse({"ok": True, "data": downsample(samples, HISTORY_FIELDS, max_points)})


def _range_start_s(range_: str, now_s: float) -> float:
    bounds = usage_energy.bucket_bounds(range_, now_s)
    return bounds[0][0] if bounds else now_s


@app.get("/api/usage")
def api_usage(range: str = "today"):
    """Dishylink-shaped (see /api/samples's own note): UsageSummary at the top
    level, no {ok, data} envelope -- a bad range answers with a non-2xx status
    instead, which useDataUsage.ts already treats as "unavailable"."""
    if range not in usage_energy.RANGES:
        return JSONResponse({"error": f"range must be one of {sorted(usage_energy.RANGES)}"}, status_code=400)
    now = time.time()
    samples = sink.read_range(_range_start_s(range, now), now)
    return usage_energy.usage_summary(range, samples, now)


@app.get("/api/energy")
def api_energy(range: str = "today"):
    """Same shape/status-code convention as /api/usage above, for EnergySummary."""
    if range not in usage_energy.RANGES:
        return JSONResponse({"error": f"range must be one of {sorted(usage_energy.RANGES)}"}, status_code=400)
    now = time.time()
    samples = sink.read_range(_range_start_s(range, now), now)
    return usage_energy.energy_summary(range, samples, now)


def _derive_alert_episodes(samples: list[dict]) -> list[dict]:
    """Scan stored samples' alert-flag snapshots for transitions, returning
    {source, key, startMs, endMs} episodes (endMs=None if still open). Proto3
    JSON drops false booleans entirely, so a flag's *absence* from a sample is
    what means false -- a key only enters `known` once first seen true."""
    open_episodes: dict[tuple[str, str], float] = {}
    known: dict[str, set[str]] = {"dish": set(), "router": set()}
    episodes: list[dict] = []
    for sample in samples:
        ts_ms = sample["ts"] * 1000
        for source, field in (("dish", "alerts"), ("router", "router_alerts")):
            flags = sample.get(field) or {}
            known[source].update(flags.keys())
            active_now = {k for k, v in flags.items() if v}
            for key in known[source]:
                ident = (source, key)
                if key in active_now and ident not in open_episodes:
                    open_episodes[ident] = ts_ms
                elif key not in active_now and ident in open_episodes:
                    episodes.append({"source": source, "key": key, "startMs": open_episodes.pop(ident), "endMs": ts_ms})
    for (source, key), start_ms in open_episodes.items():
        episodes.append({"source": source, "key": key, "startMs": start_ms, "endMs": None})
    episodes.sort(key=lambda e: e["startMs"], reverse=True)
    return episodes


def _derive_outage_events(samples: list[dict]) -> list[dict]:
    """Dedup the dish's own short-lived eventLog as it's re-seen across many
    polls into a stable long-term list, keyed by (start time, reason) -- the
    dish restates an in-progress event with a growing duration as it runs on,
    so the longest-duration sighting of each key wins."""
    best: dict[tuple[str, str], dict] = {}
    for sample in samples:
        for ev in sample.get("events") or []:
            start_ns, reason = ev.get("startTimestampNs"), ev.get("reason")
            if not start_ns or not reason:
                continue
            key = (start_ns, reason)
            existing = best.get(key)
            if existing is None or int(ev.get("durationNs") or 0) > int(existing.get("durationNs") or 0):
                best[key] = ev
    out = []
    for ev in best.values():
        severity = (ev.get("severity") or "").replace("EVENT_SEVERITY_", "").lower()
        out.append({
            "startMs": int(ev["startTimestampNs"]) // 1_000_000,
            "durationMs": int(ev.get("durationNs") or 0) // 1_000_000,
            "cause": (ev.get("reason") or "").replace("EVENT_REASON_", ""),
            "severity": severity if severity in ("advisory", "warning", "critical") else "warning",
        })
    out.sort(key=lambda e: e["startMs"], reverse=True)
    return out


THERMAL_ALERT_KEYS = {"thermalShutdown", "thermalThrottle", "powerSupplyThermalThrottle"}


# -- dishylink-shaped historian routes ----------------------------------------
# Unlike every /api/* route above, these three return their payload directly
# at the top level (no {ok, data} envelope) -- they're read by dishylink's own
# hooks (useDishTelemetry/useDeviceAlerts/useOutageHistory/useThermalEvents)
# through apiRequest(), a plain fetch that expects dishylink's own historian's
# response shape verbatim, not this app's convention.

@app.get("/api/samples")
def api_samples(minutes: int = 360):
    now = time.time()
    samples = sink.read_range(now - minutes * 60, now)
    samples.sort(key=lambda s: s["ts"])
    out = [{
        "timestampMs": int(s["ts"] * 1000),
        "latencyMs": s.get("latency_ms"),
        "dropRate": s.get("ping_drop_rate") if s.get("ping_drop_rate") is not None else 0,
        "downlinkBps": s.get("downlink_bps") or 0,
        "uplinkBps": s.get("uplink_bps") or 0,
        "powerW": s.get("power_w") or 0,
        "routerLatencyMs": None,
        "routerPingSuccessPercent": None,
    } for s in samples]
    return {"samples": out}


@app.get("/api/alerts")
def api_alerts():
    now = time.time()
    samples = sink.read_range(now - 30 * 86400, now)
    samples.sort(key=lambda s: s["ts"])
    return {"episodes": _derive_alert_episodes(samples)}


@app.get("/api/thermal")
def api_thermal():
    now = time.time()
    samples = sink.read_range(now - 30 * 86400, now)
    samples.sort(key=lambda s: s["ts"])
    episodes = [e for e in _derive_alert_episodes(samples) if e["source"] == "dish" and e["key"] in THERMAL_ALERT_KEYS]
    return {"episodes": episodes}


@app.get("/api/outages")
def api_outages():
    now = time.time()
    samples = sink.read_range(now - 30 * 86400, now)
    return {"events": _derive_outage_events(samples)}


@app.get("/metrics")
def api_metrics():
    """Prometheus exposition format -- point a Prometheus scrape config at this and
    Grafana (or anything else) can build on top of it without this app needing to
    know Prometheus/Grafana exist. This is the intended path for external dashboards;
    /api/history/long is for this app's own charts."""
    row = safe(collect_sample)
    if not row["ok"]:
        return Response(f"# starlink_scrape_error 1\n# {row['error']}\n", media_type="text/plain")
    data = row["data"]
    metric_names = {
        "downlink_bps": "starlink_downlink_bps",
        "uplink_bps": "starlink_uplink_bps",
        "latency_ms": "starlink_latency_ms",
        "obstruction_fraction": "starlink_obstruction_fraction",
        "uptime_s": "starlink_uptime_seconds",
        "gps_sats": "starlink_gps_satellites",
        "power_w": "starlink_power_watts",
        "ping_drop_rate": "starlink_ping_drop_rate",
    }
    lines = ["# starlink dashboard -- see /api/status for full detail"]
    for field, metric in metric_names.items():
        value = data.get(field)
        if value is not None:
            lines.append(f"{metric} {value}")
    return Response("\n".join(lines) + "\n", media_type="text/plain")


@app.get("/api/historian/status")
def api_historian_status():
    """Whether the background poll loop is actually running and recording."""
    return JSONResponse({
        "ok": historian.last_error is None,
        "lastSampleTs": historian.last_sample["ts"] if historian.last_sample else None,
        "lastError": historian.last_error,
        "intervalS": historian._interval_s,
    })


@app.get("/api/context")
def api_context():
    client = get_client()
    return JSONResponse(safe(client.get_context))


@app.get("/api/obstruction-map")
def api_obstruction_map():
    client = get_client()
    return JSONResponse(safe(client.get_obstruction_map))


@app.get("/api/obstruction/snapshots")
def api_obstruction_snapshots():
    """Dishylink-shaped: {snapshots} at the top level, no {ok, data} envelope.
    Frames are captured roughly hourly by the historian's own poll loop --
    see obstruction_snapshots.maybe_capture, called from
    collect_sample_and_notify below."""
    return {"snapshots": obstruction_snapshots.read_snapshots()}


@app.get("/api/dish-config")
def api_dish_config():
    """Present for API-coverage completeness -- overlaps with /api/status's `config` field, not used by the UI."""
    client = get_client()
    return JSONResponse(safe(client.get_dish_config))


@app.get("/api/location")
def api_location():
    """Dish GPS position -- typically PERMISSION_DENIED on consumer plans since mid-2026 firmware."""
    client = get_client()
    return JSONResponse(safe(client.get_location))


@app.post("/api/stow")
def api_stow(unstow: bool = False):
    """Stow/unstow the dish -- motorized (mast) models only; a no-op on electronically-steered kits."""
    client = get_client()
    return JSONResponse(safe(lambda: client.stow(unstow)))


@app.get("/api/debug-export")
def api_debug_export():
    """Everything readable in one JSON blob -- for attaching to a support request, mirroring
    dishylink's "copy debug data" feature. Each section is fetched independently so one
    unreachable target (e.g. the router, if you're on a third-party one) doesn't blank the rest."""
    client = get_client()
    sections = {
        "dishStatus": client.get_status,
        "dishDiagnostics": client.get_diagnostics,
        "dishConfig": client.get_dish_config,
        "routerStatus": client.get_router_status,
        "routerDiagnostics": client.get_router_diagnostics,
        "routerConfig": client.get_wifi_config,
    }
    return JSONResponse({name: safe(fn) for name, fn in sections.items()})


@app.post("/api/reboot")
def api_reboot():
    """Reboots the dish -- causes a brief (~1 min) outage. Confirmed client-side before this fires."""
    client = get_client()
    return JSONResponse(safe(client.reboot))


@app.post("/api/obstruction-map/clear")
def api_obstruction_map_clear():
    """Wipes the dish's learned obstruction map. Confirmed client-side before this fires."""
    client = get_client()
    return JSONResponse(safe(client.clear_obstruction_map))


@app.post("/api/speedtest/start")
def api_speedtest_start():
    client = get_client()
    return JSONResponse(safe(client.start_speedtest))


@app.get("/api/speedtest/status")
def api_speedtest_status():
    client = get_client()
    return JSONResponse(safe(client.get_speedtest_status))


# -- dish settings (writes) --------------------------------------------------

class SnowMeltPayload(BaseModel):
    mode: str  # AUTO | ALWAYS_ON | ALWAYS_OFF


@app.post("/api/settings/snow-melt")
def api_set_snow_melt(payload: SnowMeltPayload):
    client = get_client()
    return JSONResponse(safe(lambda: client.set_snow_melt_mode(payload.mode)))


class SleepSchedulePayload(BaseModel):
    enabled: bool
    start_minutes: int | None = None
    duration_minutes: int | None = None


@app.post("/api/settings/sleep-schedule")
def api_set_sleep_schedule(payload: SleepSchedulePayload):
    client = get_client()
    return JSONResponse(safe(lambda: client.set_sleep_schedule(payload.enabled, payload.start_minutes, payload.duration_minutes)))


class SoftwareUpdateWindowPayload(BaseModel):
    reboot_hour: int | None = None
    defer_three_days: bool | None = None


@app.post("/api/settings/software-update-window")
def api_set_software_update_window(payload: SoftwareUpdateWindowPayload):
    client = get_client()
    return JSONResponse(safe(lambda: client.set_software_update_window(payload.reboot_hour, payload.defer_three_days)))


class LocationRequestModePayload(BaseModel):
    mode: str  # NONE | LOCAL


@app.post("/api/settings/location-request-mode")
def api_set_location_request_mode(payload: LocationRequestModePayload):
    client = get_client()
    return JSONResponse(safe(lambda: client.set_location_request_mode(payload.mode)))


class DishConfigPayload(BaseModel):
    changes: dict[str, Any]  # camelCase DishConfig field names -> values, e.g. {"snowMeltMode": "AUTO"}


@app.post("/api/settings/dish-config")
def api_set_dish_config(payload: DishConfigPayload):
    """Generic partial DishConfig write -- any subset of fields in one call, each
    paired automatically with its apply_<field> flag. Mirrors dishylink's own
    flexible setConfig() rather than the fixed per-setting endpoints above."""
    client = get_client()
    return JSONResponse(safe(lambda: client.set_dish_config(payload.changes)))


# -- router (192.168.1.1:9001) -- reads --------------------------------------

@app.get("/api/router/clients")
def api_router_clients():
    client = get_client()
    return JSONResponse(safe(client.get_wifi_clients))


# Extra lookback fetched (and discarded from the response) purely to seed the
# first sample's delta -- without a prior reading its rate would read 0.
_CLIENTS_LOOKBACK_PAD_S = 60.0


def _client_samples(samples: list[dict], max_gap_s: float = 45.0) -> list[dict]:
    """One row per (device, poll) with downMbps/upMbps computed from the
    byte-counter delta against that device's previous poll -- same reset/gap
    handling as client_totals.py's odometer (a counter that dropped is a
    reset, not negative traffic; a gap too wide to measure across reads 0
    rather than a spike), just expressed as a rate instead of a running sum."""
    prev: dict[str, tuple[float, int, int]] = {}
    out = []
    for sample in samples:
        ts = sample["ts"]
        for c in sample.get("clients") or []:
            key = client_totals.key_of(c.get("clientId"), c.get("mac") or "")
            rx, tx = c.get("rx", 0), c.get("tx", 0)
            down_mbps = up_mbps = 0.0
            prior = prev.get(key)
            if prior:
                prev_ts, prev_rx, prev_tx = prior
                dt = ts - prev_ts
                if 0 < dt <= max_gap_s:
                    if rx >= prev_rx:
                        down_mbps = (rx - prev_rx) * 8 / dt / 1e6
                    if tx >= prev_tx:
                        up_mbps = (tx - prev_tx) * 8 / dt / 1e6
            prev[key] = (ts, rx, tx)
            out.append({
                "key": key,
                "macAddress": c.get("mac") or "",
                "atMs": int(ts * 1000),
                "downMbps": down_mbps,
                "upMbps": up_mbps,
            })
    return out


@app.get("/api/clients")
def api_clients(hours: float = 6, samples: int = 0, since: float = 0, totals: int = 0):
    """Dishylink-shaped (see /api/samples's own note): {history, samples,
    totals?} at the top level. `history` is always empty -- unlike dishylink's
    own recorder (a short raw window plus a coarser long-term rollup), this
    historian keeps every poll at full resolution indefinitely, so there's no
    separate coarse tier to serve; `samples` alone covers the whole range."""
    now = time.time()
    start_s = (since / 1000) if since else now - hours * 3600
    rows = sink.read_range(start_s - _CLIENTS_LOOKBACK_PAD_S, now)
    rows.sort(key=lambda s: s["ts"])
    rate_rows = _client_samples(rows)
    floor_ms = since if since else start_s * 1000
    rate_rows = [r for r in rate_rows if r["atMs"] > floor_ms]
    out: dict[str, Any] = {"history": [], "samples": rate_rows}
    if totals:
        out["totals"] = client_totals_store.totals()
    return out


@app.get("/api/clients/totals")
def api_clients_totals():
    return {"totals": client_totals_store.totals(), "mergeCandidates": client_totals_store.merge_candidates(time.time())}


@app.delete("/api/clients/totals")
def api_clients_totals_delete(client: str | None = None):
    if client is None:
        client_totals_store.clear()
        found = True
    else:
        found = client_totals_store.remove(client)
    client_totals_store.save()
    if not found:
        return JSONResponse({"ok": False, "error": "unknown device"}, status_code=404)
    return {"ok": True}


@app.post("/api/clients/totals/reset")
def api_clients_totals_reset(client: str):
    ok = client_totals_store.reset(client, time.time())
    client_totals_store.save()
    if not ok:
        return JSONResponse({"ok": False, "error": "unknown device"}, status_code=404)
    return {"ok": True}


@app.post("/api/clients/totals/merge")
def api_clients_totals_merge(from_key: str = Query(alias="from"), to_key: str = Query(alias="to"), distinct: str | None = None):
    ok = client_totals_store.reject_merge(from_key, to_key) if distinct else client_totals_store.merge(from_key, to_key)
    client_totals_store.save()
    if not ok:
        return JSONResponse({"ok": False, "error": "cannot merge"}, status_code=400)
    return {"ok": True}


@app.get("/api/router/status")
def api_router_status():
    client = get_client()
    return JSONResponse(safe(client.get_router_status))


@app.get("/api/router/diagnostics")
def api_router_diagnostics():
    client = get_client()
    return JSONResponse(safe(client.get_router_diagnostics))


@app.get("/api/router/config")
def api_router_config():
    client = get_client()
    return JSONResponse(safe(client.get_wifi_config))


@app.get("/api/router/guest-info")
def api_router_guest_info():
    client = get_client()
    return JSONResponse(safe(client.get_wifi_guest_info))


@app.get("/api/router/radio-stats")
def api_router_radio_stats():
    """Per-radio WiFi stats (temps, rates) -- the dish answers Unimplemented for this RPC."""
    client = get_client()
    return JSONResponse(safe(client.get_router_radio_stats))


@app.get("/api/radio")
def api_radio():
    """Dishylink-shaped radio temps (see /api/samples's note on this convention):
    {current: [{band, tempC, dutyCycle}], atMs} at the top level, no {ok, data}
    envelope -- read by useRadioTemps.ts through apiRequest(), a plain fetch.
    Only temp2 is populated on current router firmware; temp is always absent."""
    try:
        stats = get_client().get_router_radio_stats()
    except StarlinkError:
        return {"current": [], "atMs": None}
    current = [
        {
            "band": radio.get("band"),
            "tempC": (radio.get("thermalStatus") or {}).get("temp2"),
            "dutyCycle": (radio.get("thermalStatus") or {}).get("dutyCycle"),
        }
        for radio in stats.get("radioStats") or []
    ]
    return {"current": current, "atMs": int(time.time() * 1000)}


def _local_ips() -> set[str]:
    """This machine's own routable addresses -- used to tell a same-host
    viewer (open this dashboard's own tab) from a remote one (someone else on
    the LAN pointed a browser at this host)."""
    ips: set[str] = set()
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))  # never actually sent; just picks the outbound interface
        ips.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ips.add(info[4][0])
    except OSError:
        pass
    return ips


@app.get("/api/whoami")
def api_whoami(request: Request):
    """Dishylink-shaped: {ips, macs} at the top level -- read by
    selfIdentity.ts's web path to flag "This device" in the client list.
    Remote viewer -> just their own address, echoed back. Same-host viewer ->
    every address this machine answers on. MACs are never populated here (no
    portable interface-MAC read without a new dependency); IP alone is enough
    for matchesSelf() to still flag the row correctly."""
    caller_ip = (request.client.host if request.client else "").replace("::ffff:", "")
    local_ips = _local_ips()
    if caller_ip and caller_ip in local_ips | {"127.0.0.1", "::1"}:
        return {"ips": sorted(local_ips), "macs": []}
    return {"ips": [caller_ip] if caller_ip else [], "macs": []}


# -- router -- writes ---------------------------------------------------------

@app.post("/api/router/reboot")
def api_router_reboot():
    """Reboots the router (not the dish) -- confirmed client-side before this fires."""
    client = get_client()
    return JSONResponse(safe(client.reboot_router))


class ClientNamePayload(BaseModel):
    mac_address: str
    given_name: str


@app.post("/api/router/clients/name")
def api_set_client_name(payload: ClientNamePayload):
    client = get_client()
    return JSONResponse(safe(lambda: client.set_client_given_name(payload.mac_address, payload.given_name)))


class MeshTrustPayload(BaseModel):
    device_id: str
    trusted: bool


@app.post("/api/router/mesh-trust")
def api_set_mesh_trust(payload: MeshTrustPayload):
    client = get_client()
    return JSONResponse(safe(lambda: client.set_mesh_device_trust(payload.device_id, payload.trusted)))


class WifiSsidPayload(BaseModel):
    band: str  # RF_2GHZ | RF_5GHZ | RF_5GHZ_HIGH
    # ssid and password are both required on every call, not optional -- see the
    # docstring on StarlinkClient.set_wifi_ssid for why: the router masks passwords
    # on read, and this is a read-modify-write, so leaving password unset would
    # write back the literal masked placeholder as the new WiFi password.
    ssid: str
    password: str
    hidden: bool | None = None


@app.post("/api/router/wifi/ssid")
def api_set_wifi_ssid(payload: WifiSsidPayload):
    client = get_client()
    return JSONResponse(safe(lambda: client.set_wifi_ssid(payload.band, payload.ssid, payload.password, payload.hidden)))


class BypassModePayload(BaseModel):
    enabled: bool


@app.post("/api/router/wifi/bypass-mode")
def api_set_bypass_mode(payload: BypassModePayload):
    """Disables the router's own WiFi radios. Real risk of needing a physical reset if
    this leaves the network unreachable -- confirmed client-side before this fires."""
    client = get_client()
    return JSONResponse(safe(lambda: client.set_bypass_mode(payload.enabled)))


class CustomDnsPayload(BaseModel):
    nameservers: list[str] | None = None
    disabled: bool | None = None


@app.post("/api/router/wifi/dns")
def api_set_custom_dns(payload: CustomDnsPayload):
    client = get_client()
    return JSONResponse(safe(lambda: client.set_custom_dns(payload.nameservers, payload.disabled)))


class ContentFilteringPayload(BaseModel):
    band: str
    sandbox_enabled: bool
    allow_domains: list[str] | None = None


@app.post("/api/router/wifi/content-filtering")
def api_set_content_filtering(payload: ContentFilteringPayload):
    client = get_client()
    return JSONResponse(safe(lambda: client.set_content_filtering(payload.band, payload.sandbox_enabled, payload.allow_domains)))


# -- Starlink cloud (account session, reads, and every device write) --------
# See starlink_cloud.py's own module docstring: this is what makes the
# packaged/Docker image single-port -- the frontend already assumes /cloud/*
# is same-origin (lib/cloudHost.ts's sameOriginTransport).

class CloudSessionPayload(BaseModel):
    cookie: str


@app.post("/cloud/session")
def api_cloud_connect(payload: CloudSessionPayload):
    status, body = starlink_cloud.connect(payload.cookie)
    return JSONResponse(body, status_code=status)


@app.delete("/cloud/session")
def api_cloud_disconnect():
    status, body = starlink_cloud.disconnect()
    return JSONResponse(body, status_code=status)


@app.get("/cloud/account")
def api_cloud_account():
    status, body = starlink_cloud.handle("/cloud/account")
    return JSONResponse(body, status_code=status)


@app.get("/cloud/usage")
def api_cloud_usage():
    status, body = starlink_cloud.handle("/cloud/usage")
    return JSONResponse(body, status_code=status)


@app.get("/cloud/telemetry")
def api_cloud_telemetry():
    status, body = starlink_cloud.handle("/cloud/telemetry")
    return JSONResponse(body, status_code=status)


@app.post("/cloud/device")
def api_cloud_device(update: dict[str, Any]):
    status, body = starlink_cloud.update_client(update)
    return JSONResponse(body, status_code=status)


@app.post("/cloud/wifi-config")
def api_cloud_wifi_config(update: dict[str, Any]):
    status, body = starlink_cloud.update_wifi_config(update)
    return JSONResponse(body, status_code=status)


@app.post("/cloud/dish-config")
def api_cloud_dish_config(update: dict[str, Any]):
    status, body = starlink_cloud.update_dish_config(update)
    return JSONResponse(body, status_code=status)


class WebhookPayload(BaseModel):
    url: str
    title: str
    body: str


@app.post("/api/notify-webhook")
def api_notify_webhook(payload: WebhookPayload):
    """One-off relay to an arbitrary URL, server-side to avoid browser CORS issues.
    Doesn't touch the stored config below -- for automatic alert notifications, see
    /api/settings/webhook instead."""
    error = webhook.validate_url(payload.url)
    if error:
        return JSONResponse({"ok": False, "error": error})
    return JSONResponse(webhook.send(payload.url, payload.title, payload.body))


class WebhookConfigPayload(BaseModel):
    url: str
    enabled: bool


@app.get("/api/settings/webhook")
def api_get_webhook_config():
    """Current webhook config -- read by the settings UI to show what's saved."""
    return JSONResponse({"ok": True, "data": webhook.read_config()})


@app.post("/api/settings/webhook")
def api_set_webhook_config(payload: WebhookConfigPayload):
    """Saves the webhook URL and whether automatic alert notifications are on.
    Once enabled, the historian's own poll loop fires this on every alert
    transition (see webhook.py) -- no browser tab has to be open."""
    if payload.enabled and payload.url:
        error = webhook.validate_url(payload.url)
        if error:
            return JSONResponse({"ok": False, "error": error})
    return JSONResponse({"ok": True, "data": webhook.write_config(payload.url, payload.enabled)})


@app.post("/api/settings/webhook/test")
def api_test_webhook_config():
    """Sends a sample notification to the currently-saved webhook URL, so the
    settings UI can offer a "send test" button without needing the URL passed
    in again (it might be masked/already-saved-only in the UI)."""
    config = webhook.read_config()
    if not config.get("url"):
        return JSONResponse({"ok": False, "error": "no webhook URL saved yet"})
    return JSONResponse(
        webhook.send(config["url"], "Dishylink test", "This is a test notification from your Starlink dashboard.")
    )


@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket):
    """Pushes a status snapshot roughly once a second for the live tiles/charts."""
    await websocket.accept()
    client = get_client()
    loop = asyncio.get_event_loop()
    try:
        while True:
            start = time.monotonic()
            payload = await loop.run_in_executor(None, safe, client.get_status)
            await websocket.send_json(payload)
            elapsed = time.monotonic() - start
            await asyncio.sleep(max(0.0, 1.0 - elapsed))
    except WebSocketDisconnect:
        pass


# -- satellite view: Starlink TLEs from Celestrak, cached -----------------------
# Public, free, no API key -- the standard source for this. Fetched server-side
# (not by the browser) to dodge CORS and to cache/rate-limit: TLEs are good for
# propagation accuracy over many hours, so there's no reason to refetch per view.
#
# Cached to *disk*, not just memory: Celestrak is a small, free, community-run
# service that rate-limits (observed firsthand -- a handful of requests across a
# few dev-server restarts was enough to draw a temporary 403). An in-memory-only
# cache resets on every restart and would hit them again each time; a file
# survives restarts, so a normal restart doesn't cost a fresh request at all.

TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle"
TLE_CACHE_TTL_S = 4 * 3600
TLE_CACHE_PATH = Path(os.environ.get("STARLINK_CACHE_DIR", "cache")) / "starlink_tle.txt"


def _read_tle_cache() -> tuple[str | None, float]:
    try:
        return TLE_CACHE_PATH.read_text(encoding="utf-8"), TLE_CACHE_PATH.stat().st_mtime
    except FileNotFoundError:
        return None, 0.0


def _write_tle_cache(text: str) -> None:
    TLE_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    TLE_CACHE_PATH.write_text(text, encoding="utf-8")


@app.get("/api/satellites/tle")
def api_satellites_tle():
    now = time.time()
    text, fetched_at = _read_tle_cache()
    if text is None or now - fetched_at > TLE_CACHE_TTL_S:
        try:
            req = urllib.request.Request(TLE_URL, headers={"User-Agent": "starlink-dashboard/1.0 (local monitoring tool)"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                text = resp.read().decode("utf-8")
                _write_tle_cache(text)
                fetched_at = now
        except urllib.error.URLError as exc:
            if text is None:
                return JSONResponse({"ok": False, "error": f"couldn't reach Celestrak: {exc}"})
            # stale cache beats no data -- serve what's on disk rather than failing outright
    return JSONResponse({"ok": True, "data": text, "fetchedAt": fetched_at})


# "static" for the original vanilla-JS build (this file's own directory);
# "../dist" for the dishylink fork, where this file lives in backend/ next to
# the Vite build output. Auto-detected so one server.py works unmodified in
# both places -- the fork's copy is periodically synced from here.
_STATIC_DIR = "../dist" if Path("../dist").is_dir() else "static"
app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8787)
