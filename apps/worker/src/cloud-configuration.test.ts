import { expect, it } from "vite-plus/test";
import { cloudInitialState, sandboxImage } from "./cloud-configuration";
it("pins fresh cloud project state to explicit canonical head and revision", () => {
  expect(
    cloudInitialState({ PROJECT_BASE_SHA: "a".repeat(40), CONFIGURATION_REVISION: "demo-1" })
      .project,
  ).toMatchObject({ baseSha: "a".repeat(40), configurationRevision: "demo-1" });
  expect(() => cloudInitialState({ CONFIGURATION_REVISION: "demo-1" })).toThrow(
    "project_not_configured",
  );
});
it("selects only an explicitly registered digest-pinned named sandbox image", () => {
  const image = `registry.cloudflare.com/account/pitcrew@sha256:${"a".repeat(64)}`;
  expect(sandboxImage("pitcrew", { pitcrew: image })).toBe(image);
  const invalid: Record<string, string>[] = [
    {},
    { pitcrew: "docker.io/library/node:latest" },
    { pitcrew: "registry.cloudflare.com/account/pitcrew:latest" },
  ];
  for (const images of invalid)
    expect(() => sandboxImage("pitcrew", images)).toThrow("image_not_configured");
  expect(() => sandboxImage(image, { pitcrew: image })).toThrow("image_not_configured");
});
