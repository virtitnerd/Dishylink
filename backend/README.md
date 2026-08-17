# Python backend

A self-contained FastAPI server that polls the dish and router itself, records
its own local history, and serves the built frontend — `/api/*` (data),
`/cloud/*` (Starlink account session, reads, and every device write),
`/celestrak/*` (TLE proxy for the sky view), and the static `dist/`, all from
one process on one port. This is what makes the packaged Docker image
single-port, and it's also what the web dev harness (`npm run dev`) proxies
`/api/*` to — see `vite.config.ts`.

It is a separate implementation from `core/dishClient.ts` and
`collector/historian.mts`, not a wrapper around them: Electron and the browser
extension poll the dish directly over grpc-web from the app itself and keep
their own history (`collector/` for desktop via launchd, IndexedDB for the
extension). This backend exists for headless/server deployment — a NAS, a
homelab box, a Docker container — where nothing Electron- or extension-shaped
is running at all. See the root [README.md](../README.md#four-ways-to-run-it)
for how the four deployment shapes relate.

## Run it

```bash
python3 -m pip install -r requirements.txt
python3 server.py            # http://127.0.0.1:8787
```

Or via the background-service scripts (writes `server.pid`/`server.log`):

```bash
./start.sh
./stop.sh
```

Or the Docker image (see the root [Dockerfile](../Dockerfile)):

```bash
docker build -t dishylink .
docker run -p 8787:8787 -v dishylink-data:/app/backend/history -v dishylink-cache:/app/backend/cache dishylink
```

Restart after editing any file here — unlike the frontend, nothing hot-reloads
`server.py` or its imports.

## Configuration

All environment variables, all optional:

| Variable                      | Default         | Meaning                                                                                                   |
| ----------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `STARLINK_HOST`               | `127.0.0.1`     | Interface `uvicorn` binds. The Docker image sets `0.0.0.0` so the container's port mapping can reach it.  |
| `STARLINK_PORT`               | `8787`          | Port `uvicorn` binds.                                                                                     |
| `STARLINK_DISH_HOST`          | `192.168.100.1` | Dish gRPC address. Only needed if the container isn't on the dish's own subnet.                           |
| `STARLINK_ROUTER_HOST`        | `192.168.1.1`   | Router gRPC-web address, same caveat.                                                                     |
| `STARLINK_HISTORY_DIR`        | `history`       | Where the JSONL historian writes.                                                                         |
| `STARLINK_HISTORY_INTERVAL_S` | `10`            | Poll interval for the historian's own sample loop (separate from the live `/ws/live` feed's faster poll). |
| `STARLINK_CACHE_DIR`          | `cache`         | The Starlink account session cookie, TLE data, and the CelesTrak proxy cache all live under here.         |

## Files

- `server.py` — the FastAPI app and every route.
- `starlink_client.py` — the dish/router gRPC client: reflection-based schema
  fetch, request/response message helpers, all the LAN reads and the (blocked,
  see [LOCAL-API.md](../LOCAL-API.md)) LAN writes.
- `starlink_cloud.py` — Starlink account session handling and every
  authenticated cloud write (client pause/rename, WifiConfig, dish config,
  stow, obstruction map clear), a structural port of
  `cloud/starlinkCloudHandler.ts` for a single-process host. See its own
  module docstring for the bssid/auth-field write rule — the single most
  important thing to know before touching a `WifiConfig` write here.
- `historian.py` — the append-only JSONL sample recorder (one file per UTC
  day), independent of `collector/`'s TS historian.
- `client_totals.py`, `usage_energy.py`, `obstruction_snapshots.py` — derived
  views over the historian's raw samples: per-device data usage, energy
  bucketing, and obstruction-map time-lapse snapshots.
- `webhook.py` — outbound alert notifications (`/api/notify-webhook`,
  `/api/settings/webhook`).

## API surface

`/api/*` mirrors what the frontend's other hosts get from `core/dishClient.ts`
directly — status, history, usage, energy, alerts, thermal/outage logs,
per-device totals, router config and radio stats, `/api/whoami` (for the
client-pause self-identity check), plus `/metrics` in real Prometheus
exposition format and `/ws/live` for the live-updating dashboard. `/cloud/*`
covers account connect/disconnect and every write listed above. Route-by-route
detail is in the docstrings and comments in `server.py` itself — there's no
separate spec to keep in sync with it.
