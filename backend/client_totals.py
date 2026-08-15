"""
Per-device data-usage odometer, bucketed by billing month.

The router serves only rxStats.bytes/txStats.bytes per client, and those reset
to zero on every WiFi re-association -- a roaming or sleeping device restarts
them several times an hour, so they never reflect what it has actually used.
This reads the counters every historian poll and accumulates them, treating a
counter that went backwards as a reset (the new value *is* the traffic since
the reset) rather than negative traffic -- what a real traffic monitor
(nlbwmon, ntopng) does. The sum is authoritative bytes, not an integral of
sampled rates, and persisted to disk it survives reconnects and restarts.

Identity is the router's clientId, not the MAC: the router masks every client
MAC to its vendor OUI over the LAN, so same-brand devices can share a MAC
string and would merge into one total if keyed by it. clientId is stable
across reboots/power-off and reissued only by a factory reset.

Simplified port of dishylink's own core/clientTotals.ts (ClientTotalsCore),
written for this backend's own historian. Ported: byte-delta accumulation,
month rollover (a device is re-baselined the first time it's seen in a new
calendar month), same-name merge detection/merge/reject, reset, remove,
compaction. Deliberately NOT ported: captiveClientId-based re-anchoring and
shared-MAC OUI tracking, which let the TS version survive a factory reset
(clientId reissuance) without losing continuity. Without them, a reset device
simply starts a fresh bucket -- a reasonable simplification, since a factory
reset is rare and this is a single-user local tool, not worth the port's added
complexity.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

TOTALS_PATH = Path(os.environ.get("STARLINK_CACHE_DIR", "cache")) / "client_totals.json"

# Wider than the historian's default 10s poll interval so one merely-slow poll
# doesn't get treated as a gap; still narrow enough that a real restart (poll
# loop down for minutes) correctly re-baselines instead of measuring across it.
DEFAULT_MAX_GAP_S = 45.0
MERGE_IDLE_AFTER_S = 10 * 60.0


def key_of(client_id: int | None, mac_address: str) -> str:
    """The map key a device is stored and looked up under -- its clientId when
    known, else the MAC. Exported so server.py's per-poll rate computation
    (samples served from /api/clients) keys its own delta tracking exactly the
    same way this module does, and the two never disagree about identity."""
    return str(client_id) if client_id is not None else mac_address


def _month_of(at_s: float) -> int:
    d = datetime.fromtimestamp(at_s)
    return d.year * 12 + d.month


def _month_start_ms(at_s: float) -> int:
    d = datetime.fromtimestamp(at_s).replace(hour=0, minute=0, second=0, microsecond=0, day=1)
    return int(d.timestamp() * 1000)


def _previous_month_start_s(now_s: float) -> float:
    d = datetime.fromtimestamp(now_s).replace(hour=0, minute=0, second=0, microsecond=0, day=1)
    prev_month = d.month - 1 or 12
    prev_year = d.year - 1 if d.month == 1 else d.year
    return d.replace(year=prev_year, month=prev_month).timestamp()


def _pair_key(a: str, b: str) -> str:
    return f"{a}\x00{b}" if a < b else f"{b}\x00{a}"


@dataclass
class _State:
    client_id: int | None
    mac_address: str
    name: str | None
    rx_bytes: int
    tx_bytes: int
    since_ms: int
    last_seen_ms: int
    period_month: int
    prev_rx: int
    prev_tx: int
    last_poll_s: float  # 0 forces the next reading to re-baseline instead of delta


class ClientTotals:
    def __init__(self, max_gap_s: float = DEFAULT_MAX_GAP_S):
        self._max_gap_s = max_gap_s
        self._states: dict[str, _State] = {}
        self._aliases: dict[str, str] = {}
        self._rejected: dict[str, tuple[str, str]] = {}

    # -- persistence ----------------------------------------------------------

    def load(self, path: Path = TOTALS_PATH) -> None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return
        self._states = {}
        for s in data.get("totals", []):
            state = _State(
                client_id=s.get("clientId"),
                mac_address=s["macAddress"],
                name=s.get("name"),
                rx_bytes=s.get("rxBytes", 0),
                tx_bytes=s.get("txBytes", 0),
                since_ms=s.get("sinceMs", 0),
                last_seen_ms=s.get("lastSeenMs", 0),
                period_month=s.get("periodMonth", 0),
                prev_rx=s.get("prevRx", 0),
                prev_tx=s.get("prevTx", 0),
                last_poll_s=s.get("lastPollS", 0.0),
            )
            self._states[key_of(state.client_id, state.mac_address)] = state
        self._aliases = dict(data.get("aliases") or [])
        self._rejected = {_pair_key(a, b): (a, b) for a, b in data.get("rejectedPairs") or []}

    def save(self, path: Path = TOTALS_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "totals": [
                {
                    "clientId": s.client_id,
                    "macAddress": s.mac_address,
                    "name": s.name,
                    "rxBytes": s.rx_bytes,
                    "txBytes": s.tx_bytes,
                    "sinceMs": s.since_ms,
                    "lastSeenMs": s.last_seen_ms,
                    "periodMonth": s.period_month,
                    "prevRx": s.prev_rx,
                    "prevTx": s.prev_tx,
                    "lastPollS": s.last_poll_s,
                }
                for s in self._states.values()
            ],
            "aliases": list(self._aliases.items()),
            "rejectedPairs": list(self._rejected.values()),
        }
        # Not a tmp-file-plus-rename: a rename can fail with a transient
        # PermissionError in a synced folder (OneDrive, etc.) briefly holding
        # the destination open -- matches webhook.py's plain-write house style.
        path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

    # -- observe ----------------------------------------------------------------

    def observe(
        self,
        client_id: int | None,
        mac_address: str,
        rx_bytes: int,
        tx_bytes: int,
        at_s: float,
        name: str | None = None,
    ) -> None:
        """Fold one counter reading into the running total. The delta is
        counter-minus-previous normally; on a counter that went backwards (the
        router restarting it on re-association) the new value *is* the traffic
        since the reset, so it's added whole. A first sighting, a gap too wide
        to measure across, or the first reading of a new month only
        re-baselines and adds nothing."""
        key = key_of(client_id, mac_address)
        state = self._states.get(key)
        if state is None:
            state = _State(
                client_id=client_id,
                mac_address=mac_address,
                name=name,
                rx_bytes=0,
                tx_bytes=0,
                since_ms=_month_start_ms(at_s),
                last_seen_ms=int(at_s * 1000),
                period_month=_month_of(at_s),
                prev_rx=0,
                prev_tx=0,
                last_poll_s=0.0,
            )
            self._states[key] = state

        month = _month_of(at_s)
        if month != state.period_month:
            state.rx_bytes = 0
            state.tx_bytes = 0
            state.period_month = month
            state.since_ms = _month_start_ms(at_s)
        elif state.last_poll_s != 0 and at_s - state.last_poll_s <= self._max_gap_s:
            state.rx_bytes += (rx_bytes - state.prev_rx) if rx_bytes >= state.prev_rx else rx_bytes
            state.tx_bytes += (tx_bytes - state.prev_tx) if tx_bytes >= state.prev_tx else tx_bytes
        state.prev_rx = rx_bytes
        state.prev_tx = tx_bytes
        state.last_poll_s = at_s
        state.last_seen_ms = int(at_s * 1000)
        if name:
            state.name = name

    # -- mutations ----------------------------------------------------------------

    def reset(self, client_key: str, at_s: float) -> bool:
        """Zero one device's total but keep the bucket, so it stays listed and
        counts forward from now."""
        state = self._states.get(self.resolve_key(client_key))
        if not state:
            return False
        state.rx_bytes = 0
        state.tx_bytes = 0
        state.since_ms = int(at_s * 1000)
        return True

    def remove(self, client_key: str) -> bool:
        """Delete one device's record entirely -- not a counter reset."""
        return self._states.pop(self.resolve_key(client_key), None) is not None

    def clear(self) -> None:
        self._states.clear()
        self._aliases.clear()
        self._rejected.clear()

    def resolve_key(self, client_key: str) -> str:
        key = client_key
        for _ in range(32):
            nxt = self._aliases.get(key)
            if nxt is None or nxt == key:
                return key
            key = nxt
        return key

    def merge(self, from_key: str, to_key: str) -> bool:
        """Fold from_key's bucket into to_key's, as one device the router
        reissued an identity to. Bytes are added only when both buckets cover
        the same month -- an idle bucket left over from last month still holds
        last month's bytes, and adding those into the current month would
        invent traffic."""
        frm = self.resolve_key(from_key)
        to = self.resolve_key(to_key)
        if frm == to:
            return False
        source = self._states.get(frm)
        survivor = self._states.get(to)
        if not source or not survivor:
            return False
        for name, (a, b) in list(self._rejected.items()):
            if _pair_key(self.resolve_key(a), self.resolve_key(b)) == _pair_key(frm, to):
                del self._rejected[name]

        if source.period_month == survivor.period_month:
            survivor.rx_bytes += source.rx_bytes
            survivor.tx_bytes += source.tx_bytes
            survivor.since_ms = min(survivor.since_ms, source.since_ms)
        survivor.last_seen_ms = max(survivor.last_seen_ms, source.last_seen_ms)
        survivor.name = survivor.name or source.name
        survivor.last_poll_s = 0.0

        del self._states[frm]
        for alias, target in list(self._aliases.items()):
            if target == frm:
                self._aliases[alias] = to
        self._aliases[frm] = to
        return True

    def reject_merge(self, a_key: str, b_key: str) -> bool:
        """Record that two buckets are different devices, so the pair stops
        being offered as a merge candidate."""
        a, b = self.resolve_key(a_key), self.resolve_key(b_key)
        if a == b or a not in self._states or b not in self._states:
            return False
        self._rejected[_pair_key(a, b)] = (a, b)
        return True

    def _is_rejected(self, a_key: str, b_key: str) -> bool:
        wanted = _pair_key(self.resolve_key(a_key), self.resolve_key(b_key))
        for a, b in self._rejected.values():
            if _pair_key(self.resolve_key(a), self.resolve_key(b)) == wanted:
                return True
        return False

    def compact(self, now_s: float) -> int:
        """Drop devices unseen since before last month, so the list can't grow
        forever."""
        cutoff_ms = _previous_month_start_s(now_s) * 1000
        stale = [k for k, s in self._states.items() if s.last_seen_ms < cutoff_ms]
        for k in stale:
            del self._states[k]
        return len(stale)

    # -- reads ----------------------------------------------------------------

    def totals(self) -> list[dict[str, Any]]:
        rows = sorted(self._states.values(), key=lambda s: s.last_seen_ms, reverse=True)
        return [
            {
                "clientId": s.client_id,
                "macAddress": s.mac_address,
                "name": s.name,
                "rxBytes": s.rx_bytes,
                "txBytes": s.tx_bytes,
                "sinceMs": s.since_ms,
                "lastSeenMs": s.last_seen_ms,
            }
            for s in rows
        ]

    def merge_candidates(self, now_s: float, idle_after_s: float = MERGE_IDLE_AFTER_S) -> list[dict[str, Any]]:
        """Buckets that look like one device the router issued two identities
        to. The evidence is a name shared by an idle bucket and a newer one --
        the user's own label, not a guess: a device that comes back under a
        reissued clientId arrives unnamed."""
        named = [(k, s) for k, s in self._states.items() if (s.name or "").strip()]
        candidates: list[dict[str, Any]] = []
        now_ms = now_s * 1000
        for from_key, source in named:
            if now_ms - source.last_seen_ms <= idle_after_s * 1000:
                continue
            for to_key, target in named:
                if to_key == from_key or target.last_seen_ms <= source.last_seen_ms:
                    continue
                if (source.name or "").strip().lower() != (target.name or "").strip().lower():
                    continue
                if self._is_rejected(from_key, to_key):
                    continue
                folds_bytes = source.period_month == target.period_month
                candidates.append({
                    "fromKey": from_key,
                    "toKey": to_key,
                    "reason": "name",
                    "detail": (target.name or "").strip(),
                    "foldsBytes": folds_bytes,
                    "resultRxBytes": target.rx_bytes + (source.rx_bytes if folds_bytes else 0),
                    "resultTxBytes": target.tx_bytes + (source.tx_bytes if folds_bytes else 0),
                })
        return candidates
