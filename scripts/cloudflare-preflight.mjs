import { readFile } from "node:fs/promises";

// Offline inspection only. Never reads credentials, calls Cloudflare, or deploys.
const path = process.argv[2] ?? "apps/worker/wrangler.backend.json";
const config = JSON.parse(await readFile(path, "utf8"));
const vars = config.vars ?? {};
const blockers = [];
if (!Number.isInteger(config.limits?.cpu_ms) || config.limits.cpu_ms < 1 || config.limits.cpu_ms > 1000 ||
    !Number.isInteger(config.limits?.subrequests) || config.limits.subrequests < 1 || config.limits.subrequests > 20)
  blockers.push("Bound Worker CPU to 1000ms and subrequests to 20 for initial rollout.");
blockers.push("Monthly admission reservations, aggregate concurrency and durable stop enforcement are not implemented; autonomous paid execution must remain disabled.");
if (config.assets || config.site) blockers.push("Remove frontend assets from the backend config.");
if (config.workers_dev !== false || config.preview_urls !== false)
  blockers.push("Disable public workers.dev and preview URLs.");
if (vars.EXECUTION_MODE !== "cloud") blockers.push("Cloud execution remains disabled.");
if (!/^[a-f0-9]{40}$/.test(vars.PROJECT_BASE_SHA ?? ""))
  blockers.push("Pin PROJECT_BASE_SHA to the imported Artifacts repository commit.");
if (!vars.CONFIGURATION_REVISION) blockers.push("Set CONFIGURATION_REVISION.");
if (!vars.ARTIFACT_REPOSITORY) blockers.push("Set ARTIFACT_REPOSITORY.");
if (!config.artifacts?.some((binding) => binding.binding === "ARTIFACTS" && binding.namespace))
  blockers.push("Bind ARTIFACTS to an approved namespace.");
let model;
try { model = JSON.parse(vars.MODEL_CONFIGURATION); } catch {}
if (model?.provider === "cloudflare") {
  if (!model.model?.startsWith("@cf/") || config.ai?.binding !== "AI")
    blockers.push("Select an approved Workers AI model and bind AI.");
} else if (model?.provider === "byok") {
  blockers.push("Verify the approved provider secret exists remotely; this offline check cannot prove it.");
} else blockers.push("Set an approved real MODEL_CONFIGURATION.");
for (const className of ["ChangeAgent", "ReviewAgent"]) {
  const container = config.containers?.find((item) => item.class_name === className);
  const image = container?.images?.[vars.SANDBOX_IMAGE]?.image;
  if (container?.max_instances !== 1)
    blockers.push(`Limit ${className} to one running instance for initial rollout.`);
  if (container?.scheduling_policy !== "durable_object" ||
      !/^registry\.cloudflare\.com\/[a-zA-Z0-9_./-]+@sha256:[a-f0-9]{64}$/.test(image ?? ""))
    blockers.push(`Bind ${className} to a digest-pinned named sandbox image.`);
}
if (!["ACCESS_ISSUER", "ACCESS_AUDIENCE", "ACCESS_EMAIL", "ACCESS_HOSTNAME"].every((key) => vars[key]))
  blockers.push("Configure authenticated backend ingress and the local relay contract.");
console.log(JSON.stringify({
  config: path,
  liveConnectionVerified: false,
  cloudCallsMade: false,
  readyForLiveVerification: blockers.length === 0,
  blockers,
  next: "OAuth and infrastructure budget are approved; finish runtime guards, service provisioning and authenticated ingress before live verification. No paid inference is authorized."
}, null, 2));
process.exitCode = blockers.length ? 1 : 0;
