import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../fixtures/baseline/", import.meta.url);

async function filesIn(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesIn(path, name)));
    else files.push({ name, bytes: await readFile(path) });
  }
  return files;
}

export async function baselineDigest() {
  const hash = createHash("sha256");
  for (const file of await filesIn(root.pathname)) {
    hash.update(file.name);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

export async function provisionBaseline({ artifacts, approveCloudWrite = false } = {}) {
  const digest = await baselineDigest();
  if (!approveCloudWrite) return { status: "local_only", digest, cloudWrite: false, baseSha: null };
  if (!artifacts?.create || !artifacts.seed || !artifacts.revoke || !artifacts.head)
    throw new Error("cloud_provision_unavailable");
  const created = await artifacts.create("pitcrew-baseline");
  try {
    await artifacts.seed(created, created.token, await filesIn(root.pathname));
    const baseSha = await artifacts.head(created);
    if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("baseline_sha_invalid");
    return { status: "seeded", digest, cloudWrite: true, name: "pitcrew-baseline", baseSha };
  } finally {
    await artifacts.revoke(created, created.token);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const approved = process.env.PITCREW_BASELINE_PROVISION === "approve-cloud-write";
  const result = await provisionBaseline({ approveCloudWrite: approved });
  console.log(JSON.stringify(result));
  if (approved) process.exitCode = 2;
}
