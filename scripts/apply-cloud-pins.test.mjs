import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const script = join(root, "scripts/apply-cloud-pins.mjs");

test("apply-cloud-pins rejects missing env", () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CLOUD_SANDBOX_IMAGE: "", CLOUD_PROJECT_BASE_SHA: "" },
  });
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error, "invalid_pins");
});

test("apply-cloud-pins writes digest image and base sha without enabling execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pitcrew-pins-"));
  try {
    await mkdir(join(dir, "apps/worker"), { recursive: true });
    await mkdir(join(dir, "config"), { recursive: true });
    await mkdir(join(dir, "scripts"), { recursive: true });
    await copyFile(
      join(root, "apps/worker/wrangler.backend.json"),
      join(dir, "apps/worker/wrangler.backend.json"),
    );
    await copyFile(
      join(root, "config/cloudflare-sandbox-build.json"),
      join(dir, "config/cloudflare-sandbox-build.json"),
    );
    await copyFile(script, join(dir, "scripts/apply-cloud-pins.mjs"));
    const image =
      "registry.cloudflare.com/pitcrew/pitcrew-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const result = spawnSync(process.execPath, ["scripts/apply-cloud-pins.mjs"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUD_SANDBOX_IMAGE: image,
        CLOUD_PROJECT_BASE_SHA: sha,
        CLOUD_SMOKE_VERIFIED: "true",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const backend = JSON.parse(
      await readFile(join(dir, "apps/worker/wrangler.backend.json"), "utf8"),
    );
    const build = JSON.parse(
      await readFile(join(dir, "config/cloudflare-sandbox-build.json"), "utf8"),
    );
    assert.equal(backend.vars.EXECUTION_MODE, "disabled");
    assert.equal(backend.vars.INFRASTRUCTURE_ADMISSION_ENABLED, "false");
    assert.equal(backend.vars.PROJECT_BASE_SHA, sha);
    assert.equal(backend.containers[0].images.sandbox.image, image);
    assert.equal(backend.containers[1].images.sandbox.image, image);
    assert.equal(build.registeredCloudflareImage, image);
    assert.equal(build.cloudSmokeVerified, true);
    assert.equal(build.cloudMission.projectBaseSha, sha);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
