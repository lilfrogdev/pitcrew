import { expect, it } from "vite-plus/test";
import { VisualizationAuthorityGate } from "./visualization-authority-gate";

it("orders revocation and effects, releases failures, and bounds queued admission before effects", async () => {
  const gate = new VisualizationAuthorityGate();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const effects: string[] = [];
  const first = gate.run(async () => {
    await held;
    effects.push("publication");
  });
  const revoked = gate.run(async () => {
    effects.push("revocation");
    throw Error("failed response");
  });
  // Attach rejection handlers before releasing the shared operation queue.
  const rejected = expect(revoked).rejects.toThrow("failed response");
  const next = gate.run(async () => {
    effects.push("next read");
  });
  const remaining = Array.from({ length: 13 }, () => gate.run(async () => {}));
  expect(gate.pending).toBe(16);
  await expect(
    gate.run(async () => {
      effects.push("overflow");
    }),
  ).rejects.toThrow("visualization_authority_busy");
  expect(effects).toEqual([]);
  release();
  await Promise.all([first, rejected, next, ...remaining]);
  expect(effects).toEqual(["publication", "revocation", "next read"]);
  expect(gate.pending).toBe(0);
  expect(await gate.run(async () => "recovered")).toBe("recovered");
});
