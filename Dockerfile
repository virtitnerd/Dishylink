# Starlink dashboard -- dishylink's UI, our FastAPI backend underneath.
#
# Stage 1 builds the static React/Three.js frontend (Vite). Stage 2 is just
# Python + that build output: server.py serves /api/*, /cloud/* (the user's
# Starlink account session, reads, and every device write -- see
# backend/starlink_cloud.py), and the built dist/, all from one process on
# one port. Nothing in the container needs to know about cross-origin
# requests at all -- that's purely a dev-mode concern (see vite.config.ts's
# /api proxy and dev/starlinkCloudProxy.ts), not a packaged one.

FROM node:22-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM python:3.12-slim AS runtime
WORKDIR /app/backend

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY --from=frontend /app/dist /app/dist

# Not the dish's LAN -- the container's own network. STARLINK_DISH_HOST /
# STARLINK_ROUTER_HOST (read by starlink_client.py) point this at the real
# hardware; override at `docker run` time if they're not the defaults
# (192.168.100.1 / 192.168.1.1).
ENV STARLINK_HOST=0.0.0.0
ENV STARLINK_PORT=8787
# history/ (the JSONL historian) and cache/ (TLE data) -- mount a volume here
# to persist them across container recreations; the app works fine without
# one, it just starts each history/cache fresh.
VOLUME ["/app/backend/history", "/app/backend/cache"]

EXPOSE 8787
CMD ["python", "server.py"]
