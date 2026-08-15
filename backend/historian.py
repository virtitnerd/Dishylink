"""
Lightweight local history for the Starlink dashboard, so charts can cover more
than the dish's own ~12h ring buffer.

Design goals, in order:
  1. No new required infrastructure -- a background poll loop writes newline-
     delimited JSON (one file per day) under HISTORY_DIR. Reading back a range
     just means opening the relevant day files.
  2. Pluggable sinks -- Historian.write() fans a sample out to every configured
     sink. JsonlSink is the only one today; a future PrometheusPushSink or
     InfluxSink is a new class, not a rewrite of the poll loop.
  3. Environment-variable configuration (HISTORY_DIR, HISTORY_INTERVAL_S) so a
     Docker deployment just mounts a volume at HISTORY_DIR and moves on.

For actual Grafana/Prometheus use, see server.py's /metrics endpoint instead --
that's real Prometheus exposition format, scraped and retained by Prometheus
itself, which is the far more standard path than reinventing a time-series
store here. This module exists for the dashboard's own longer-range charts.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Protocol

HISTORY_DIR = Path(os.environ.get("STARLINK_HISTORY_DIR", "history"))
POLL_INTERVAL_S = float(os.environ.get("STARLINK_HISTORY_INTERVAL_S", "10"))


class HistorySink(Protocol):
    def write(self, sample: dict[str, Any]) -> None: ...


@dataclass
class JsonlSink:
    """One file per UTC day: history/2026-08-14.jsonl, one JSON object per line."""

    directory: Path = HISTORY_DIR

    def __post_init__(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)

    def _path_for(self, ts: float) -> Path:
        day = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
        return self.directory / f"{day}.jsonl"

    def write(self, sample: dict[str, Any]) -> None:
        line = json.dumps(sample, separators=(",", ":"))
        with open(self._path_for(sample["ts"]), "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def read_range(self, start_ts: float, end_ts: float) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        day = datetime.fromtimestamp(start_ts, tz=timezone.utc).date()
        end_day = datetime.fromtimestamp(end_ts, tz=timezone.utc).date()
        while day <= end_day:
            path = self.directory / f"{day.isoformat()}.jsonl"
            if path.exists():
                with open(path, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            sample = json.loads(line)
                        except json.JSONDecodeError:
                            continue  # tolerate a torn last line from a killed process
                        if start_ts <= sample.get("ts", 0) <= end_ts:
                            out.append(sample)
            day += timedelta(days=1)
        return out


def downsample(samples: list[dict[str, Any]], fields: list[str], max_points: int) -> list[dict[str, Any]]:
    """Bucket-average `fields` over time, same idea as the client-side JS downsample."""
    if len(samples) <= max_points:
        return samples
    bucket = -(-len(samples) // max_points)  # ceil div
    out = []
    for i in range(0, len(samples), bucket):
        chunk = samples[i : i + bucket]
        row: dict[str, Any] = {"ts": chunk[len(chunk) // 2]["ts"]}
        for field in fields:
            values = [c[field] for c in chunk if c.get(field) is not None]
            row[field] = sum(values) / len(values) if values else None
        out.append(row)
    return out


class Historian:
    """Owns the background poll loop. collect_fn returns one flat sample dict
    (must include "ts"); sinks is the fan-out list every sample is written to."""

    def __init__(self, collect_fn: Callable[[], dict[str, Any]], sinks: list[HistorySink], interval_s: float = POLL_INTERVAL_S):
        self._collect_fn = collect_fn
        self._sinks = sinks
        self._interval_s = interval_s
        self._task: asyncio.Task | None = None
        self.last_sample: dict[str, Any] | None = None
        self.last_error: str | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.ensure_future(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def _run(self) -> None:
        loop = asyncio.get_event_loop()
        while True:
            start = time.monotonic()
            try:
                sample = await loop.run_in_executor(None, self._collect_fn)
                for sink in self._sinks:
                    sink.write(sample)
                self.last_sample = sample
                self.last_error = None
            except Exception as exc:  # noqa: BLE001 -- a bad poll must not kill the loop
                self.last_error = str(exc)
            elapsed = time.monotonic() - start
            await asyncio.sleep(max(0.0, self._interval_s - elapsed))
