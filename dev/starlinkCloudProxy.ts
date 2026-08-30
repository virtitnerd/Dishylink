// Dev-only binding for the cloud account feature.
//
// The browser cannot call starlink.com directly (CORS: ACAO is starlink.com-only;
// the session cookies are HttpOnly/SameSite so JS can't attach them). In the
// shipping products this transport lives in Electron main / the extension's
// background worker; in dev it lives here, as a Vite middleware. The request logic
// is the host-agnostic createCloudHandler; this file only wires it to a file cookie
// store and exposes the /cloud/* routes the UI reads.

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createCloudHandler } from "../cloud/starlinkCloudHandler.ts";
import { resilientFetch } from "../cloud/resilientFetch.ts";
import { DishClient, ROUTER_LAN_HANDLE_URL, setApiBase } from "../core/dishClient.ts";
import {
  buildRouterConfigRequest,
  readRouterConfigContext,
  readCurrentSubnet,
  readRouterWifiConfig,
  type RouterConfigUpdate,
} from "../core/routerConfigUpdate.ts";
import { prepareRouterClientUpdate, readRouterClients } from "../core/routerClientUpdate.ts";
import type { RouterClientUpdate } from "../core/routerClientUpdate.ts";
import { prepareRouterWifiConfigUpdate } from "../core/routerWifiConfigUpdate.ts";
import type { RouterWifiConfigUpdate } from "../core/routerWifiConfigUpdate.ts";
import { prepareDishUpdate } from "../core/dishConfigUpdate.ts";
import type { DishUpdate } from "../core/dishConfigUpdate.ts";
import { localNetworkIdentity } from "../core/hostNetworkIdentity.ts";

const COOKIE_FILE = resolve(process.cwd(), ".starlink-cookie");

/** null, never "", so every reader agrees on what "no session" looks like. */
function readCookie(): string | null {
  try {
    return readFileSync(COOKIE_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeCookie(cookie: string): void {
  writeFileSync(COOKIE_FILE, cookie, "utf8");
}

function clearCookie(): void {
  try {
    rmSync(COOKIE_FILE);
  } catch {
    /* already gone */
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

// A text/plain POST is a CORS simple request: no preflight, so a page on any site
// lands the write without ever reading the reply. Loopback binding is no defence,
// the request comes from a browser on this machine.
function isLocalOrigin(origin?: string): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolveBody(data));
    req.on("error", reject);
  });
}

/** Vite plugin: serves /cloud/* from the user's own starlink.com session, held in
 *  a local .starlink-cookie file. */
export function starlinkCloudProxy(): Plugin {
  return {
    name: "starlink-cloud-proxy",
    configureServer(server) {
      // This plugin's callbacks run in the Vite dev server's own Node process,
      // not the browser -- Node's fetch (unlike the browser's) has no page
      // origin to resolve a relative "/api/..." against, so the DishClient
      // instance built here needs an absolute base pointed at our FastAPI
      // backend. Scoped to this process only: the browser's own DishClient
      // instances (everything the rest of the UI uses) keep the relative
      // default, proxied through Vite's own /api entry in vite.config.ts.
      // NOT replaced by upstream's "embed the recorder in the dev server"
      // plugin (HISTORIAN_EMBED / collector/historian.mts serving /api/*
      // directly) -- this fork's /api is always the Python backend, dev or
      // packaged, so that embed is deliberately not adopted, upstream commit
      // after upstream commit.
      setApiBase("http://127.0.0.1:8787/api");
      let routerPromise: Promise<DishClient> | null = null;
      let dishPromise: Promise<DishClient> | null = null;
      const protosetBytes = () =>
        new Uint8Array(readFileSync(resolve(process.cwd(), "public/dish.protoset")));
      // Every router callback needs the same client, and the gateway ones need it
      // only as a codec — loading it dials nothing.
      const loadRouter = () =>
        (routerPromise ??= DishClient.load("router", {
          handleUrl: ROUTER_LAN_HANDLE_URL,
          protosetBytes: protosetBytes(),
        }));
      const handler = createCloudHandler({
        fetch: resilientFetch,
        readCookie,
        writeCookie,
        clearCookie,
        prepareDeviceUpdate: async (update, targetId, callGateway) =>
          prepareRouterClientUpdate(
            await loadRouter(),
            update,
            targetId,
            callGateway,
            localNetworkIdentity(),
          ),
        prepareWifiConfigUpdate: async (update) =>
          prepareRouterWifiConfigUpdate(await loadRouter(), update),
        prepareDishUpdate: async (update) => {
          dishPromise ??= DishClient.load("dish", { protosetBytes: protosetBytes() });
          return prepareDishUpdate(await dishPromise, update);
        },
        // Encoding only — the client is never dialled here, so this works on a
        // kit whose router answers nothing on the LAN.
        prepareRouterConfigUpdate: async (update, targetId, callGateway) => {
          const client = await loadRouter();
          const context = await readRouterConfigContext(update, client, targetId, callGateway);
          return client.encodeRequest(buildRouterConfigRequest(targetId, update, context));
        },
        readRouterSubnet: async (targetId, callGateway) =>
          readCurrentSubnet(await loadRouter(), targetId, callGateway),
        readRouterClients: async (targetId, callGateway) =>
          readRouterClients(await loadRouter(), targetId, callGateway),
        readRouterConfig: async (targetId, callGateway) =>
          readRouterWifiConfig(await loadRouter(), targetId, callGateway),
      });

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/cloud/")) return next();
        if (!isLocalOrigin(req.headers.origin))
          return sendJson(res, 403, { error: "forbidden_origin" });
        const route = url.split("?")[0];

        // Connect / disconnect the session pasted from the UI.
        if (route === "/cloud/session") {
          if (req.method === "DELETE") {
            const { status, body } = handler.disconnect();
            return sendJson(res, status, body);
          }
          if (req.method === "POST") {
            try {
              const { cookie } = JSON.parse((await readBody(req)) || "{}") as { cookie?: string };
              const { status, body } = await handler.connect(cookie ?? "");
              return sendJson(res, status, body);
            } catch {
              return sendJson(res, 400, {
                error: "bad_request",
                message: "Expected JSON { cookie }.",
              });
            }
          }
          return sendJson(res, 405, { error: "method_not_allowed" });
        }

        if (route === "/cloud/device" && req.method === "POST") {
          try {
            const update = JSON.parse((await readBody(req)) || "{}") as RouterClientUpdate;
            const result = await handler.updateClient(update);
            return sendJson(res, result.status, result.body);
          } catch (error) {
            return sendJson(res, 400, { error: "bad_request", message: (error as Error).message });
          }
        }

        if (route === "/cloud/wifi-config" && req.method === "POST") {
          try {
            const update = JSON.parse((await readBody(req)) || "{}") as RouterWifiConfigUpdate;
            const result = await handler.updateWifiConfig(update);
            return sendJson(res, result.status, result.body);
          } catch (error) {
            return sendJson(res, 400, { error: "bad_request", message: (error as Error).message });
          }
        }

        if (route === "/cloud/dish-config" && req.method === "POST") {
          try {
            const update = JSON.parse((await readBody(req)) || "{}") as DishUpdate;
            const result = await handler.updateDishConfig(update);
            return sendJson(res, result.status, result.body);
          } catch (error) {
            return sendJson(res, 400, { error: "bad_request", message: (error as Error).message });
          }
        }

        if (route === "/cloud/router-config" && req.method === "POST") {
          try {
            const update = JSON.parse((await readBody(req)) || "{}") as RouterConfigUpdate;
            const result = await handler.updateRouterConfig(update);
            return sendJson(res, result.status, result.body);
          } catch (error) {
            return sendJson(res, 400, { error: "bad_request", message: (error as Error).message });
          }
        }

        const { status, body } = await handler.handle(route);
        sendJson(res, status, body);
      });
    },
  };
}
