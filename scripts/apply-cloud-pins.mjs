#!/usr/bin/env node
/**
 * Apply owner-provisioned cloud pins into committed config placeholders.
 * Offline only — never calls Cloudflare.
 *
 * Usage (owner, after registry push + Artifacts seed):
 *   CLOUD_SANDBOX_IMAGE='registry.cloudflare.com/.../pitcrew-sandbox@sha256:...' \
 *   CLOUD_PROJECT_BASE_SHA='<40-hex>' \
 *   node scripts/apply-cloud-pins.mjs
 *
 * Optional:
 *   CLOUD_CONFIGURATION_REVISION=cloud-mission-smoke-v1
 *   CLOUD_SMOKE_VERIFIED=true
 */
import { readFile, writeFile } from "node:fs/promises";

const image = process.env.CLOUD_SANDBOX_IMAGE ?? "";
const baseSha = process.env.CLOUD_PROJECT_BASE_SHA ?? "";
const revision = process.env.CLOUD_CONFIGURATION_REVISION ?? "cloud-mission-smoke-v1";
const smokeVerified = process.env.CLOUD_SMOKE_VERIFIED === "true";

const imageOk = /^registry\.cloudflare\.com\/[a-zA-Z0-9_./-]+@sha256:[a-f0-9]{64}$/.test(image);
const shaOk = /^[a-f0-9]{40}$/.test(baseSha);
if (!imageOk || !shaOk) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        error: "invalid_pins",
        need: {
          CLOUD_SANDBOX_IMAGE: "registry.cloudflare.com/<ns>/pitcrew-sandbox@sha256:<64-hex>",
          CLOUD_PROJECT_BASE_SHA: "<40-hex Artifacts head>",
        },
        received: {
          imageOk,
          shaOk,
          imagePrefix: image.slice(0, 48) || null,
          baseShaLength: baseSha.length,
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
  process.exit();
}

const backendPath = "apps/worker/wrangler.backend.json";
const buildPath = "config/cloudflare-sandbox-build.json";
const backend = JSON.parse(await readFile(backendPath, "utf8"));
const build = JSON.parse(await readFile(buildPath, "utf8"));

for (const container of backend.containers ?? []) {
  if (!["ChangeAgent", "ReviewAgent"].includes(container.class_name)) continue;
  container.images ??= {};
  container.images.sandbox = { image };
}
backend.vars ??= {};
backend.vars.SANDBOX_IMAGE = "sandbox";
backend.vars.ARTIFACT_REPOSITORY = "pitcrew-baseline";
backend.vars.PROJECT_BASE_SHA = baseSha;
backend.vars.CONFIGURATION_REVISION = revision;
// Never enable paid execution from this helper.
backend.vars.EXECUTION_MODE = "disabled";
backend.vars.INFRASTRUCTURE_ADMISSION_ENABLED = "false";

build.registeredCloudflareImage = image;
build.cloudSmokeVerified = smokeVerified;
build.cloudMission = {
  artifactRepository: "pitcrew-baseline",
  projectBaseSha: baseSha,
  configurationRevision: revision,
  appliedAt: new Date().toISOString(),
};

await writeFile(backendPath, `${JSON.stringify(backend, null, 2)}\n`);
await writeFile(buildPath, `${JSON.stringify(build, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ok: true,
      backendPath,
      buildPath,
      registeredCloudflareImage: image,
      projectBaseSha: baseSha,
      configurationRevision: revision,
      cloudSmokeVerified: smokeVerified,
      executionMode: "disabled",
      next: "Redeploy with wrangler.backend.json still disabled; run no-model smoke; then flip gates live only.",
    },
    null,
    2,
  ),
);
