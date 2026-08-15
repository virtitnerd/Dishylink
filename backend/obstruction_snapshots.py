"""
Periodic obstruction-map snapshots for the time-lapse view.

Quantizes the dish's live map (a "usable fraction" per cell, 0..1, negative
meaning never observed -- despite the schema calling the field "snr") into
the same 4-level classification the live dome view uses (mirroring dishylink's
own obstructionGrid.ts, so a time-lapse frame and the live view never disagree
about what counts as obstructed), and packs 4 cells per byte the same way its
unpacker expects: cell N's 2 bits live at bit position (N % 4) * 2 within byte
N // 4 -- little-endian within the byte, first cell in the low bits.
"""
from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from typing import Any, Callable

SNAPSHOTS_PATH = Path(os.environ.get("STARLINK_CACHE_DIR", "cache")) / "obstruction_snapshots.jsonl"
SNAPSHOT_INTERVAL_S = 3600.0  # hourly frames
RETENTION_S = 90 * 86400.0  # ~3 months of hourly frames

CELL_UNMAPPED, CELL_CLEAR, CELL_PARTIAL, CELL_OBSTRUCTED = 0, 1, 2, 3
OBSTRUCTED_FRACTION_FLOOR = 0.005
PARTIAL_FRACTION_CEILING = 0.25


def _classify(fraction_usable: float) -> int:
    if fraction_usable < 0:
        return CELL_UNMAPPED
    obstructed_fraction = 1 - fraction_usable
    if obstructed_fraction <= OBSTRUCTED_FRACTION_FLOOR:
        return CELL_CLEAR
    return CELL_PARTIAL if obstructed_fraction <= PARTIAL_FRACTION_CEILING else CELL_OBSTRUCTED


def pack_cells(fractions: list[float]) -> str:
    cells = [_classify(v) for v in fractions]
    packed = bytearray(-(-len(cells) // 4))  # ceil div
    for i, cell in enumerate(cells):
        packed[i >> 2] |= cell << ((i & 3) * 2)
    return base64.b64encode(bytes(packed)).decode("ascii")


_last_capture_s = 0.0


def maybe_capture(get_map: Callable[[], dict[str, Any]], now_s: float | None = None) -> None:
    """Called once per historian poll; only actually fetches+writes a frame
    roughly once an hour, so a 10s poll cadence doesn't turn into an hourly
    RPC's worth of throwaway calls every 10 seconds. Best-effort: a
    malformed/empty map, or the RPC itself failing, is silently skipped
    rather than raising into the poll loop."""
    global _last_capture_s
    now_s = time.time() if now_s is None else now_s
    if now_s - _last_capture_s < SNAPSHOT_INTERVAL_S:
        return
    obstruction_map = get_map()
    fractions = obstruction_map.get("snr")
    num_rows = obstruction_map.get("numRows")
    if not fractions or not num_rows:
        return
    _last_capture_s = now_s
    snapshot = {
        "takenAtMs": int(now_s * 1000),
        "gridSize": num_rows,
        "packedCells": pack_cells(fractions),
        "maxThetaDeg": obstruction_map.get("maxThetaDeg"),
    }
    SNAPSHOTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(SNAPSHOTS_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(snapshot, separators=(",", ":")) + "\n")
    _prune(now_s)


def _prune(now_s: float) -> None:
    """Drop frames older than RETENTION_S. Rewrites the whole file, which is
    fine at an hourly write cadence (at most a few thousand lines)."""
    cutoff_ms = (now_s - RETENTION_S) * 1000
    try:
        lines = SNAPSHOTS_PATH.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return
    kept = []
    for line in lines:
        try:
            if json.loads(line).get("takenAtMs", 0) >= cutoff_ms:
                kept.append(line)
        except json.JSONDecodeError:
            continue
    if len(kept) != len(lines):
        SNAPSHOTS_PATH.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")


def read_snapshots() -> list[dict[str, Any]]:
    try:
        lines = SNAPSHOTS_PATH.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out
