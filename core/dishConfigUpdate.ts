import type { DishClient, DishConfigJson } from "./dishClient";

export interface DishConfigRequestJson {
  targetId: string;
  dishSetConfig: {
    dishConfig: Record<string, unknown>;
  };
}

/**
 * Generic partial DishConfig write via the cloud gateway -- mirrors
 * wifiConfigRequestFor in routerWifiConfigUpdate.ts, and the same
 * apply<Field> convention starlink_client.py's set_dish_config uses locally.
 * Unlike WifiConfig's networks[], DishConfig is a flat message with its own
 * apply_* flag per field, so (unlike contentFiltering/ssid/etc there) this
 * never needs to read the dish's current config first -- there's no repeated
 * field to read-modify-write around.
 */
function dishConfigRequestFor(targetId: string, changes: DishConfigJson): DishConfigRequestJson {
  if (!targetId.startsWith("ut")) throw new Error("invalid dish target id");
  const dishConfig: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    dishConfig[field] = value;
    dishConfig[`apply${field[0].toUpperCase()}${field.slice(1)}`] = true;
  }
  return { targetId, dishSetConfig: { dishConfig } };
}

/**
 * The writes this module knows how to build. "config" covers every knob in
 * DishConfigJson (snow melt, sleep schedule, software-update window,
 * location-request mode) in one generic partial write -- same shape
 * useDishSettings.save() already sends to the (firmware-blocked) local RPC,
 * just re-encoded for the cloud gateway instead. "stow" and
 * "clearObstructionMap" are separate RPCs entirely (DishStowRequest /
 * DishClearObstructionMapRequest, not DishSetConfigRequest), so they get
 * their own request shape rather than being folded into "config".
 */
export type DishUpdate =
  | { kind: "config"; changes: DishConfigJson }
  | { kind: "stow"; unstow: boolean }
  | { kind: "clearObstructionMap" };

/** Trusted-host preparation, mirroring prepareRouterWifiConfigUpdate: source
 *  the target device id directly from the local dish immediately before
 *  encoding the cloud write. Reads via getDeviceInfo rather than the fuller
 *  getStatus -- all this needs is the id. */
export async function prepareDishUpdate(
  dish: DishClient,
  update: DishUpdate,
): Promise<Uint8Array> {
  const deviceInfo = await dish.getDeviceInfo(AbortSignal.timeout(5_000));
  const targetId = deviceInfo.id;
  if (!targetId) throw new Error("Starlink dish identity is unavailable");

  if (update.kind === "config") {
    return dish.encodeRequest(dishConfigRequestFor(targetId, update.changes));
  }
  if (update.kind === "stow") {
    return dish.encodeRequest({ targetId, dishStow: { unstow: update.unstow } });
  }
  if (update.kind === "clearObstructionMap") {
    return dish.encodeRequest({ targetId, dishClearObstructionMap: {} });
  }
  throw new Error(`unhandled update kind`);
}
