import { expect, it } from "vite-plus/test";
import { piExecutionAllowed } from "./pi-execution";

it("keeps fake runs off Pi and requires cloud admission", () => {
  expect(piExecutionAllowed("fake", "true", Date.now() + 1000, Date.now())).toBe(false);
  expect(piExecutionAllowed("cloud", "false", Date.now() + 1000, Date.now())).toBe(false);
  expect(piExecutionAllowed("cloud", "true", Date.now() - 1000, Date.now())).toBe(false);
  expect(piExecutionAllowed("cloud", "true", Date.now() + 1000, Date.now())).toBe(true);
});

it("allows a local run with a deadline and without cloud admission", () => {
  expect(piExecutionAllowed("local", "false", Date.now() + 1000, Date.now())).toBe(true);
  expect(piExecutionAllowed("local", undefined, undefined, Date.now())).toBe(false);
});
