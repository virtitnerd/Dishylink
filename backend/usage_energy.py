"""
Range-bucketed data-usage and energy summaries for the Data Usage and Power
panels, built directly from the same per-poll samples already recorded for
/api/samples and /api/history/long -- no separate long-term store needed,
since this historian keeps every poll (unlike dishylink's own recorder, which
kept a short raw window plus a coarser per-minute rollup; here the raw poll
*is* the long-term record).

Each poll's downlink_bps/uplink_bps/power_w is a reading that's assumed to
hold from that poll until the next one (capped at MAX_GAP_S, so a stretch the
historian was down or the dish was unreachable is honestly excluded from
"sampled" rather than silently extrapolated across) -- that's what turns a
series of instantaneous rate readings into a real integral (GB, kWh) instead
of an average.
"""
from __future__ import annotations

import time
from datetime import datetime
from typing import Any, Callable

# (bucket count, bucket width seconds) for every range except "today" and
# "month", which are calendar-aligned instead of fixed-width -- see their own
# branches in bucket_bounds.
_RANGE_SPECS: dict[str, tuple[int, float]] = {
    "1h": (12, 5 * 60),
    "6h": (24, 15 * 60),
    "12h": (24, 30 * 60),
    "day": (48, 3600),
    "week": (7, 86400),
}
RANGES = set(_RANGE_SPECS) | {"today", "month"}

# A single reading is trusted to extrapolate forward at most this long before
# the gap counts as unmeasured -- a few missed 10s polls is a slow response,
# a minute-plus is the historian (or the dish) actually being down.
MAX_GAP_S = 60.0


def _month_starts(now_s: float, count: int = 12) -> list[float]:
    """Local midnight on the 1st of each of the trailing `count` calendar
    months, oldest first, ending with the current (still-open) month."""
    now = datetime.fromtimestamp(now_s)
    year, month = now.year, now.month
    starts = []
    for _ in range(count):
        starts.append(datetime(year, month, 1).timestamp())
        month -= 1
        if month == 0:
            month = 12
            year -= 1
    starts.reverse()
    return starts


def bucket_bounds(range_: str, now_s: float) -> list[tuple[float, float]]:
    """[(start, end), ...] per bucket, oldest first, in epoch seconds."""
    if range_ == "month":
        starts = _month_starts(now_s)
        return [
            (start, starts[i + 1] if i + 1 < len(starts) else now_s)
            for i, start in enumerate(starts)
        ]
    if range_ == "today":
        midnight = datetime.fromtimestamp(now_s).replace(
            hour=0, minute=0, second=0, microsecond=0
        ).timestamp()
        bounds = []
        t = midnight
        while t < now_s:
            bounds.append((t, min(t + 3600, now_s)))
            t += 3600
        return bounds or [(midnight, now_s)]
    count, width = _RANGE_SPECS[range_]
    return [(now_s - (count - i) * width, now_s - (count - 1 - i) * width) for i in range(count)]


def _integrate(
    samples: list[dict[str, Any]],
    value_fn: Callable[[dict[str, Any]], float | None],
    start_s: float,
    end_s: float,
    max_gap_s: float = MAX_GAP_S,
) -> tuple[float, float]:
    """(value-seconds, sampled-seconds) for samples whose timestamp falls in
    [start_s, end_s) -- each sample's reading is held forward to the next
    sample (or the bucket's end), capped at max_gap_s."""
    ordered = sorted((s for s in samples if start_s <= s["ts"] < end_s), key=lambda s: s["ts"])
    total = 0.0
    sampled = 0.0
    for i, sample in enumerate(ordered):
        next_ts = ordered[i + 1]["ts"] if i + 1 < len(ordered) else end_s
        dt = min(max(0.0, min(next_ts, end_s) - sample["ts"]), max_gap_s)
        value = value_fn(sample)
        if value is not None:
            total += value * dt
        sampled += dt
    return total, sampled


def usage_summary(range_: str, samples: list[dict[str, Any]], now_s: float | None = None) -> dict[str, Any]:
    now_s = time.time() if now_s is None else now_s
    bounds = bucket_bounds(range_, now_s)
    buckets = []
    total_down_bits = total_up_bits = 0.0
    total_sampled = total_expected = 0.0
    for start, end in bounds:
        down_bits, sampled = _integrate(samples, lambda s: s.get("downlink_bps") or 0, start, end)
        up_bits, _ = _integrate(samples, lambda s: s.get("uplink_bps") or 0, start, end)
        expected = max(0.0, min(end, now_s) - start)
        buckets.append({
            "t": int(start),
            "downGB": (down_bits / 8 / 1e9) if sampled > 0 else None,
            "upGB": (up_bits / 8 / 1e9) if sampled > 0 else None,
            "sampledSeconds": sampled,
        })
        total_down_bits += down_bits
        total_up_bits += up_bits
        total_sampled += sampled
        total_expected += expected
    return {
        "range": range_,
        "totalDownGB": total_down_bits / 8 / 1e9,
        "totalUpGB": total_up_bits / 8 / 1e9,
        "coverage": {
            "sampledSeconds": total_sampled,
            "expectedSeconds": total_expected,
            "fraction": (total_sampled / total_expected) if total_expected > 0 else 0.0,
        },
        "buckets": buckets,
    }


def energy_summary(range_: str, samples: list[dict[str, Any]], now_s: float | None = None) -> dict[str, Any]:
    now_s = time.time() if now_s is None else now_s
    bounds = bucket_bounds(range_, now_s)
    buckets = []
    total_watt_seconds = 0.0
    total_sampled = total_expected = 0.0
    for start, end in bounds:
        watt_seconds, sampled = _integrate(samples, lambda s: s.get("power_w"), start, end)
        expected = max(0.0, min(end, now_s) - start)
        buckets.append({
            "t": int(start),
            "kWh": (watt_seconds / 3600 / 1000) if sampled > 0 else None,
            "sampledSeconds": sampled,
            "expectedSeconds": expected,
        })
        total_watt_seconds += watt_seconds
        total_sampled += sampled
        total_expected += expected
    return {
        "range": range_,
        "totalKWh": total_watt_seconds / 3600 / 1000,
        "coverage": {
            "sampledSeconds": total_sampled,
            "expectedSeconds": total_expected,
            "fraction": (total_sampled / total_expected) if total_expected > 0 else 0.0,
        },
        "buckets": buckets,
    }
