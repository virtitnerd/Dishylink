import { describe, expect, test, vi } from "vitest";
import { AccountRequiredError } from "./routerClientUpdate";
import {
  applyDishConfigUpdate,
  clearDishObstructionMapViaCloud,
  setDishConfigViaCloud,
  setDishStowViaCloud,
} from "./dishConfigUpdate";

describe("applyDishConfigUpdate", () => {
  test("given: a successful config write, should: post the update to /cloud/dish-config", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });

    await applyDishConfigUpdate({ kind: "config", changes: { swupdateRebootHour: 15 } }, request);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      path: "/cloud/dish-config",
      method: "POST",
      body: { kind: "config", changes: { swupdateRebootHour: 15 } },
    });
  });

  test("given: Starlink rejects the change, should: surface its message", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 504,
      body: { message: "Starlink did not answer in time." },
    });

    await expect(
      applyDishConfigUpdate({ kind: "config", changes: { powerSaveMode: true } }, request),
    ).rejects.toThrow("Starlink rejected the dish update: Starlink did not answer in time.");
  });

  test("given: 428, should: surface a sign-in prompt rather than a rejection", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 428,
      body: { error: "not_connected", message: "An authorized account is required." },
    });

    await expect(
      applyDishConfigUpdate({ kind: "config", changes: { powerSaveMode: true } }, request),
    ).rejects.toBeInstanceOf(AccountRequiredError);
  });
});

describe("setDishConfigViaCloud / setDishStowViaCloud / clearDishObstructionMapViaCloud", () => {
  test("given: setDishConfigViaCloud, should: wrap the changes in a config update", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    await setDishConfigViaCloud({ snowMeltMode: "AUTO" }, request);
    expect(request).toHaveBeenCalledWith({
      path: "/cloud/dish-config",
      method: "POST",
      body: { kind: "config", changes: { snowMeltMode: "AUTO" } },
    });
  });

  test("given: setDishStowViaCloud, should: send a stow update", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    await setDishStowViaCloud(true, request);
    expect(request).toHaveBeenCalledWith({
      path: "/cloud/dish-config",
      method: "POST",
      body: { kind: "stow", unstow: true },
    });
  });

  test("given: clearDishObstructionMapViaCloud, should: send a clearObstructionMap update", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    await clearDishObstructionMapViaCloud(request);
    expect(request).toHaveBeenCalledWith({
      path: "/cloud/dish-config",
      method: "POST",
      body: { kind: "clearObstructionMap" },
    });
  });
});
