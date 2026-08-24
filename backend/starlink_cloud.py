"""
Server-side port of cloud/starlinkCloudHandler.ts (+ core/routerClientUpdate.ts,
core/routerWifiConfigUpdate.ts, core/dishConfigUpdate.ts, core/grpcWeb.ts) --
session handling, token refresh, and every cloud read/write this project's
frontend can make, run from this process instead of a browser/Electron/
extension host. This is what makes the Docker image single-port: the frontend
already assumes /cloud/* is same-origin (see lib/cloudHost.ts's
sameOriginTransport), and until now nothing served it here.

Kept a close, deliberate 1:1 port of the TS logic rather than a redesign --
any schema-mapping fix (e.g. the still-provisional sandboxId level mapping)
has to land in both places, and staying structurally identical is what makes
that tractable to keep in sync by inspection.

Session cookie persists to STARLINK_CACHE_DIR/starlink-cookie (plaintext --
same trust model as webhook.json/client_totals.json already living there;
this is a single-user local tool, not a multi-tenant service).
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from google.protobuf import json_format

from starlink_client import StarlinkError, get_client

COOKIE_PATH = Path(os.environ.get("STARLINK_CACHE_DIR", "cache")) / "starlink-cookie"

AUTH_URL = "https://api.starlink.com/auth-rp/auth/user"
API = "https://starlink.com/api"
DEVICE_HANDLE = f"{API}/SpaceX.API.Device.Device/Handle"
REFRESH_TTL_S = 60.0
IDS_TTL_S = 5 * 60.0
RETRY_DELAY_S = 0.15
DEVICE_CALL_TIMEOUT_S = 15.0

SSO_COOKIE_RE = re.compile(r"Starlink\.Com\.Sso=")
ACCESS_V1_RE = re.compile(r"Starlink\.Com\.Access\.V1=([^;]+)")
ACCESS_V1_STRIP_RE = re.compile(r"Starlink\.Com\.Access\.V1=[^;]*;?")

NOT_CONNECTED = (428, {"error": "not_connected", "message": "An authorized account is required — sign in to use this feature."})

# Answered wherever a router has to be named, so every surface says the same
# waitable thing rather than reporting an outage.
NO_CONTROLLER = (503, {
    "error": "router_not_reported",
    "message": "Starlink hasn't reported your router yet, so there's nothing to send this to. Try again once it checks in.",
})

DEVICE_RETRY_DELAY_S = 5.0


class SessionExpiredError(Exception):
    pass


class UpstreamError(Exception):
    pass


class ControllerUnknownError(Exception):
    """The account has not named a router this write could target. Nothing is
    wrong with the session or the connection: the telemetry feed is
    momentarily empty, and it fills in again on its own."""


class DispatchFailure(Exception):
    """A failure raised by the write itself rather than by anything leading up
    to it -- carried on the error because a session miss retries the whole
    attempt, and a flag set by an earlier one would still be standing."""

    def __init__(self, reason: BaseException):
        super().__init__("router config write failed")
        self.reason = reason


# -- session persistence ------------------------------------------------------

def read_cookie() -> str | None:
    try:
        return COOKIE_PATH.read_text(encoding="utf-8").strip() or None
    except FileNotFoundError:
        return None


def write_cookie(cookie: str) -> None:
    COOKIE_PATH.parent.mkdir(parents=True, exist_ok=True)
    COOKIE_PATH.write_text(cookie, encoding="utf-8")


def clear_cookie() -> None:
    try:
        COOKIE_PATH.unlink()
    except FileNotFoundError:
        pass


_cached_cookie: str | None = None
_cached_at = 0.0
_cached_ids: dict[str, str] | None = None
_cached_ids_at = 0.0
_cached_controller_id: str | None = None
_cached_controller_id_at = 0.0
_refresh_lock = threading.Lock()
_mutation_lock = threading.Lock()


def _forget_session() -> None:
    global _cached_cookie, _cached_at, _cached_ids, _cached_ids_at
    global _cached_controller_id, _cached_controller_id_at
    _cached_cookie = None
    _cached_at = 0.0
    _cached_ids = None
    _cached_ids_at = 0.0
    _cached_controller_id = None
    _cached_controller_id_at = 0.0


def _http(url: str, *, cookie: str | None = None, method: str = "GET", json_body: Any = None, timeout: float = DEVICE_CALL_TIMEOUT_S):
    """Raw HTTP call returning (status, headers, body_bytes). Never raises on
    a non-2xx status -- callers decide what that means."""
    headers = {"accept": "application/json"}
    if cookie is not None:
        headers["cookie"] = cookie
    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), exc.read()
    except urllib.error.URLError as exc:
        raise UpstreamError(str(exc)) from exc


def _fresh_cookie(force: bool = False) -> str | None:
    """Swap in a freshly-minted Access.V1 (webagg/telemetryagg 401 without it).
    force busts the 60s cache after a mid-flight expiry."""
    global _cached_cookie, _cached_at
    base = read_cookie()
    if not base:
        return None
    if not force and _cached_cookie and time.time() - _cached_at < REFRESH_TTL_S:
        return _cached_cookie
    with _refresh_lock:
        if not force and _cached_cookie and time.time() - _cached_at < REFRESH_TTL_S:
            return _cached_cookie
        status, headers, _body = _http(AUTH_URL, cookie=base)
        if status in (401, 403):
            _forget_session()
            raise SessionExpiredError()
        set_cookie = headers.get("set-cookie") or headers.get("Set-Cookie") or ""
        match = ACCESS_V1_RE.search(set_cookie)
        without_old = ACCESS_V1_STRIP_RE.sub("", base).strip()
        _cached_cookie = f"Starlink.Com.Access.V1={match.group(1)};{without_old}" if match else base
        _cached_at = time.time()
        return _cached_cookie


def _with_fresh_cookie(run: Callable[[str], Any]) -> Any:
    """Run one sequence of cloud calls with a valid token, healing one
    transient session miss (a just-pasted cookie can race the auth call the
    same way a just-connected extension session does)."""
    def attempt(force: bool):
        cookie = _fresh_cookie(force)
        if not cookie:
            raise SessionExpiredError()
        return run(cookie)

    try:
        return attempt(False)
    except SessionExpiredError:
        if RETRY_DELAY_S > 0:
            time.sleep(RETRY_DELAY_S)
        return attempt(True)


def _api_get(path: str, cookie: str) -> Any:
    status, _headers, body = _http(f"{API}{path}", cookie=cookie)
    if status in (401, 403):
        raise SessionExpiredError()
    if status >= 300:
        raise UpstreamError(f"GET {path} → HTTP {status}")
    return json.loads(body)


def _api_post(path: str, cookie: str, payload: Any) -> Any:
    status, _headers, body = _http(f"{API}{path}", cookie=cookie, method="POST", json_body=payload)
    if status in (401, 403):
        raise SessionExpiredError()
    if status >= 300:
        raise UpstreamError(f"POST {path} → HTTP {status}")
    return json.loads(body)


def _fetch_identity(cookie: str) -> Any:
    status, _headers, body = _http(AUTH_URL, cookie=cookie)
    if status in (401, 403):
        raise SessionExpiredError()
    if status >= 300:
        raise UpstreamError(f"auth/user → HTTP {status}")
    return json.loads(body)


def _resilient_identity(cookie: str) -> Any | None:
    try:
        return _fetch_identity(cookie)
    except SessionExpiredError:
        if RETRY_DELAY_S > 0:
            time.sleep(RETRY_DELAY_S)
        try:
            refreshed = _fresh_cookie(True)
        except SessionExpiredError:
            return None
        if not refreshed:
            return None
        try:
            return _fetch_identity(refreshed)
        except Exception:
            return None
    except Exception:
        return None


def _num(value: Any) -> float | None:
    """Finite number or None -- a missing legend field must not leak NaN."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n and n not in (float("inf"), float("-inf")) else None  # noqa: PLR0124 -- NaN check


def device_telemetry_from(telemetry: Any) -> dict[str, dict[str, Any]]:
    """Per-device live stats from the telemetry feed, keyed by full DeviceId
    ("ut<uuid>" for dishes, "Router-<hex>" for routers). Port of
    deviceTelemetryFrom in starlinkCloudHandler.ts -- kept in this handler
    (not left for the frontend) because that's where the TS version does it."""
    out: dict[str, dict[str, Any]] = {}
    data = (telemetry or {}).get("data") if isinstance(telemetry, dict) else None
    if not data or not data.get("values") or not data.get("columnNamesByDeviceType"):
        return out
    legends = data["columnNamesByDeviceType"]
    for row in data["values"]:
        kind = row[0]
        legend = legends.get(kind)
        if not legend:
            continue

        def get(name: str, _row=row, _legend=legend):
            idx = _legend.index(name) if name in _legend else -1
            return _row[idx] if 0 <= idx < len(_row) else None

        device_id = str(get("DeviceId") or "")
        if not device_id:
            continue
        timestamp_ms = (_num(get("UtcTimestampNs")) or 0) / 1e6
        if kind == "u":
            out[device_id] = {
                "kind": "dish",
                "timestampMs": timestamp_ms,
                "softwareVersion": get("RunningSoftwareVersion"),
                "uptimeS": _num(get("Uptime")),
                "obstructionPct": _num(get("ObstructionPercentTime")),
                "signalQuality": _num(get("SignalQuality")),
            }
        elif kind == "r":
            out[device_id] = {
                "kind": "router",
                "timestampMs": timestamp_ms,
                "hardwareVersion": get("WifiHardwareVersion"),
                "softwareVersion": get("WifiSoftwareVersion"),
                "uptimeS": _num(get("WifiUptimeS")),
                "clients": _num(get("Clients")),
                "hops": _num(get("WifiHopsFromController")),
                "isRepeater": get("WifiIsRepeater") is True,
                "isBypassed": get("WifiIsBypassed") is True,
            }
    return out


def _resolve_ids(cookie: str) -> dict[str, str]:
    global _cached_ids, _cached_ids_at
    if _cached_ids and time.time() - _cached_ids_at < IDS_TTL_S:
        return _cached_ids
    listing = _api_get(
        "/webagg/v2/accounts/service-lines?limit=100&page=0&isConverting=false&serviceAddressId=&onlyActive=false&searchString=&onlyNoUts=false",
        cookie,
    )
    results = ((listing.get("content") or {}).get("results")) or []
    first = results[0] if results else {}
    sl, acc = first.get("serviceLineNumber"), first.get("accountReferenceId")
    if not sl or not acc:
        raise UpstreamError("no service line on this account")
    _cached_ids = {"acc": acc, "sl": sl}
    _cached_ids_at = time.time()
    return _cached_ids


def _remember_controller(telemetry: Any, last_resort: bool = False) -> bool:
    """Caches the controller named by any telemetry reply, so a write prepared
    over a network it is about to take down needs one round trip fewer.

    `last_resort` is only for a caller about to write: a lone router in a
    reply is the controller when someone asked for it right then, but a
    bypass flip can drop the controller out of telemetry for a moment, and a
    background read landing there would cache the mesh node -- which is never
    the controller and answers DEVICE_NOT_CONNECTED -- for the whole life of
    the cache."""
    global _cached_controller_id, _cached_controller_id_at
    routers = [
        (device_id, dev)
        for device_id, dev in device_telemetry_from(telemetry).items()
        if dev.get("kind") == "router"
    ]
    controller = next((r for r in routers if r[1].get("hops") == 0), None)
    if controller is None and last_resort and len(routers) == 1:
        controller = routers[0]
    if controller is None:
        return False
    _cached_controller_id = controller[0]
    _cached_controller_id_at = time.time()
    return True


def _resolve_controller_id(cookie: str, cached: bool = True) -> str:
    """The router to configure, named by the account rather than by the LAN.

    A mesh node reports as a router too, so the id cannot simply be "the one
    router on the account" -- this kit has two. `WifiHopsFromController` is
    what separates them: the controller is zero hops from itself, and every
    node sits behind it. Sourcing this from telemetry rather than the local
    router is the whole reason a bypassed kit, which answers nothing on the
    LAN, can still be configured.

    `cached=False` is for a write: the id is learned from a telemetry
    snapshot, and the snapshot taken during a flip can omit the controller and
    name only a mesh node, which is never connected. Cached, that answer
    outlives the flip and refuses every write behind it."""
    global _cached_controller_id, _cached_controller_id_at
    if cached and _cached_controller_id and time.time() - _cached_controller_id_at < IDS_TTL_S:
        return _cached_controller_id
    ids = _resolve_ids(cookie)
    telemetry = _api_post("/device-data/cache/v1/telemetry", cookie, {"accountNumber": ids["acc"]})
    if not _remember_controller(telemetry, last_resort=True):
        raise ControllerUnknownError()
    return _cached_controller_id  # type: ignore[return-value]


def _with_router_gateway(run: Callable[[str, Callable[[bytes], bytes]], Any]) -> Any:
    """Run one bounded read against the account's controller: resolve the
    target, hand the callback a gateway bound to a fresh token, and let a
    session miss heal the way every other call here does."""

    def attempt(cookie: str) -> Any:
        target_id = _resolve_controller_id(cookie)
        return run(target_id, lambda request_bytes: _grpc_web_unary_call(DEVICE_HANDLE, request_bytes, cookie))

    return _with_fresh_cookie(attempt)


class _RouterReader:
    """Resolves once whether this router can be read over the LAN right now,
    then serves every read a prepare step needs from wherever that resolved
    to -- LAN when reachable, the account's cloud gateway otherwise (needed
    for a kit in bypass mode, which has no reachable router on the LAN at
    all). Resolved once per prepare call rather than once per read, so a
    request built from two reads is never a mix of a LAN snapshot and a cloud
    one."""

    def __init__(self, cookie: str):
        try:
            client = get_client()
            status = client.get_router_status()
            target_id = (status.get("deviceInfo") or {}).get("id")
            if not target_id:
                raise StarlinkError("Starlink router identity is unavailable")
            self._client = client
            self._target_id = target_id
            self._call_gateway: Callable[[bytes], bytes] | None = None
        except StarlinkError:
            self._client = None
            self._target_id = _resolve_controller_id(cookie)
            self._call_gateway = lambda request_bytes: _grpc_web_unary_call(DEVICE_HANDLE, request_bytes, cookie)

    @property
    def target_id(self) -> str:
        return self._target_id

    def wifi_config(self) -> dict:
        if self._client is not None:
            return self._client.get_wifi_config().get("wifiConfig", {})
        assert self._call_gateway is not None
        return read_router_wifi_config(self._target_id, self._call_gateway) or {}

    def wifi_clients(self) -> list[dict]:
        if self._client is not None:
            return self._client.get_wifi_clients().get("clients") or []
        assert self._call_gateway is not None
        return read_router_clients(self._target_id, self._call_gateway)


# -- session connect/disconnect + read routes --------------------------------

def connect(cookie: str) -> tuple[int, dict]:
    trimmed = (cookie or "").strip()
    if not SSO_COOKIE_RE.search(trimmed):
        return 400, {"error": "bad_cookie", "message": "That doesn't look like a Starlink session — it must include Starlink.Com.Sso."}
    write_cookie(trimmed)
    _forget_session()
    try:
        _with_fresh_cookie(lambda c: _resolve_ids(c))
        return 200, {"ok": True}
    except SessionExpiredError:
        return 428, {"error": "not_connected", "message": "That session didn't authenticate — sign in at starlink.com again."}
    except (UpstreamError, Exception) as exc:  # noqa: BLE001 -- API boundary
        return 502, {"error": "upstream_failed", "message": str(exc)}


def disconnect() -> tuple[int, dict]:
    clear_cookie()
    _forget_session()
    return 200, {"ok": True}


# Local-first reads for the three router-* cloud routes: this process can
# usually reach the router directly, and a LAN read costs nothing a cloud
# round trip doesn't also cost -- so it's tried first, with no cloud session
# required at all when it answers. Only a router this LAN cannot reach (not on
# its network, or genuinely bypassed) falls through to the account.
_ROUTER_READS: dict[str, tuple[Callable[[], Any], Callable[[str, Callable[[bytes], bytes]], Any]]] = {
    "/cloud/router-subnet": (
        lambda: {"subnet": (lambda ns: (ns[0].get("ipv4") if ns and isinstance(ns[0].get("ipv4"), str) else None))(
            get_client().get_wifi_config().get("wifiConfig", {}).get("networks") or []
        )},
        lambda target_id, call_gateway: {"subnet": read_current_subnet(target_id, call_gateway)},
    ),
    "/cloud/router-clients": (
        lambda: {"clients": get_client().get_wifi_clients().get("clients") or []},
        lambda target_id, call_gateway: {"clients": read_router_clients(target_id, call_gateway)},
    ),
    "/cloud/router-config": (
        lambda: {"wifiConfig": get_client().get_wifi_config().get("wifiConfig", {})},
        lambda target_id, call_gateway: {"wifiConfig": read_router_wifi_config(target_id, call_gateway)},
    ),
}


def handle(route: str) -> tuple[int, dict]:
    """route is the path without query, e.g. "/cloud/account"."""
    if route in _ROUTER_READS:
        local_read, cloud_read = _ROUTER_READS[route]
        try:
            return 200, local_read()
        except StarlinkError:
            pass
        if not read_cookie():
            return NOT_CONNECTED
        try:
            return 200, _with_router_gateway(cloud_read)
        except SessionExpiredError:
            return NOT_CONNECTED
        except ControllerUnknownError:
            return NO_CONTROLLER
        except Exception as exc:  # noqa: BLE001 -- API boundary
            return 502, {"error": "upstream_failed", "message": str(exc)}

    if not read_cookie():
        return NOT_CONNECTED
    try:
        if route == "/cloud/account":
            def run(cookie: str):
                ids = _resolve_ids(cookie)
                identity = _resilient_identity(cookie)
                service_line = _api_get(f"/webagg/v2/accounts/service-line/{ids['sl']}", cookie)
                try:
                    telemetry = _api_post("/device-data/cache/v1/telemetry", cookie, {"accountNumber": ids["acc"]})
                except Exception:
                    telemetry = None
                return {
                    "identity": identity,
                    "serviceLine": service_line,
                    "deviceTelemetry": device_telemetry_from(telemetry),
                }

            return 200, _with_fresh_cookie(run)
        if route == "/cloud/usage":
            def run(cookie: str):
                ids = _resolve_ids(cookie)
                return _api_get(f"/telemetryagg/v1/data-usage/account/{ids['acc']}/service-line/{ids['sl']}/annotated", cookie)

            return 200, _with_fresh_cookie(run)
        if route == "/cloud/telemetry":
            def run(cookie: str):
                ids = _resolve_ids(cookie)
                return _api_post("/device-data/cache/v1/telemetry", cookie, {"accountNumber": ids["acc"]})

            return 200, _with_fresh_cookie(run)
        return 404, {"error": "unknown_cloud_route", "route": route}
    except SessionExpiredError:
        return NOT_CONNECTED
    except ControllerUnknownError:
        return NO_CONTROLLER
    except Exception as exc:  # noqa: BLE001 -- API boundary
        return 502, {"error": "upstream_failed", "message": str(exc)}


# -- grpc-web transport (port of core/grpcWeb.ts) -----------------------------
# Wire format: each frame is a 1-byte flag + 4-byte big-endian length + payload.
# Flag 0x00 = protobuf message, 0x80 = text trailers ("grpc-status: 0\r\n...").
# A unary call sends one message frame and receives one message frame followed
# by a trailers frame (or, on errors, the status arrives as HTTP headers with
# no body) -- starlink_client.py's _handle_router only ever checks the header
# form, since the local router only ever answers that way; the cloud gateway
# needs both paths handled, same as the TS transport this ports.

class GrpcWebCallError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"grpc-web call failed (status {status}): {message}")
        self.status = status
        self.grpc_message = message


def _encode_frame(message_bytes: bytes) -> bytes:
    return b"\x00" + len(message_bytes).to_bytes(4, "big") + message_bytes


def _parse_trailers(text: str) -> tuple[int, str]:
    status = 0
    message = ""
    for line in text.split("\r\n"):
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if key == "grpc-status":
            try:
                status = int(value)
            except ValueError:
                status = 0
        if key == "grpc-message":
            from urllib.parse import unquote
            message = unquote(value)
    return status, message


def _grpc_web_unary_call(url: str, request_bytes: bytes, cookie: str) -> bytes:
    req = urllib.request.Request(
        url,
        data=_encode_frame(request_bytes),
        headers={"Content-Type": "application/grpc-web+proto", "X-Grpc-Web": "1", "cookie": cookie},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=DEVICE_CALL_TIMEOUT_S) as resp:
            status_code, headers, body = resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        status_code, headers, body = exc.code, dict(exc.headers or {}), exc.read()
    except TimeoutError:
        raise
    except urllib.error.URLError as exc:
        raise UpstreamError(str(exc)) from exc

    # Trailers-only responses carry the status in HTTP headers.
    header_status = headers.get("grpc-status") or headers.get("Grpc-Status")
    if header_status is not None and int(header_status) != 0:
        raise GrpcWebCallError(int(header_status), headers.get("grpc-message") or headers.get("Grpc-Message") or "unknown error")
    if status_code >= 300:
        raise GrpcWebCallError(16 if status_code in (401, 403) else 2, f"HTTP {status_code}")

    response_message: bytes | None = None
    offset = 0
    while offset + 5 <= len(body):
        flag = body[offset]
        length = int.from_bytes(body[offset + 1 : offset + 5], "big")
        payload = body[offset + 5 : offset + 5 + length]
        offset += 5 + length
        if flag == 0x00:
            response_message = payload
        elif flag & 0x80:
            trailer_status, trailer_message = _parse_trailers(payload.decode("utf-8", errors="replace"))
            if trailer_status != 0:
                raise GrpcWebCallError(trailer_status, trailer_message)

    if response_message is None:
        raise GrpcWebCallError(2, "response contained no message frame")
    return response_message


def _build_request_bytes(request_json: dict) -> bytes:
    """A Device.Request built from a JSON-shaped dict (camelCase field names,
    same shape as the TS *RequestJson interfaces) via json_format.ParseDict --
    the Python equivalent of the TS side's fromJson(schema, obj). Reuses the
    schema starlink_client.py already pulled via reflection rather than
    fetching it a second time; the cloud gateway and the local dish/router
    speak the exact same Device.Request/Response schema."""
    request = get_client().new_request_message()
    json_format.ParseDict(request_json, request, ignore_unknown_fields=False)
    return request.SerializeToString()


class ApplicationRejectedError(Exception):
    """Starlink accepted the RPC (200 OK / grpc-status 0) but the decoded
    Response carries a non-zero status.code -- confirmed live (2026-08-15,
    deleteNetwork): a bss sent with both its real bssid AND a password (even
    the read-back masked "•••••" one) is rejected this way, inside the
    response body, not as a transport-level error. Left unchecked, a request
    built the wrong way looks like success and silently changes nothing."""


def _redact_passwords(value: Any) -> Any:
    """Deep-copy `value`, replacing every "password" string with a length +
    masked-sentinel marker instead of the real value -- for logging only,
    never for what's actually sent to Starlink."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k == "password" and isinstance(v, str):
                out[k] = f"<{len(v)} chars, masked-sentinel={v == '•••••'}>"
            else:
                out[k] = _redact_passwords(v)
        return out
    if isinstance(value, list):
        return [_redact_passwords(v) for v in value]
    return value


def _apply_device_update(prepare_fn: Callable[[dict, str], dict], update: dict, label: str) -> tuple[int, dict]:
    if not read_cookie():
        return NOT_CONNECTED
    try:
        # Keep preparation (a local-or-cloud read) and the corresponding write
        # in one serialized critical section, so a later mutation can't be
        # built from a snapshot predating an earlier write -- port of
        # deviceMutationTail. Preparation needs a cookie now too (the fallback
        # read rides the same account gateway the write does), so it moves
        # inside the fresh-cookie retry rather than running ahead of it.
        with _mutation_lock:
            def run(cookie: str) -> None:
                request_json = prepare_fn(update, cookie)
                request_bytes = _build_request_bytes(request_json)
                try:
                    response_bytes = _grpc_web_unary_call(DEVICE_HANDLE, request_bytes, cookie)
                except GrpcWebCallError as exc:
                    if exc.status == 16:
                        raise SessionExpiredError()
                    raise
                # The RPC succeeding at the transport level doesn't mean
                # Starlink actually applied the change -- see
                # ApplicationRejectedError's own note.
                response = get_client().new_response_message()
                response.ParseFromString(response_bytes)
                status = json_format.MessageToDict(response, preserving_proto_field_name=False).get("status")
                if status and status.get("code"):
                    raise ApplicationRejectedError(status.get("message") or f"status code {status['code']}")

            _with_fresh_cookie(run)
        return 200, {"ok": True}
    except SessionExpiredError:
        return NOT_CONNECTED
    except TimeoutError:
        return 504, {
            "error": "device_call_timeout",
            "message": f"Starlink did not answer the {label} update in time. Try again.",
        }
    except ApplicationRejectedError as exc:
        return 502, {"error": "device_update_rejected", "message": str(exc)}
    except Exception as exc:  # noqa: BLE001 -- API boundary
        return 502, {"error": "device_call_failed", "message": str(exc)}


# -- client rename/pause (port of core/routerClientUpdate.ts) ----------------

PERMANENT_GROUP = "_permanent"
WEEK_MINUTES = 7 * 24 * 60


def _client_request_for(target_id: str, client_configs: list[dict]) -> dict:
    if not target_id.startswith("Router-"):
        raise ValueError("invalid router target id")
    return {"targetId": target_id, "wifiSetConfig": {"wifiConfig": {"clientConfigs": client_configs, "applyClientConfigs": True}}}


def _build_router_pause_request(target_id: str, config: dict, client_id: int, paused: bool, live_client: dict | None) -> dict:
    existing = list(config.get("clientConfigs") or [])
    if not any(c.get("clientId") == client_id for c in existing):
        if not live_client or live_client.get("clientId") != client_id or not live_client.get("macAddress"):
            raise ValueError("client is absent from router configuration and live clients")
        existing.append({"clientId": client_id, "macAddress": live_client["macAddress"]})
    client_configs = []
    for client in existing:
        if client.get("clientId") != client_id:
            client_configs.append(dict(client))
            continue
        schedules = [s for s in (client.get("weeklyBlockSchedules") or []) if s.get("groupId") != PERMANENT_GROUP]
        if paused:
            schedules.append({"blockRanges": [{"startMinutes": 0, "endMinutes": WEEK_MINUTES}], "groupId": PERMANENT_GROUP})
        client_configs.append({**client, "weeklyBlockSchedules": schedules})
    return _client_request_for(target_id, client_configs)


def _build_router_rename_request(target_id: str, config: dict, client_id: int, given_name: str, live_client: dict | None) -> dict:
    existing = list(config.get("clientConfigs") or [])
    if not any(c.get("clientId") == client_id for c in existing):
        if not live_client or live_client.get("clientId") != client_id or not live_client.get("macAddress"):
            raise ValueError("Device is not known to the router")
        existing.append({"clientId": client_id, "macAddress": live_client["macAddress"]})
    return _client_request_for(
        target_id,
        [{**c, "givenName": given_name} if c.get("clientId") == client_id else dict(c) for c in existing],
    )


def _local_ips() -> set[str]:
    ips = {"127.0.0.1", "::1"}
    try:
        import socket

        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))  # never actually sent; just picks the outbound interface
        ips.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass
    return ips


def _client_is_host(client: dict) -> bool:
    """True when this client entry is the machine running this server -- port
    of clientIsHost in core/routerClientUpdate.ts, scoped to what a server
    process can know about itself (its own routable IPs; no MAC comparison --
    unlike Electron's os.networkInterfaces(), there's no portable way to read
    a process's own interface MACs here without a new dependency, and IP alone
    is enough to catch the case that matters: the server pausing itself off
    the network it needs to keep talking to the router)."""
    local = _local_ips()
    ip = (client.get("ipAddress") or "").replace("::ffff:", "").lower()
    if ip and ip in local:
        return True
    return any((v6 or "").replace("::ffff:", "").lower() in local for v6 in client.get("ipv6Addresses") or [])


def _prepare_client_update(update: dict, cookie: str) -> dict:
    """Reads the router directly when this process can reach it, and falls
    back to the account's cloud gateway otherwise -- the fallback is what
    lets a device be paused or renamed on a kit in bypass mode, which has no
    reachable router on the LAN at all, or from a machine that isn't on that
    network in the first place."""
    reader = _RouterReader(cookie)
    config = reader.wifi_config()
    target_id = reader.target_id

    if update["kind"] == "rename":
        client_id = update["clientId"]
        saved = any(c.get("clientId") == client_id for c in (config.get("clientConfigs") or []))
        live_client = None
        if not saved:
            clients = reader.wifi_clients()
            live_client = next((c for c in clients if c.get("clientId") == client_id), None)
        return _build_router_rename_request(target_id, config, client_id, update["givenName"], live_client)

    client_id = update["clientId"]
    clients = reader.wifi_clients()
    live_client = next((c for c in clients if c.get("clientId") == client_id), None)
    if not live_client:
        raise ValueError("Device is no longer connected to the router")
    if update["paused"] and _client_is_host(live_client):
        raise ValueError("Refusing to pause the device this server is running on")
    return _build_router_pause_request(target_id, config, client_id, update["paused"], live_client)


# -- router WifiConfig writes (port of core/routerWifiConfigUpdate.ts) -------

NETWORK_MODE_FIELDS = {
    "default": {"guest": False, "clientIsolation": False, "disableWhenOffline": False},
    "guest": {"guest": True, "clientIsolation": True, "disableWhenOffline": False},
    "auto": {"guest": False, "clientIsolation": False, "disableWhenOffline": True},
}

SUBNET_OPTIONS = [
    "192.168.1.1/24",
    "192.168.2.1/24",
    "192.168.3.1/24",
    "192.168.4.1/24",
    "10.0.0.1/16",
    "10.1.0.1/16",
    "10.2.0.1/16",
    "10.3.0.1/16",
]


def _next_domain(networks: list[dict]) -> str:
    used = {n.get("domain") for n in networks if n.get("domain")}
    if "lan" not in used:
        return "lan"
    i = 1
    while f"lan{i}" in used:
        i += 1
    return f"lan{i}"


def _next_vlan(networks: list[dict]) -> int:
    used = {n.get("vlan") for n in networks if n.get("vlan") is not None}
    vlan = 100
    while vlan in used:
        vlan += 100
    return vlan


def _with_apply_flags(changes: dict) -> dict:
    out: dict[str, Any] = {}
    for field, value in changes.items():
        out[field] = value
        out[f"apply{field[0].upper()}{field[1:]}"] = True
    return out


def _wifi_config_request_for(target_id: str, changes: dict) -> dict:
    if not target_id.startswith("Router-"):
        raise ValueError("invalid router target id")
    return {"targetId": target_id, "wifiSetConfig": {"wifiConfig": _with_apply_flags(changes)}}


def _auth_fields_for(security: str | None, password: str) -> dict:
    if security == "wpa3":
        return {"authWpa3": {"password": password}}
    if security == "wpa2wpa3":
        return {"authWpa2Wpa3": {"password": password}}
    if security == "open":
        return {"authOpen": {}}
    return {"authWpa2": {"password": password}}


_AUTH_FIELDS = ("authWpa2", "authWpa3", "authWpa2Wpa3", "authOpen")


def _strip_bssid(bss: dict) -> dict:
    """bssid dropped -- confirmed live (2026-08-15) that Starlink's write
    validation rejects it outright ("Bssid must not be specified"): it's a
    read-only, router-assigned field, never something a write may echo back.
    A band left alone keeps its auth field exactly as read -- the masked
    "•••••" password IS the correct "leave this alone" signal (a bss must
    always carry *some* auth type: omitting it entirely is its own rejection,
    "Bss has unknown auth type: <nil>"). The rejection in both cases comes
    back inside the response body (status.code != 0), not as a
    transport-level error, so a request built the wrong way returns 200 OK
    and silently changes nothing -- see _apply_device_update's
    response-status check below, added for the same incident."""
    return {k: v for k, v in bss.items() if k != "bssid"}


def _strip_for_new_auth(bss: dict) -> dict:
    """bssid and every existing auth_* field dropped, for a band whose
    security is being freshly set -- the same reason a brand new band never
    carries a bssid either: the router mints its own."""
    return {k: v for k, v in bss.items() if k != "bssid" and k not in _AUTH_FIELDS}


def _passthrough_network(network: dict) -> dict:
    """A network passed through unmodified -- only bssid dropped from each
    band (see _strip_bssid); auth is left exactly as read."""
    return {
        **network,
        "basicServiceSets": [_strip_bssid(bss) for bss in network.get("basicServiceSets") or []],
    }


def _prepare_wifi_config_update(update: dict, cookie: str) -> dict:
    """Reads the router directly when this process can reach it, and falls
    back to the account's cloud gateway otherwise -- see _RouterReader. A kind
    that names one flat field (dns/bypassMode/routerAdvanced) needs no read at
    all, so those never actually touch the fallback; every other kind rewrites
    a shared block (networks/meshConfigs), which the fallback lets a
    LAN-unreachable router keep serving."""
    reader = _RouterReader(cookie)
    target_id = reader.target_id
    kind = update["kind"]

    if kind == "dns":
        return _wifi_config_request_for(
            target_id, {"nameservers": update["nameservers"], "customDnsDisabled": update["disabled"]}
        )

    if kind == "bypassMode":
        return _wifi_config_request_for(target_id, {"bypassMode": update["enabled"]})

    if kind == "contentFiltering":
        config = reader.wifi_config()
        networks = config.get("networks") or []
        if not networks:
            raise ValueError("router has no configured networks to filter")
        level = update["level"]
        new_networks = []
        for n in networks:
            nn = {**_passthrough_network(n), "sandboxEnabled": level != 0, "sandboxId": level}
            if update.get("allowDomains") is not None:
                nn["sandboxDomainAllowList"] = update["allowDomains"]
            new_networks.append(nn)
        return _wifi_config_request_for(target_id, {"networks": new_networks})

    if kind == "ssid":
        # networkDomain matters because band alone isn't unique -- RF_2GHZ and
        # RF_5GHZ each exist once per network. The auth_* fields are a oneof,
        # so every variant the read brought back is stripped before setting
        # exactly the one this write wants (see _auth_fields_for).
        config = reader.wifi_config()
        matched = False
        new_networks = []
        for network in config.get("networks") or []:
            if network.get("domain") != update["networkDomain"]:
                new_networks.append(_passthrough_network(network))
                continue
            new_bss = []
            for bss in network.get("basicServiceSets") or []:
                if bss.get("band") != update["band"]:
                    new_bss.append(_strip_bssid(bss))
                    continue
                matched = True
                bare = _strip_for_new_auth(bss)
                bare["ssid"] = update["ssid"]
                bare.update(_auth_fields_for(update.get("security"), update["password"]))
                if update.get("hidden") is not None:
                    bare["hidden"] = update["hidden"]
                if update.get("disable") is not None:
                    bare["disable"] = update["disable"]
                new_bss.append(bare)
            new_networks.append({**network, "basicServiceSets": new_bss})
        if not matched:
            raise ValueError(f"no network \"{update['networkDomain']}\" with band {update['band']} found")
        return _wifi_config_request_for(target_id, {"networks": new_networks})

    if kind == "networkSettings":
        config = reader.wifi_config()
        matched = False
        new_networks = []
        for network in config.get("networks") or []:
            if network.get("domain") != update["networkDomain"]:
                new_networks.append(_passthrough_network(network))
                continue
            matched = True
            nn = _passthrough_network(network)
            if update.get("mode") is not None:
                nn.update(NETWORK_MODE_FIELDS[update["mode"]])
            for field in (
                "ipv4", "dhcpv4Start", "dhcpv4End", "dhcpv4LeaseDurationS", "dhcpDisabled",
                "dnsDisabled", "dnsStaticEntries", "dnsForwardRules", "staticRoutes",
            ):
                if update.get(field) is not None:
                    nn[field] = update[field]
            new_networks.append(nn)
        if not matched:
            raise ValueError(f"no network \"{update['networkDomain']}\" found")
        return _wifi_config_request_for(target_id, {"networks": new_networks})

    if kind == "addNetwork":
        config = reader.wifi_config()
        existing = config.get("networks") or []
        domain = _next_domain(existing)
        vlan = _next_vlan(existing)
        hidden = update.get("hidden") or False
        new_network = {
            "domain": domain,
            "vlan": vlan,
            "ipv4": update["ipv4"],
            "dhcpv4Start": 20,
            "dhcpv4End": 254,
            "dhcpv4LeaseDurationS": 3600,
            **NETWORK_MODE_FIELDS[update["mode"]],
            # bssid deliberately omitted -- see routerWifiConfigUpdate.ts's own
            # note: every bssid on this router carries the locally-administered
            # bit, pointing at the router assigning them itself.
            "basicServiceSets": [
                {"band": "RF_2GHZ", "ssid": update["ssid"], "authWpa2": {"password": update["password"]}, "hidden": hidden},
                {"band": "RF_5GHZ", "ssid": update["ssid"], "authWpa2": {"password": update["password"]}, "hidden": hidden},
            ],
        }
        return _wifi_config_request_for(
            target_id, {"networks": [*(_passthrough_network(n) for n in existing), new_network]}
        )

    if kind == "deleteNetwork":
        config = reader.wifi_config()
        existing = config.get("networks") or []
        if existing and existing[0].get("domain") == update["networkDomain"]:
            raise ValueError("the first network can't be deleted, only modified")
        new_networks = [_passthrough_network(n) for n in existing if n.get("domain") != update["networkDomain"]]
        if len(new_networks) == len(existing):
            raise ValueError(f"no network \"{update['networkDomain']}\" found")
        return _wifi_config_request_for(target_id, {"networks": new_networks})

    if kind == "routerAdvanced":
        # Flat WifiConfig fields, each with its own apply_<field> flag -- no
        # read needed, same as "dns"/"bypassMode" above.
        changes = {k: v for k, v in update.items() if k not in ("kind", "disableMeshOnboarding") and v is not None}
        # The schema splits wired vs wireless mesh pairing into two flags; the
        # UI offers one "lock mesh onboarding" toggle, so both are set together.
        if update.get("disableMeshOnboarding") is not None:
            changes["disableMeshOnboarding"] = update["disableMeshOnboarding"]
            changes["disableWirelessMeshOnboarding"] = update["disableMeshOnboarding"]
        if not changes:
            raise ValueError("no changes given")
        return _wifi_config_request_for(target_id, changes)

    if kind == "meshTrust":
        # meshConfigs is a map keyed by deviceId -- read-modify-write the one
        # entry, same reason networks[] needs it.
        config = reader.wifi_config()
        existing = config.get("meshConfigs") or {}
        node = existing.get(update["deviceId"])
        if not node:
            raise ValueError(f"no mesh node \"{update['deviceId']}\" found")
        mesh_configs = {
            **existing,
            update["deviceId"]: {**node, "auth": "MESH_AUTH_TRUSTED" if update["trusted"] else "MESH_AUTH_UNTRUSTED"},
        }
        return _wifi_config_request_for(target_id, {"meshConfigs": mesh_configs})

    raise ValueError("unhandled update kind")


# -- dish DishConfig writes (port of core/dishConfigUpdate.ts) ---------------

DISH_CONFIG_KEYS = {
    "snowMeltMode",
    "locationRequestMode",
    "levelDishMode",
    "powerSaveStartMinutes",
    "powerSaveDurationMinutes",
    "powerSaveMode",
    "swupdateRebootHour",
    "swupdateThreeDayDeferralEnabled",
}


def _dish_config_request_for(target_id: str, changes: dict) -> dict:
    if not target_id.startswith("ut"):
        raise ValueError("invalid dish target id")
    return {"targetId": target_id, "dishSetConfig": {"dishConfig": _with_apply_flags(changes)}}


def _prepare_dish_update(update: dict) -> dict:
    client = get_client()
    status = client.get_status()
    target_id = (status.get("deviceInfo") or {}).get("id")
    if not target_id:
        raise ValueError("Starlink dish identity is unavailable")
    kind = update["kind"]

    if kind == "config":
        return _dish_config_request_for(target_id, update["changes"])
    if kind == "stow":
        if not target_id.startswith("ut"):
            raise ValueError("invalid dish target id")
        return {"targetId": target_id, "dishStow": {"unstow": update["unstow"]}}
    if kind == "clearObstructionMap":
        if not target_id.startswith("ut"):
            raise ValueError("invalid dish target id")
        return {"targetId": target_id, "dishClearObstructionMap": {}}
    raise ValueError("unhandled update kind")


# -- router config writes over the cloud gateway (port of core/routerConfigUpdate.ts) --
# The router merges by apply flag, so naming one field changes that field and
# nothing else -- customDns and bypass are sent on their own, with no read
# beforehand. A subnet change is the exception: it travels inside the
# `networks` block, which carries the SSIDs and passphrases too, so the
# current block has to be read and handed back nearly intact.
#
# Unlike the WifiConfig kinds above (read via the local router), every read
# and write here rides the cloud gateway. That is what makes these usable on
# the setups that want them most: a kit in bypass mode has no reachable
# router on the local network at all, and its target comes from the account.

MAX_NAMESERVERS = 4
MIN_PASSPHRASE = 8
MAX_PASSPHRASE = 63
PASSPHRASE_AUTH_KEYS = ("authWpa2", "authWpa3", "authWpa2Wpa3")


def _is_ipv4(candidate: str) -> bool:
    octets = candidate.split(".")
    if len(octets) != 4:
        return False
    for octet in octets:
        if not octet.isdigit() or not (1 <= len(octet) <= 3):
            return False
        if len(octet) > 1 and octet.startswith("0"):
            return False
        if int(octet) > 255:
            return False
    return True


def _expand_ipv6(address: str) -> list[str] | None:
    bare = address.split("%")[0].strip().lower()
    if bare == "" or "." in bare:
        return None
    halves = bare.split("::")
    if len(halves) > 2:
        return None

    def groups_of(part: str) -> list[str]:
        return part.split(":") if part else []

    left = groups_of(halves[0])
    right = groups_of(halves[1]) if len(halves) == 2 else []
    full = [*left, *(["0"] * (8 - len(left) - len(right))), *right] if len(halves) == 2 else left
    if len(full) != 8 or not all(re.fullmatch(r"[0-9a-f]{1,4}", g) for g in full):
        return None
    return full


def normalize_ip_address(value: str) -> str | None:
    """An address as typed, reduced to the canonical form the write is built
    from, or None when it is not an address the router could forward to."""
    trimmed = value.strip()
    if not trimmed:
        return None
    unbracketed = (
        trimmed[1:-1].strip() if trimmed.startswith("[") and trimmed.endswith("]") else trimmed
    )
    if _is_ipv4(unbracketed):
        return unbracketed
    without_zone = unbracketed.split("%")[0]
    if _expand_ipv6(without_zone) is not None:
        return without_zone.lower()
    return None


def normalize_nameservers(nameservers: list[str]) -> list[str] | None:
    """The addresses as they will be sent, or None when any of them is not an
    address the router could forward to. Order is kept: the first is the
    primary."""
    if len(nameservers) > MAX_NAMESERVERS:
        return None
    normalized: list[str] = []
    for candidate in nameservers:
        address = normalize_ip_address(candidate)
        if not address:
            return None
        if address not in normalized:
            normalized.append(address)
    return normalized


def subnet_refusal(subnet: str, password: str) -> str | None:
    """Why a subnet change cannot be sent, or None when it can."""
    if subnet not in SUBNET_OPTIONS:
        return "unsupported subnet"
    if len(password) < MIN_PASSPHRASE or len(password) > MAX_PASSPHRASE:
        return f"Password must contain {MIN_PASSPHRASE} to {MAX_PASSPHRASE} characters"
    return None


def _build_subnet_networks(networks: list[dict], subnet: str, password: str) -> list[dict]:
    """The `networks` block to send for a subnet change, built from what the
    router currently reports. `bssid` and `ifaceName` are router-assigned:
    carrying them back makes the firmware discard the entire message without
    an error. The passphrase reads back masked, so every auth block holding
    one must be overwritten with the real value."""
    out: list[dict] = []
    for index, network in enumerate(networks):
        nn = dict(network)
        if index == 0:
            nn["ipv4"] = subnet
        new_bss = []
        for bss in network.get("basicServiceSets") or []:
            b = {k: v for k, v in bss.items() if k not in ("bssid", "ifaceName")}
            for key in PASSPHRASE_AUTH_KEYS:
                auth = b.get(key)
                if isinstance(auth, dict) and "password" in auth:
                    b[key] = {**auth, "password": password}
            new_bss.append(b)
        nn["basicServiceSets"] = new_bss
        out.append(nn)
    return out


def _router_config_request_json(target_id: str, update: dict, networks: list[dict]) -> dict:
    if not target_id.startswith("Router-"):
        raise ValueError("invalid router target id")
    kind = update["kind"]
    if kind == "subnet":
        refusal = subnet_refusal(update["subnet"], update["password"])
        if refusal:
            raise ValueError(refusal)
        if not networks:
            raise ValueError("router reported no networks to change")
        return {
            "targetId": target_id,
            "wifiSetConfig": {
                "wifiConfig": {
                    "networks": _build_subnet_networks(networks, update["subnet"], update["password"]),
                    "applyNetworks": True,
                }
            },
        }
    if kind == "bypass":
        return {
            "targetId": target_id,
            "wifiSetConfig": {"wifiConfig": {"bypassMode": update["enabled"], "applyBypassMode": True}},
        }
    # FactoryResetRequest carries no fields.
    if kind == "factoryReset":
        return {"targetId": target_id, "factoryReset": {}}
    nameservers = normalize_nameservers(update["nameservers"])
    if nameservers is None:
        raise ValueError("invalid DNS server address")
    return {
        "targetId": target_id,
        "wifiSetConfig": {"wifiConfig": {"nameservers": nameservers, "applyNameservers": True}},
    }


def _decode_response_dict(response_bytes: bytes) -> dict:
    response = get_client().new_response_message()
    response.ParseFromString(response_bytes)
    return json_format.MessageToDict(response, preserving_proto_field_name=False)


def read_router_wifi_config(target_id: str, call_gateway: Callable[[bytes], bytes]) -> dict | None:
    """The router's whole WiFi configuration, over the caller's gateway -- the
    same block the LAN serves, for a router the local network cannot reach."""
    reply = _decode_response_dict(call_gateway(_build_request_bytes({"targetId": target_id, "wifiGetConfig": {}})))
    return (reply.get("wifiGetConfig") or {}).get("wifiConfig")


def _read_router_networks(target_id: str, call_gateway: Callable[[bytes], bytes]) -> list[dict]:
    config = read_router_wifi_config(target_id, call_gateway)
    return (config or {}).get("networks") or []


def _read_current_networks(update: dict, target_id: str, call_gateway: Callable[[bytes], bytes]) -> list[dict]:
    """Only a subnet change needs the current networks, so every other update
    skips the round trip. Tried over the LAN first -- the router this process
    can reach is the controller `target_id` already names, since only the
    controller answers on the router's own LAN address -- and only over the
    account's gateway when that fails, which is the case that matters most:
    a subnet change is exactly the kind of write someone reaches for when the
    router is already hard to get to."""
    if update["kind"] != "subnet":
        return []
    try:
        return get_client().get_wifi_config().get("wifiConfig", {}).get("networks") or []
    except StarlinkError:
        return _read_router_networks(target_id, call_gateway)


def read_current_subnet(target_id: str, call_gateway: Callable[[bytes], bytes]) -> str | None:
    """The subnet the router is on, over the same gateway the writes use."""
    networks = _read_router_networks(target_id, call_gateway)
    if not networks:
        return None
    ipv4 = networks[0].get("ipv4")
    return ipv4 if isinstance(ipv4, str) else None


def read_router_clients(target_id: str, call_gateway: Callable[[bytes], bytes]) -> list[dict]:
    """The devices the router currently reports, over the caller's gateway
    instead of the LAN -- answers for a router the local network cannot see,
    and from a machine that is not on that network at all."""
    reply = _decode_response_dict(call_gateway(_build_request_bytes({"targetId": target_id, "wifiGetClients": {}})))
    return (reply.get("wifiGetClients") or {}).get("clients") or []


def _retries_when_missing(update: dict) -> bool:
    """Whether a refused write may simply be sent again. A subnet change
    carries a `networks` block read before the first try, so repeating it
    would write back a snapshot that is no longer current; the others name
    one field and nothing else, so sending the same value twice is the same
    as sending it once."""
    return update["kind"] in ("bypass", "customDns", "factoryReset")


def _send_router_config_update(update: dict) -> tuple[int, dict]:
    if not read_cookie():
        return NOT_CONNECTED
    try:
        with _mutation_lock:
            def run(cookie: str) -> None:
                target_id = _resolve_controller_id(cookie, cached=False)

                def call_gateway(request_bytes: bytes) -> bytes:
                    return _grpc_web_unary_call(DEVICE_HANDLE, request_bytes, cookie)

                networks = _read_current_networks(update, target_id, call_gateway)
                request_bytes = _build_request_bytes(_router_config_request_json(target_id, update, networks))
                try:
                    call_gateway(request_bytes)
                except GrpcWebCallError as failure:
                    if failure.status == 16:
                        raise SessionExpiredError()
                    raise DispatchFailure(failure)
                except (UpstreamError, TimeoutError) as failure:
                    raise DispatchFailure(failure)

            _with_fresh_cookie(run)
        return 200, {"ok": True}
    except SessionExpiredError:
        return NOT_CONNECTED
    except ControllerUnknownError:
        return NO_CONTROLLER
    except DispatchFailure as wrapped:
        reason = wrapped.reason
        # A subnet change and a bypass switch both reconfigure the LAN
        # carrying them, so a write that takes effect kills its own reply.
        # Neither is the far end refusing, and only the far end can refuse.
        severs_own_reply = update["kind"] in ("subnet", "bypass", "factoryReset")
        if severs_own_reply and not isinstance(reason, GrpcWebCallError):
            return 200, {"ok": True, "applied": True}
        if isinstance(reason, TimeoutError):
            return 504, {
                "error": "device_call_timeout",
                "message": "Starlink did not answer the router change in time. Try again.",
            }
        body: dict = {"error": "device_call_failed", "message": str(reason)}
        # The gateway had no session to the router. Nothing was applied and
        # nothing is wrong with the request, so asking again later is the
        # only thing that can succeed.
        if isinstance(reason, GrpcWebCallError) and reason.status == 5:
            body["deviceUnreachable"] = True
        return 502, body
    except TimeoutError:
        # A write that was never dispatched cannot be the router not answering.
        return 504, {
            "error": "prepare_call_timeout",
            "message": "Starlink didn't answer in time while preparing the change, so nothing was sent. Try again.",
        }
    except Exception as exc:  # noqa: BLE001 -- API boundary
        return 502, {"error": "device_call_failed", "message": str(exc)}


def _apply_router_config_update(update: dict) -> tuple[int, dict]:
    """A device the gateway says it cannot reach, tried once more from
    nothing. Resending the same bytes cannot help: the target id is already
    encoded in them, and a target learned during a flip can name a mesh node
    that is never connected. Only dropping what we learned and building the
    request again can change the answer."""
    status, body = _send_router_config_update(update)
    if not body.get("deviceUnreachable") or not _retries_when_missing(update):
        return status, body
    _forget_session()
    time.sleep(DEVICE_RETRY_DELAY_S)
    return _send_router_config_update(update)


def _valid_router_config(update: dict) -> bool:
    """The caller names a field and its new value, never protobuf. Anything
    outside these shapes is refused before the account is touched."""
    kind = update.get("kind")
    if kind == "subnet":
        subnet, password = update.get("subnet"), update.get("password")
        if not isinstance(subnet, str) or not isinstance(password, str):
            return False
        return subnet_refusal(subnet, password) is None
    if kind == "bypass":
        return isinstance(update.get("enabled"), bool)
    if kind == "factoryReset":
        return True
    if kind != "customDns":
        return False
    nameservers = update.get("nameservers")
    if not isinstance(nameservers, list) or not all(isinstance(n, str) for n in nameservers):
        return False
    return normalize_nameservers(nameservers) is not None


def update_router_config(update: dict) -> tuple[int, dict]:
    if not _valid_router_config(update):
        return 400, {"error": "bad_request"}
    return _apply_router_config_update(update)


# -- validation (port of validUpdate/validWifiConfigUpdate/validDishUpdate) --
# Same trust boundary as the TS handler: the caller names a device and a
# change, never protobuf. Anything outside these shapes is refused before the
# router/dish is ever read.

VALID_NETWORK_MODES = {"default", "guest", "auto"}
VALID_SECURITY_TYPES = {"wpa2", "wpa3", "wpa2wpa3", "open"}
VALID_TX_POWER_LEVELS = {
    "TX_POWER_LEVEL_100", "TX_POWER_LEVEL_80", "TX_POWER_LEVEL_50",
    "TX_POWER_LEVEL_25", "TX_POWER_LEVEL_12", "TX_POWER_LEVEL_6",
}
VALID_WIRELESS_MODES = {
    "WIRELESS_MODE_DEFAULT", "A_ONLY", "B_ONLY", "G_ONLY", "N_ONLY", "B_G_MIXED",
    "A_N_MIXED", "G_N_MIXED", "B_G_N_MIXED", "A_AN_AC_MIXED", "AN_AC_MIXED",
    "B_G_N_AX_MIXED", "A_AN_AC_AX_MIXED",
}
VALID_HT_BANDWIDTHS = {"HT_BANDWIDTH_DEFAULT", "HT_BANDWIDTH_20_MHZ", "HT_BANDWIDTH_20_OR_40_MHZ"}
VALID_VHT_BANDWIDTHS = {
    "VHT_BANDWIDTH_DEFAULT", "VHT_BANDWIDTH_DISABLED", "VHT_BANDWIDTH_80_MHZ",
    "VHT_BANDWIDTH_160_MHZ", "VHT_BANDWIDTH_80_PLUS_80_MHZ",
}
VALID_SNOW_MELT_MODES = {"AUTO", "ALWAYS_ON", "ALWAYS_OFF"}
VALID_LOCATION_MODES = {"NONE", "LOCAL"}
VALID_LEVEL_DISH_MODES = {"TILT_LIKE_NORMAL", "FORCE_LEVEL"}


def _is_int(value: Any) -> bool:
    """Number.isInteger()'s Python equivalent -- bool is an int subclass, so
    isinstance(True, int) is True and has to be excluded explicitly."""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_valid_channel(value: Any) -> bool:
    """Raw channel numbers aren't a declared enum in the schema -- just bound
    them to a range no real channel exceeds."""
    return value is None or (_is_int(value) and 0 <= value <= 200)


def _valid_string_list(value: Any, max_count: int, max_len: int) -> bool:
    return isinstance(value, list) and len(value) <= max_count and all(
        isinstance(v, str) and 0 < len(v) <= max_len for v in value
    )


def _valid_dns_static_entries(value: Any) -> bool:
    return isinstance(value, list) and len(value) <= 32 and all(
        isinstance(e, dict)
        and _valid_string_list(e.get("domains"), 16, 255)
        and _valid_string_list(e.get("addresses"), 16, 64)
        for e in value
    )


def _valid_dns_forward_rules(value: Any) -> bool:
    return isinstance(value, list) and len(value) <= 32 and all(
        isinstance(e, dict)
        and _valid_string_list(e.get("domains"), 16, 255)
        and _valid_string_list(e.get("serverAddresses"), 16, 64)
        for e in value
    )


def _valid_static_routes(value: Any) -> bool:
    return isinstance(value, list) and len(value) <= 32 and all(
        isinstance(r, dict)
        and isinstance(r.get("subnet"), str) and 0 < len(r["subnet"]) <= 64
        and isinstance(r.get("gateway"), str) and 0 < len(r["gateway"]) <= 64
        for r in value
    )


def _valid_client_update(update: dict) -> bool:
    kind = update.get("kind")
    if kind == "pause":
        cid = update.get("clientId")
        return _is_int(cid) and 0 <= cid <= 0xFFFFFFFF and isinstance(update.get("paused"), bool)
    if kind == "rename":
        cid = update.get("clientId")
        name = update.get("givenName")
        return (
            _is_int(cid) and 0 <= cid <= 0xFFFFFFFF
            and isinstance(name, str) and len(name.strip()) > 0 and len(name) <= 64
        )
    return False


def _valid_wifi_config_update(update: dict) -> bool:
    kind = update.get("kind")
    if kind == "dns":
        ns = update.get("nameservers")
        return (
            isinstance(ns, list) and len(ns) <= 8
            and all(isinstance(n, str) and len(n) <= 64 for n in ns)
            and isinstance(update.get("disabled"), bool)
        )
    if kind == "bypassMode":
        return isinstance(update.get("enabled"), bool)
    if kind == "contentFiltering":
        level = update.get("level")
        allow = update.get("allowDomains")
        return level in (0, 1, 2) and (allow is None or _valid_string_list(allow, 64, 255))
    if kind == "ssid":
        domain, band, ssid = update.get("networkDomain"), update.get("band"), update.get("ssid")
        password, security = update.get("password"), update.get("security")
        password_ok = (
            isinstance(password, str) if security == "open" else isinstance(password, str) and len(password) > 0
        )
        return (
            isinstance(domain, str) and len(domain) > 0
            and isinstance(band, str) and len(band) > 0
            and isinstance(ssid, str) and 0 < len(ssid) <= 32
            and password_ok
            and (update.get("hidden") is None or isinstance(update.get("hidden"), bool))
            and (update.get("disable") is None or isinstance(update.get("disable"), bool))
            and (security is None or security in VALID_SECURITY_TYPES)
        )
    if kind == "networkSettings":
        domain = update.get("networkDomain")
        start, end, lease = update.get("dhcpv4Start"), update.get("dhcpv4End"), update.get("dhcpv4LeaseDurationS")
        return (
            isinstance(domain, str) and len(domain) > 0
            and (update.get("mode") is None or update.get("mode") in VALID_NETWORK_MODES)
            and (update.get("ipv4") is None or update.get("ipv4") in SUBNET_OPTIONS)
            and (start is None or (_is_int(start) and 2 <= start <= 254))
            and (end is None or (_is_int(end) and 2 <= end <= 254))
            and (lease is None or (_is_int(lease) and 0 < lease <= 30 * 86400))
            and (update.get("dhcpDisabled") is None or isinstance(update.get("dhcpDisabled"), bool))
            and (update.get("dnsDisabled") is None or isinstance(update.get("dnsDisabled"), bool))
            and (update.get("dnsStaticEntries") is None or _valid_dns_static_entries(update.get("dnsStaticEntries")))
            and (update.get("dnsForwardRules") is None or _valid_dns_forward_rules(update.get("dnsForwardRules")))
            and (update.get("staticRoutes") is None or _valid_static_routes(update.get("staticRoutes")))
        )
    if kind == "addNetwork":
        ssid, password = update.get("ssid"), update.get("password")
        return (
            isinstance(ssid, str) and 0 < len(ssid) <= 32
            and isinstance(password, str) and len(password) > 0
            and update.get("ipv4") in SUBNET_OPTIONS
            and update.get("mode") in VALID_NETWORK_MODES
            and (update.get("hidden") is None or isinstance(update.get("hidden"), bool))
        )
    if kind == "deleteNetwork":
        domain = update.get("networkDomain")
        return isinstance(domain, str) and len(domain) > 0
    if kind == "routerAdvanced":
        bool_fields = (
            "disableSandboxFailOpen", "disable2ghz", "disable5ghz", "disable5ghzHigh",
            "disableBandSteering", "disableMeshOnboarding",
        )
        bool_ok = all(update.get(f) is None or isinstance(update.get(f), bool) for f in bool_fields)
        return (
            bool_ok
            and all(update.get(f) is None or update.get(f) in VALID_TX_POWER_LEVELS
                    for f in ("txPowerLevel2ghz", "txPowerLevel5ghz", "txPowerLevel5ghzHigh"))
            and _is_valid_channel(update.get("channel2ghz"))
            and _is_valid_channel(update.get("channel5ghz"))
            and _is_valid_channel(update.get("channel5ghzHigh"))
            and all(update.get(f) is None or update.get(f) in VALID_WIRELESS_MODES
                    for f in ("wirelessMode2ghz", "wirelessMode5ghz", "wirelessMode5ghzHigh"))
            and all(update.get(f) is None or update.get(f) in VALID_HT_BANDWIDTHS
                    for f in ("htBandwidth2ghz", "htBandwidth5ghz", "htBandwidth5ghzHigh"))
            and all(update.get(f) is None or update.get(f) in VALID_VHT_BANDWIDTHS
                    for f in ("vhtBandwidth", "vhtBandwidth5ghzHigh"))
        )
    if kind == "meshTrust":
        device_id = update.get("deviceId")
        return isinstance(device_id, str) and len(device_id) > 0 and isinstance(update.get("trusted"), bool)
    return False


def _valid_dish_config_changes(changes: Any) -> bool:
    if not isinstance(changes, dict):
        return False
    if not all(k in DISH_CONFIG_KEYS for k in changes):
        return False
    start, dur, hour = (
        changes.get("powerSaveStartMinutes"), changes.get("powerSaveDurationMinutes"), changes.get("swupdateRebootHour"),
    )
    return (
        (changes.get("snowMeltMode") is None or changes.get("snowMeltMode") in VALID_SNOW_MELT_MODES)
        and (changes.get("locationRequestMode") is None or changes.get("locationRequestMode") in VALID_LOCATION_MODES)
        and (changes.get("levelDishMode") is None or changes.get("levelDishMode") in VALID_LEVEL_DISH_MODES)
        and (start is None or (_is_int(start) and 0 <= start < 1440))
        and (dur is None or (_is_int(dur) and 0 < dur <= 1440))
        and (changes.get("powerSaveMode") is None or isinstance(changes.get("powerSaveMode"), bool))
        and (hour is None or (_is_int(hour) and 0 <= hour < 24))
        and (changes.get("swupdateThreeDayDeferralEnabled") is None or isinstance(changes.get("swupdateThreeDayDeferralEnabled"), bool))
    )


def _valid_dish_update(update: dict) -> bool:
    kind = update.get("kind")
    if kind == "config":
        changes = update.get("changes")
        return isinstance(changes, dict) and _valid_dish_config_changes(changes) and len(changes) > 0
    if kind == "stow":
        return isinstance(update.get("unstow"), bool)
    if kind == "clearObstructionMap":
        return True
    return False


# -- public dispatch, called from server.py's /cloud/* routes ----------------

def update_client(update: dict) -> tuple[int, dict]:
    if not _valid_client_update(update):
        return 400, {"error": "bad_request"}
    return _apply_device_update(_prepare_client_update, update, "device")


def update_wifi_config(update: dict) -> tuple[int, dict]:
    if not _valid_wifi_config_update(update):
        return 400, {"error": "bad_request"}
    return _apply_device_update(_prepare_wifi_config_update, update, "WiFi config")


def update_dish_config(update: dict) -> tuple[int, dict]:
    if not _valid_dish_update(update):
        return 400, {"error": "bad_request"}
    return _apply_device_update(_prepare_dish_update, update, "dish")
