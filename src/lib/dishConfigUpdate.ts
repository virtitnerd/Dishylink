import { cloudRequest, type CloudRequest, type CloudReply } from "./cloudHost";
import type { DishConfigJson } from "@core/dishClient";
import type { DishUpdate } from "@core/dishConfigUpdate";
import { AccountRequiredError } from "./routerClientUpdate";

/** Send one dish update through Starlink cloud. Mirrors
 *  applyRouterWifiConfigUpdate in routerWifiConfigUpdate.ts -- see that file
 *  for the full reasoning; this is the same pattern for the dish itself. */
export async function applyDishConfigUpdate(
  update: DishUpdate,
  request: (request: CloudRequest) => Promise<CloudReply> = cloudRequest,
): Promise<void> {
  const reply = await request({ path: "/cloud/dish-config", method: "POST", body: update });
  if (reply.status === 200) return;
  const message = (reply.body as { message?: string })?.message ?? `HTTP ${reply.status}`;
  if (reply.status === 428) throw new AccountRequiredError(message);
  throw new Error(`Starlink rejected the dish update: ${message}`);
}

export async function setDishConfigViaCloud(changes: DishConfigJson): Promise<void> {
  await applyDishConfigUpdate({ kind: "config", changes });
}

export async function setDishStowViaCloud(unstow: boolean): Promise<void> {
  await applyDishConfigUpdate({ kind: "stow", unstow });
}

export async function clearDishObstructionMapViaCloud(): Promise<void> {
  await applyDishConfigUpdate({ kind: "clearObstructionMap" });
}
