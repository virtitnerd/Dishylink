"""
Server-side webhook notifications for alert transitions.

Deliberately server-side, not "the frontend detects an alert and calls a
relay endpoint" (which is what this project's own original implementation
did, and is still available for a one-off test send): a webhook's entire
point is to notify you when you're *not* looking at the dashboard, and a
browser-tab-only check can only ever fire while a tab happens to be open and
polling. This piggybacks on the historian's own poll loop instead, so it
keeps working for as long as the backend process is up, regardless of
whether anyone has the page open.

Config persists to a small local JSON file (STARLINK_CACHE_DIR/webhook.json)
-- no database, matching the rest of this project's philosophy.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

WEBHOOK_CONFIG_PATH = Path(os.environ.get("STARLINK_CACHE_DIR", "cache")) / "webhook.json"

_notified_open: set[tuple[str, str]] = set()
_state_initialized = False


def read_config() -> dict[str, Any]:
    try:
        return json.loads(WEBHOOK_CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"url": "", "enabled": False}


def write_config(url: str, enabled: bool) -> dict[str, Any]:
    WEBHOOK_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    config = {"url": url, "enabled": enabled}
    WEBHOOK_CONFIG_PATH.write_text(json.dumps(config), encoding="utf-8")
    return config


def validate_url(url: str) -> str | None:
    """Returns an error string, or None if the URL is acceptable."""
    scheme = urllib.parse.urlsplit(url).scheme
    if scheme not in ("http", "https"):
        return "webhook URL must be http:// or https://"
    return None


def send(url: str, title: str, body: str) -> dict[str, Any]:
    """Covers Slack ("text"), Discord ("content"), and generic JSON receivers
    ("title"/"message") in one POST, same as the original relay endpoint."""
    message = f"{title}: {body}"
    data = json.dumps(
        {"text": message, "content": message, "title": title, "message": body}
    ).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return {"ok": True, "status": resp.status}
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}


def _humanize(key: str) -> str:
    """"dishWaterDetected" -> "dish water detected"."""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    return s.lower()


def check_transitions(row: dict[str, Any]) -> None:
    """Called once per historian poll with the same row it's about to store.
    Fires the configured webhook for any alert flag that newly turned on or
    off since the last poll. Best-effort throughout: a bad/unreachable
    webhook URL must never interrupt the poll loop that calls this."""
    global _state_initialized

    config = read_config()
    if not config.get("enabled") or not config.get("url"):
        return

    active_now: set[tuple[str, str]] = set()
    for source, field in (("dish", "alerts"), ("router", "router_alerts")):
        for key, value in (row.get(field) or {}).items():
            if value:
                active_now.add((source, key))

    if not _state_initialized:
        # Don't fire for whatever was already firing when this process started
        # -- only genuinely new transitions from here on are worth a ping.
        _notified_open.clear()
        _notified_open.update(active_now)
        _state_initialized = True
        return

    newly_opened = active_now - _notified_open
    newly_cleared = _notified_open - active_now
    _notified_open.clear()
    _notified_open.update(active_now)

    if not newly_opened and not newly_cleared:
        return

    url = config["url"]
    for source, key in newly_opened:
        send(url, f"{source.capitalize()} alert", _humanize(key))
    for source, key in newly_cleared:
        send(url, f"{source.capitalize()} alert cleared", _humanize(key))
