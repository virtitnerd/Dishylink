"""
Reusable client for the Starlink dish's local gRPC API (SpaceX.API.Device.Device).

The dish (192.168.100.1:9200) exposes gRPC server reflection, so the full
protobuf schema is pulled live from the dish itself on first use -- no
vendored .proto files, no third-party dependency on community proto forks.
This keeps the client correct even as SpaceX changes the schema across
firmware updates.
"""
from __future__ import annotations

import threading
import urllib.error
import urllib.request
from typing import Any

import grpc
from google.protobuf import descriptor_pb2, descriptor_pool, json_format, message_factory
from grpc_reflection.v1alpha import reflection_pb2, reflection_pb2_grpc

DISH_HOST = "192.168.100.1"
DISH_PORT = 9200
DEVICE_SERVICE_SYMBOL = "SpaceX.API.Device.Device"

# The Starlink router runs the *same* SpaceX.API.Device.Device service (identical
# schema) on its own box, but only reachable over gRPC-Web/HTTP1.1 -- port 9001 on
# its default gateway address rejects raw HTTP/2 gRPC outright. This is how
# wifi_get_clients and friends work at all: they're UNIMPLEMENTED on the dish's
# own port 9200 because the dish process genuinely doesn't serve them -- the
# router process does. Reuses the dish's schema (proven identical) instead of
# fetching it again, since gRPC reflection isn't available on this port.
ROUTER_HOST = "192.168.1.1"
ROUTER_PORT = 9001
ROUTER_HANDLE_URL = f"http://{ROUTER_HOST}:{ROUTER_PORT}/{DEVICE_SERVICE_SYMBOL}/Handle"


class StarlinkError(RuntimeError):
    """Raised when the dish is unreachable or returns a gRPC error."""


class StarlinkClient:
    """Thread-safe client. Schema is fetched once and cached for the process lifetime."""

    def __init__(self, host: str = DISH_HOST, port: int = DISH_PORT, timeout: float = 8.0):
        self._target = f"{host}:{port}"
        self._timeout = timeout
        self._lock = threading.Lock()
        self._channel: grpc.Channel | None = None
        self._pool: descriptor_pool.DescriptorPool | None = None
        self._request_cls = None
        self._response_cls = None
        self._handle_call = None

    # -- schema / connection setup -------------------------------------------------

    def _ensure_ready(self) -> None:
        if self._handle_call is not None:
            return
        with self._lock:
            if self._handle_call is not None:
                return
            channel = grpc.insecure_channel(self._target)
            pool = self._fetch_schema(channel)
            request_cls = self._message_class(pool, "SpaceX.API.Device.Request")
            response_cls = self._message_class(pool, "SpaceX.API.Device.Response")
            self._channel = channel
            self._pool = pool
            self._request_cls = request_cls
            self._response_cls = response_cls
            self._handle_call = channel.unary_unary(
                f"/{DEVICE_SERVICE_SYMBOL}/Handle",
                request_serializer=request_cls.SerializeToString,
                response_deserializer=response_cls.FromString,
            )

    def _fetch_schema(self, channel: grpc.Channel) -> descriptor_pool.DescriptorPool:
        stub = reflection_pb2_grpc.ServerReflectionStub(channel)

        def reflect(**kwargs):
            req = reflection_pb2.ServerReflectionRequest(**kwargs)
            try:
                return list(stub.ServerReflectionInfo(iter([req]), timeout=self._timeout))[0]
            except grpc.RpcError as exc:
                raise StarlinkError(f"reflection request failed: {exc}") from exc

        pool = descriptor_pool.DescriptorPool()
        fdps: dict[str, descriptor_pb2.FileDescriptorProto] = {}

        def collect(raw: bytes) -> None:
            fdp = descriptor_pb2.FileDescriptorProto()
            fdp.ParseFromString(raw)
            if fdp.name in fdps:
                return
            fdps[fdp.name] = fdp
            for dep in fdp.dependency:
                if dep not in fdps:
                    resp = reflect(file_by_filename=dep)
                    for raw_dep in resp.file_descriptor_response.file_descriptor_proto:
                        collect(raw_dep)

        top = reflect(file_containing_symbol=DEVICE_SERVICE_SYMBOL)
        for raw in top.file_descriptor_response.file_descriptor_proto:
            collect(raw)

        added: set[str] = set()
        progress = True
        while progress:
            progress = False
            for name, fdp in fdps.items():
                if name in added:
                    continue
                try:
                    pool.Add(fdp)
                    added.add(name)
                    progress = True
                except TypeError:
                    pass  # dependency not added yet; retry next pass
        if len(added) != len(fdps):
            raise StarlinkError("could not resolve full proto dependency graph from dish reflection")
        return pool

    @staticmethod
    def _message_class(pool: descriptor_pool.DescriptorPool, full_name: str):
        return message_factory.GetMessageClass(pool.FindMessageTypeByName(full_name))

    def _message_class_cached(self, full_name: str):
        assert self._pool is not None
        return self._message_class(self._pool, full_name)

    def new_request_message(self):
        """An empty Request message, ready for json_format.ParseDict -- what
        starlink_cloud.py builds cloud (Device.Handle) writes from. Device.Request
        is the same schema whether the call goes to the dish, the router, or
        Starlink's cloud gateway, so this reuses whatever schema this client
        already pulled via reflection rather than fetching it twice."""
        self._ensure_ready()
        return self._request_cls()

    # -- RPC plumbing ----------------------------------------------------------

    def _handle(self, request_field: str, request_type: str | None = None, **kwargs) -> Any:
        self._ensure_ready()
        req = self._request_cls()
        sub = getattr(req, request_field)
        if request_type:
            sub.CopyFrom(self._message_class_cached(request_type)(**kwargs))
        try:
            resp = self._handle_call(req, timeout=self._timeout)
        except grpc.RpcError as exc:
            raise StarlinkError(f"{request_field} failed: {exc.details() if hasattr(exc, 'details') else exc}") from exc
        which = resp.WhichOneof("response")
        if which is None:
            raise StarlinkError(f"{request_field}: empty response")
        return getattr(resp, which)

    def _handle_router(self, request_field: str, request_type: str | None = None, **kwargs) -> Any:
        """Same Request/Response schema as _handle, but framed as gRPC-Web over
        plain HTTP and posted to the router's own box instead of the dish's."""
        self._ensure_ready()  # only used to populate _request_cls/_response_cls from the dish's schema
        req = self._request_cls()
        sub = getattr(req, request_field)
        if request_type:
            sub.CopyFrom(self._message_class_cached(request_type)(**kwargs))
        payload = req.SerializeToString()
        frame = b"\x00" + len(payload).to_bytes(4, "big") + payload
        http_req = urllib.request.Request(
            ROUTER_HANDLE_URL,
            data=frame,
            headers={"Content-Type": "application/grpc-web+proto", "X-Grpc-Web": "1"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(http_req, timeout=self._timeout) as resp:
                grpc_status = resp.headers.get("grpc-status")
                if grpc_status not in (None, "0"):
                    raise StarlinkError(f"{request_field} failed: {resp.headers.get('grpc-message', 'router error')}")
                body = resp.read()
        except urllib.error.URLError as exc:
            raise StarlinkError(f"router unreachable: {exc}") from exc
        if len(body) < 5:
            raise StarlinkError(f"{request_field}: empty response from router")
        length = int.from_bytes(body[1:5], "big")
        resp_msg = self._response_cls()
        resp_msg.ParseFromString(body[5 : 5 + length])
        which = resp_msg.WhichOneof("response")
        if which is None:
            raise StarlinkError(f"{request_field}: empty response from router")
        return getattr(resp_msg, which)

    @staticmethod
    def _to_dict(msg) -> dict:
        return json_format.MessageToDict(
            msg,
            always_print_fields_with_no_presence=True,
            preserving_proto_field_name=False,
        )

    # -- public read-only API ---------------------------------------------------

    def get_status(self) -> dict:
        return self._to_dict(self._handle("get_status", "SpaceX.API.Device.GetStatusRequest"))

    def get_diagnostics(self) -> dict:
        return self._to_dict(self._handle("get_diagnostics", "SpaceX.API.Device.GetDiagnosticsRequest"))

    def get_device_info(self) -> dict:
        return self._to_dict(self._handle("get_device_info", "SpaceX.API.Device.GetDeviceInfoRequest"))

    # -- router read-only API (192.168.1.1:9001, separate process from the dish) --

    def get_wifi_clients(self) -> dict:
        return self._to_dict(self._handle_router("wifi_get_clients", "SpaceX.API.Device.WifiGetClientsRequest"))

    def get_router_status(self) -> dict:
        """Same get_status oneof field as the dish, but answered by the router process."""
        return self._to_dict(self._handle_router("get_status", "SpaceX.API.Device.GetStatusRequest"))

    def get_router_diagnostics(self) -> dict:
        return self._to_dict(self._handle_router("get_diagnostics", "SpaceX.API.Device.GetDiagnosticsRequest"))

    def get_wifi_config(self) -> dict:
        return self._to_dict(self._handle_router("wifi_get_config", "SpaceX.API.Device.WifiGetConfigRequest"))

    def get_wifi_guest_info(self) -> dict:
        return self._to_dict(self._handle_router("wifi_guest_info", "SpaceX.API.Device.WifiGuestInfoRequest"))

    def get_history(self) -> dict:
        return self._to_dict(self._handle("get_history", "SpaceX.API.Device.GetHistoryRequest"))

    def get_context(self) -> dict:
        return self._to_dict(self._handle("dish_get_context", "SpaceX.API.Device.DishGetContextRequest"))

    def get_obstruction_map(self) -> dict:
        return self._to_dict(self._handle("dish_get_obstruction_map", "SpaceX.API.Device.DishGetObstructionMapRequest"))

    def get_dish_config(self) -> dict:
        """Overlaps with get_status()['config'] -- kept for API-coverage completeness, not surfaced in the UI."""
        return self._to_dict(self._handle("dish_get_config", "SpaceX.API.Device.DishGetConfigRequest"))

    def get_location(self) -> dict:
        """Dish GPS position -- typically PERMISSION_DENIED on consumer plans since mid-2026 firmware."""
        return self._to_dict(self._handle("get_location", "SpaceX.API.Device.GetLocationRequest"))

    def get_router_radio_stats(self) -> dict:
        """Per-radio WiFi stats (temps, rates) -- router only; the dish answers Unimplemented."""
        return self._to_dict(self._handle_router("get_radio_stats", "SpaceX.API.Device.GetRadioStatsRequest"))

    def stow(self, unstow: bool = False) -> dict:
        """Stow (fold flat) or unstow the dish -- motorized (mast) models only; a no-op RPC on electronically-steered kits."""
        return self._to_dict(self._handle("dish_stow", "SpaceX.API.Device.DishStowRequest", unstow=unstow))

    def set_dish_config(self, changes: dict) -> dict:
        """Generic partial DishConfig write: any subset of camelCase DishConfig field
        names, each paired automatically with its apply_<field>=True flag -- mirrors
        dishylink's own flexible setConfig() rather than a fixed set of knobs."""
        def camel_to_snake(name: str) -> str:
            return "".join(f"_{c.lower()}" if c.isupper() else c for c in name)

        kwargs: dict[str, Any] = {}
        for camel_field, value in changes.items():
            snake_field = camel_to_snake(camel_field)
            kwargs[snake_field] = value
            kwargs[f"apply_{snake_field}"] = True
        cfg = self._message_class_cached("SpaceX.API.Device.DishConfig")(**kwargs)
        return self._to_dict(self._handle("dish_set_config", "SpaceX.API.Device.DishSetConfigRequest", dish_config=cfg))

    # -- write / action RPCs -----------------------------------------------

    def reboot(self) -> dict:
        """Reboots the dish. Causes a brief (~1 min) outage."""
        return self._to_dict(self._handle("reboot", "SpaceX.API.Device.RebootRequest"))

    def start_speedtest(self, duration_s: int = 18) -> dict:
        return self._to_dict(
            self._handle("start_speedtest", "SpaceX.API.Device.StartSpeedtestRequest", duration_s=duration_s, send_telemetry=False)
        )

    def get_speedtest_status(self) -> dict:
        return self._to_dict(self._handle("get_speedtest_status", "SpaceX.API.Device.GetSpeedtestStatusRequest"))

    # -- dish settings -----------------------------------------------------
    # DishConfig fields are a field mask: only the value + matching apply_X flag
    # you set are touched, everything else on the dish is left alone. Safe to
    # send sparse -- no read-modify-write needed here.

    def set_snow_melt_mode(self, mode: str) -> dict:
        """mode: AUTO | ALWAYS_ON | ALWAYS_OFF"""
        cfg = self._message_class_cached("SpaceX.API.Device.DishConfig")(snow_melt_mode=mode, apply_snow_melt_mode=True)
        return self._to_dict(self._handle("dish_set_config", "SpaceX.API.Device.DishSetConfigRequest", dish_config=cfg))

    def set_sleep_schedule(self, enabled: bool, start_minutes: int | None = None, duration_minutes: int | None = None) -> dict:
        """Powers the dish down for `duration_minutes` starting at `start_minutes` past midnight, local time."""
        kwargs: dict[str, Any] = {"power_save_mode": enabled, "apply_power_save_mode": True}
        if start_minutes is not None:
            kwargs.update(power_save_start_minutes=start_minutes, apply_power_save_start_minutes=True)
        if duration_minutes is not None:
            kwargs.update(power_save_duration_minutes=duration_minutes, apply_power_save_duration_minutes=True)
        cfg = self._message_class_cached("SpaceX.API.Device.DishConfig")(**kwargs)
        return self._to_dict(self._handle("dish_set_config", "SpaceX.API.Device.DishSetConfigRequest", dish_config=cfg))

    def set_software_update_window(self, reboot_hour: int | None = None, defer_three_days: bool | None = None) -> dict:
        kwargs: dict[str, Any] = {}
        if reboot_hour is not None:
            kwargs.update(swupdate_reboot_hour=reboot_hour, apply_swupdate_reboot_hour=True)
        if defer_three_days is not None:
            kwargs.update(swupdate_three_day_deferral_enabled=defer_three_days, apply_swupdate_three_day_deferral_enabled=True)
        cfg = self._message_class_cached("SpaceX.API.Device.DishConfig")(**kwargs)
        return self._to_dict(self._handle("dish_set_config", "SpaceX.API.Device.DishSetConfigRequest", dish_config=cfg))

    def set_location_request_mode(self, mode: str) -> dict:
        """mode: NONE | LOCAL. Note: on this dish LOCAL is already set and get_location
        is still blocked, so this alone is unlikely to unlock GPS -- see project notes."""
        cfg = self._message_class_cached("SpaceX.API.Device.DishConfig")(location_request_mode=mode, apply_location_request_mode=True)
        return self._to_dict(self._handle("dish_set_config", "SpaceX.API.Device.DishSetConfigRequest", dish_config=cfg))

    def clear_obstruction_map(self) -> dict:
        """Wipes the dish's learned obstruction map so it starts re-scanning from empty."""
        return self._to_dict(self._handle("dish_clear_obstruction_map", "SpaceX.API.Device.DishClearObstructionMapRequest"))

    # -- router settings (192.168.1.1:9001) ---------------------------------

    def reboot_router(self) -> dict:
        """Reboots the router (not the dish). Causes a brief WiFi outage; the dish itself keeps running."""
        return self._to_dict(self._handle_router("reboot", "SpaceX.API.Device.RebootRequest"))

    def set_client_given_name(self, mac_address: str, given_name: str) -> dict:
        client_name = self._message_class_cached("SpaceX.API.Device.ClientName")(mac_address=mac_address, given_name=given_name)
        return self._to_dict(
            self._handle_router("wifi_set_client_given_name", "SpaceX.API.Device.WifiSetClientGivenNameRequest", client_name=client_name)
        )

    def set_mesh_device_trust(self, device_id: str, trusted: bool) -> dict:
        auth = "MESH_AUTH_TRUSTED" if trusted else "MESH_AUTH_UNTRUSTED"
        return self._to_dict(
            self._handle_router("wifi_set_mesh_device_trust", "SpaceX.API.Device.WifiSetMeshDeviceTrustRequest", device_id=device_id, auth=auth)
        )

    def _read_current_wifi_config(self):
        """Raw WifiConfig protobuf (not dict) for read-modify-write callers -- editing a
        repeated field like `networks` sparsely would replace the whole list on write,
        wiping every other network/band, so those writers need the full current state."""
        resp = self._handle_router("wifi_get_config", "SpaceX.API.Device.WifiGetConfigRequest")
        return resp.wifi_config

    def _write_wifi_config(self, wifi_config, apply_fields: list[str]) -> dict:
        for field in apply_fields:
            setattr(wifi_config, field, True)
        return self._to_dict(self._handle_router("wifi_set_config", "SpaceX.API.Device.WifiSetConfigRequest", wifi_config=wifi_config))

    def _band_enum_value(self, bss, band: str) -> int:
        """bss.band reads back as the enum's int value (protobuf doesn't
        auto-convert on comparison, only on assignment), so comparing it
        directly against a string name like "RF_2GHZ" never matches -- resolve
        the name to its int via the field's own enum descriptor first."""
        enum_type = bss.DESCRIPTOR.fields_by_name["band"].enum_type
        try:
            return enum_type.values_by_name[band].number
        except KeyError:
            valid = ", ".join(enum_type.values_by_name)
            raise StarlinkError(f"unknown band {band!r} -- expected one of: {valid}") from None

    def set_wifi_ssid(self, band: str, ssid: str, password: str, hidden: bool | None = None) -> dict:
        """band: RF_2GHZ | RF_5GHZ | RF_5GHZ_HIGH.

        `password` is REQUIRED, not optional, on every call -- the router masks
        passwords on read (returns literal "•••••"), and this is a read-modify-write
        against that same read. A call that only wanted to rename the SSID and left
        the existing (masked) password field untouched would write the literal
        string "•••••" as the new WiFi password, which -- unless the device happens
        to special-case that exact placeholder as "unchanged" (unconfirmed, and not
        worth gambling a network lockout on) -- locks every device off the network
        until a physical reset. Always resupplying the real password from the
        caller removes the ambiguity entirely.
        """
        cfg = self._read_current_wifi_config()
        matched = False
        for network in cfg.networks:
            for bss in network.basic_service_sets:
                if bss.band != self._band_enum_value(bss, band):
                    continue
                matched = True
                bss.ssid = ssid
                bss.auth_wpa2.password = password
                if hidden is not None:
                    bss.hidden = hidden
        if not matched:
            raise StarlinkError(f"no configured network found for band {band}")
        return self._write_wifi_config(cfg, ["apply_networks"])

    def set_bypass_mode(self, enabled: bool) -> dict:
        """Disables the router's own WiFi in favor of a third-party router on its ethernet
        port. Confirmed risky -- see the caution in this project's write-up before flipping."""
        cfg = self._message_class_cached("SpaceX.API.Device.WifiConfig")(bypass_mode=enabled, apply_bypass_mode=True)
        return self._to_dict(self._handle_router("wifi_set_config", "SpaceX.API.Device.WifiSetConfigRequest", wifi_config=cfg))

    def set_custom_dns(self, nameservers: list[str] | None = None, disabled: bool | None = None) -> dict:
        """nameservers is a repeated string field on the wire (confirmed live against
        the schema) -- passing a comma-joined string instead would silently populate
        it one character at a time, since Python strings are themselves iterable."""
        kwargs: dict[str, Any] = {}
        if nameservers is not None:
            kwargs.update(nameservers=list(nameservers), apply_nameservers=True)
        if disabled is not None:
            # custom_dns_disabled, not secure_dns (a separate DNS-over-HTTPS/TLS
            # knob) -- confirmed by name against the live schema.
            kwargs.update(custom_dns_disabled=disabled, apply_custom_dns_disabled=True)
        cfg = self._message_class_cached("SpaceX.API.Device.WifiConfig")(**kwargs)
        return self._to_dict(self._handle_router("wifi_set_config", "SpaceX.API.Device.WifiSetConfigRequest", wifi_config=cfg))

    def set_content_filtering(self, band: str, sandbox_enabled: bool, allow_domains: list[str] | None = None) -> dict:
        """Closest match in this schema to "content filtering": per-network sandboxing
        with a domain allow-list. Read-modify-write for the same reason as set_wifi_ssid."""
        cfg = self._read_current_wifi_config()
        matched = False
        for network in cfg.networks:
            for bss in network.basic_service_sets:
                if bss.band != self._band_enum_value(bss, band):
                    continue
                matched = True
                network.sandbox_enabled = sandbox_enabled
                if allow_domains is not None:
                    del network.sandbox_domain_allow_list[:]
                    network.sandbox_domain_allow_list.extend(allow_domains)
        if not matched:
            raise StarlinkError(f"no configured network found for band {band}")
        return self._write_wifi_config(cfg, ["apply_networks"])


_client_singleton: StarlinkClient | None = None
_singleton_lock = threading.Lock()


def get_client() -> StarlinkClient:
    global _client_singleton
    if _client_singleton is None:
        with _singleton_lock:
            if _client_singleton is None:
                _client_singleton = StarlinkClient()
    return _client_singleton
