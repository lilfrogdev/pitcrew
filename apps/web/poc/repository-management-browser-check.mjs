// Actual browser DOM + real HTTP adapter, synthetic loopback API, empty temp profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { createFixture } from "./repository-management-fixture.mjs";

if (!process.argv[2]) throw Error("Provide an evidence output directory.");
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
const buildDir = await mkdtemp(join(tmpdir(), "pitcrew-repository-management-build-"));
await build({
  entryPoints: ["apps/web/poc/repository-management.tsx"],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  loader: { ".svg": "dataurl" },
  outdir: buildDir,
});
const fixture = createFixture();
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/") || req.url.startsWith("/fixture/"))
      return await fixture.handle(req, res);
    if (req.url === "/")
      return res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Repository management synthetic QA</title><link rel="stylesheet" href="/repository-management.css"></head><body><div id="root"></div><script type="module" src="/repository-management.js"></script></body></html>',
      );
    const file = req.url.slice(1);
    if (!["repository-management.js", "repository-management.css"].includes(file))
      return res.writeHead(404).end();
    res.setHeader("content-type", file.endsWith("js") ? "text/javascript" : "text/css");
    res.end(await readFile(join(buildDir, file)));
  } catch (error) {
    res.writeHead(500).end("Synthetic fixture failure");
    process.stderr.write(String(error) + "\n");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "pitcrew-repository-management-browser-"));
const chrome = spawn(
  process.env.PITCREW_QA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
const network = [];
const consoleErrors = [];
let ws;
let cdp;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(port, "Dedicated empty-profile browser started");
  ws = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
  await new Promise((done, reject) => {
    ws.onopen = done;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) {
      const pair = pending.get(msg.id);
      if (!pair) return;
      pending.delete(msg.id);
      clearTimeout(pair.timer);
      if (msg.error) pair.reject(Error(msg.error.message));
      else pair.done(msg.result);
    } else if (msg.method === "Network.requestWillBeSent") network.push(msg.params.request.url);
    else if (msg.method === "Runtime.exceptionThrown")
      consoleErrors.push(msg.params.exceptionDetails.text);
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`CDP timeout: ${method}`));
      }, 10000);
      pending.set(id, { done, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  cdp = (method, params) => call(method, params, sessionId);
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  // Interception confines renderer traffic to this run's loopback fixture.
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  const previousMessage = ws.onmessage;
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    previousMessage(event);
    if (msg.method === "Fetch.requestPaused")
      void cdp(
        msg.params.request.url.startsWith(origin + "/")
          ? "Fetch.continueRequest"
          : "Fetch.failRequest",
        {
          requestId: msg.params.requestId,
          ...(msg.params.request.url.startsWith(origin + "/")
            ? {}
            : { errorReason: "BlockedByClient" }),
        },
      );
  };
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const text = () => evaluate("document.body?.innerText ?? ''");
  const wait = async (fn, message) => {
    for (let i = 0; i < 120; i++) {
      if (await fn()) return;
      await delay(50);
    }
    throw Error(`Timed out: ${message}`);
  };
  const includes = (phrase) => wait(async () => String(await text()).includes(phrase), phrase);
  const scopeSource = (scope) =>
    scope ? `document.querySelector('section[aria-label="Manage ${scope}"]')` : "document";
  const buttonSource = (name, scope) =>
    `[...(${scopeSource(scope)}?.querySelectorAll('button') ?? [])].find(el=>el.textContent.trim()===${JSON.stringify(name)})`;
  const labelSource = (name, scope) =>
    `[...(${!scope && name === "Repository name" ? "document.querySelector('form[aria-label=\"Create repository\"]')" : scopeSource(scope)}?.querySelectorAll('label') ?? [])].find(el=>[...el.childNodes].filter(node=>node.nodeType===3).map(node=>node.textContent).join('').trim()===${JSON.stringify(name)})?.querySelector('input,textarea')`;
  const disabled = (name, scope) => evaluate(`Boolean((${buttonSource(name, scope)})?.disabled)`);
  const clickElement = async (source) => {
    await wait(
      () => evaluate(`Boolean((${source}) && !(${source}).disabled)`),
      "enabled rendered control",
    );
    const rect = await evaluate(
      `(async()=>{const el=${source};el.scrollIntoView({block:'center',behavior:'instant'});await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`,
    );
    await cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...rect,
      button: "left",
      clickCount: 1,
    });
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...rect,
      button: "left",
      clickCount: 1,
    });
  };
  const click = (name, scope) => clickElement(buttonSource(name, scope));
  const fill = async (name, value, scope) => {
    await clickElement(labelSource(name, scope));
    await evaluate(`(${labelSource(name, scope)}).select()`);
    await cdp("Input.insertText", { text: value });
  };
  const ordinaryControls = async () => {
    assert.equal(await evaluate("document.querySelector('form[aria-label=\"Create repository\"]')?.querySelectorAll('input[type=checkbox]').length ?? 0"), 0);
  };
  const control = async (path, body = {}) => {
    const result = await fetch(origin + "/fixture/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(result.status, 200);
  };
  const state = async () => await (await fetch(origin + "/fixture/state")).json();
  const calls = async (path, method) =>
    (await state()).calls.filter((c) => c.path === path && (!method || c.method === method));
  const navigate = async (scenario = "normal", deleteEnabled = false) => {
    await control("reset", { scenario, deleteEnabled });
    await cdp("Page.navigate", { url: origin + "/" });
    await includes(scenario === "read-failure" ? "Could not load repositories" : "Repositories");
    if (scenario !== "late-read" && scenario !== "read-failure") await includes("Owner display");
  };
  const open = async (name = "Owner display") => {
    await click("Manage repository", name);
    await includes("Repository settings");
  };
  const observePendingDeletion = async (name = "Owner display") => {
    // A confirmed 202 refreshes directory/Work and collapses management.
    await includes("Deletion pending");
    await open(name);
    await includes("Repository deletion is pending.");
  };
  const screenshot = async (name) => {
    await evaluate("window.scrollTo(0,0)");
    const data = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    await writeFile(join(evidence, name + ".png"), Buffer.from(data.data, "base64"));
  };
  const pass = (name, details) => {
    results.push({ name, status: "passed", details });
    process.stdout.write(`PASS ${name}\n`);
  };
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate();
  await screenshot("01-desktop-directory");
  assert.equal(await evaluate("document.querySelectorAll('button[aria-expanded]').length"), 2);
  await open("External display");
  assert.equal(await disabled("Review deletion", "External display"), true);
  await click("Close management", "External display");
  pass(
    "Owner/editor/external constraints",
    "Owner and external-owner metadata are manageable; editor has no management controls; external repository delete disabled.",
  );
  assert.equal(await disabled("Create repository"), true);
  await fill("Repository name", "qa-arbitrary-slug");
  await fill("Description (optional)", "Created description");
  await ordinaryControls();
  assert.equal(await disabled("Create repository"), false);
  await click("Create repository");
  await includes("qa-arbitrary-slug");
  assert.deepEqual((await calls("/api/repositories/create", "POST"))[0].body, {
    name: "qa-arbitrary-slug",
    credentialConsent: true,
    displayName: "qa-arbitrary-slug",
    description: "Created description",
  });
  pass(
    "Arbitrary repository creation with explicit Create consent",
    "One canonical name and optional description emit the expected request with consent only on explicit Create; the ordinary consent checkbox is absent.",
  );
  await navigate();
  await open();
  await fill("Repository name", "changed-display", "Owner display");
  await fill("Description", "Changed description", "Owner display");
  await click("Save repository details", "Owner display");
  await includes("changed-display");
  await open("changed-display");
  const edited = (await state()).repositories[0];
  assert.equal(edited.repositoryName, "owner-physical");
  assert.equal(edited.repositoryId, "qa-repository-id");
  assert.deepEqual((await calls("/api/projects/qa-owner/repository", "PATCH"))[0].body, {
    logicalName: "changed-display",
    displayName: "changed-display",
    description: "Changed description",
    expectedRevision: 0,
  });
  pass(
    "Canonical name and description edit preserves physical identity",
    "PATCH changed logical/display name together and description while physical name/id remained permanent.",
  );
  await navigate();
  await fill("Repository name", "invalid_name");
  await ordinaryControls();
  assert.equal(await disabled("Create repository"), true);
  await fill("Repository name", "a".repeat(64));
  await ordinaryControls();
  assert.equal(await disabled("Create repository"), true);
  await fill("Repository name", "Kelvin");
  await ordinaryControls();
  assert.equal(await disabled("Create repository"), true);
  await fill("Repository name", "\u00a0name\u00a0");
  await ordinaryControls();
  assert.equal(await disabled("Create repository"), true);
  const rawLogical = `  MiXeD-${"A".repeat(57)}  `;
  const canonicalLogical = rawLogical.trim().toLowerCase();
  await fill("Repository name", rawLogical);
  await ordinaryControls();
  await click("Create repository");
  await includes(canonicalLogical);
  const canonicalCreation = (await state()).creations[0];
  assert.equal(canonicalCreation.logicalName, canonicalLogical);
  assert.equal(canonicalCreation.name, canonicalLogical);
  assert.equal(
    canonicalCreation.repositoryName,
    `${canonicalLogical.slice(0, 30)}-${canonicalCreation.projectId.replaceAll("-", "")}`,
  );
  assert.equal(canonicalCreation.repositoryName.length, 63);
  assert.equal((await calls("/api/repositories/create", "POST"))[0].body.name, canonicalLogical);
  await open(canonicalLogical);
  await includes(`Repository name: ${canonicalLogical}`);
  await includes(`Physical name: ${canonicalCreation.repositoryName}`);
  assert.equal(
    await evaluate(`(${labelSource("Repository name", canonicalLogical)}).value`),
    canonicalLogical,
  );
  assert.equal(
    await evaluate(
      `(${scopeSource(canonicalLogical)}).querySelector('dl').innerText.includes(${JSON.stringify(canonicalCreation.repositoryName)})`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      `(${scopeSource(canonicalLogical)}).querySelector('dl').innerText.includes('Physical repository name (permanent)')`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      `[...(${scopeSource(canonicalLogical)}).querySelectorAll('input,textarea')].some(field=>!field.readOnly && field.value===${JSON.stringify(canonicalCreation.repositoryName)})`,
    ),
    false,
  );
  await fill("Repository name", canonicalLogical.toUpperCase());
  await ordinaryControls();
  assert.equal(await disabled("Create repository"), true);
  assert.equal((await calls("/api/repositories/create", "POST")).length, 1);
  await screenshot("07-logical-and-physical-names");
  pass(
    "Canonical logical slug and readonly generated physical identity",
    "Invalid punctuation, non-ASCII Kelvin sign, and 64-character logical names are blocked; mixed case and whitespace canonicalize to a 63-character slug. The persisted project UUID generates a separate 63-character physical name, rendered read-only; known same-owner case duplicate is blocked.",
  );
  await navigate();
  await control("seed-ready", {
    logicalName: "shared-logical",
    displayName: "First client display",
  });
  const existingIntent = (await state()).creations[0];
  await fill("Repository name", "SHARED-LOGICAL");
  await ordinaryControls();
  await click("Create repository");
  await includes("First client display");
  assert.equal((await state()).creations.length, 1);
  assert.equal((await state()).creations[0].projectId, existingIntent.projectId);
  assert.equal((await state()).creations[0].repositoryName, existingIntent.repositoryName);
  assert.equal((await calls("/api/repositories/create", "POST")).length, 1);
  pass(
    "Same-owner concurrent ready intent is recovered through HTTP 200",
    "A synthetic other tab completes an active intent after initial discovery. Creating the same canonical name reuses its existing UUID, physical identity, and metadata without allocating a second repository.",
  );
  await navigate("registration-recovery");
  await fill("Repository name", "Recover-Logical");
  await ordinaryControls();
  await click("Create repository");
  await includes("The repository needs registration");
  const partialIntent = (await state()).creations[0];
  const partialProject = (await state()).pendingProjects[partialIntent.repositoryName];
  assert.equal(partialIntent.status, "registration_required");
  await clickElement(
    `document.querySelector('section[aria-label="Repository creation recover-logical"] input[type=checkbox]')`,
  );
  await click("Recover repository creation");
  await includes("recover-logical");
  await wait(async () => (await state()).creations[0].status === "ready", "same-resource recovery completed");
  assert.equal((await state()).creations.length, 1);
  assert.equal((await state()).creations[0].repositoryName, partialIntent.repositoryName);
  assert.equal((await state()).creations[0].projectId, partialProject.projectId);
  assert.deepEqual((await calls("/api/repositories/create", "POST"))[1].body, {
    name: "recover-logical",
    credentialConsent: true,
  });
  pass(
    "Same-resource partial creation recovery preserves persisted physical identity",
    "Explicit credential-consented recovery reuses the UUID/physical identity allocated before the simulated provider result and preserves the original display metadata.",
  );
  await navigate();
  await fill("Repository name", "same-owner-name");
  await fill("Description (optional)", "Repeated description");
  await ordinaryControls();
  await click("Create repository");
  await includes("same-owner-name");
  const firstOwnerCreation = (await state()).creations[0];
  await fill("Repository name", "another-owner-name");
  await fill("Description (optional)", "Repeated description");
  await ordinaryControls();
  await click("Create repository");
  await wait(
    async () => (await state()).creations.length === 2,
    "second owner-scoped canonical name accepted",
  );
  await wait(
    async () => !String(await text()).includes("Creating repository…"),
    "second same-owner create completed",
  );
  assert.equal(
    (await state()).repositories.filter(
      (item) => ["same-owner-name", "another-owner-name"].includes(item.name) && item.description === "Repeated description",
    ).length,
    2,
  );
  await control("switch");
  await click("Switch fixture account");
  await includes("Second account repository");
  await fill("Repository name", "SAME-OWNER-NAME");
  await fill("Description (optional)", "Repeated description");
  await ordinaryControls();
  await click("Create repository");
  await includes("same-owner-name");
  const secondOwnerCreation = (await state()).creations.at(-1);
  assert.equal(secondOwnerCreation.logicalName, firstOwnerCreation.logicalName);
  assert.notEqual(secondOwnerCreation.projectId, firstOwnerCreation.projectId);
  assert.notEqual(secondOwnerCreation.repositoryName, firstOwnerCreation.repositoryName);
  assert.equal(secondOwnerCreation.name, firstOwnerCreation.name);
  await screenshot("08-owner-scoped-logical-name");
  pass(
    "Different owners can use the same logical name",
    "One account creates two canonical names with repeated descriptions. Another account creates the same logical name with a distinct UUID and physical name.",
  );
  await navigate();
  await open();
  await fill("Repository name", "ReNaMeD-Logical", "Owner display");
  await click("Save repository details", "Owner display");
  await includes("Repository name: renamed-logical");
  const renamed = (await state()).repositories[0];
  assert.equal(renamed.logicalName, "renamed-logical");
  assert.equal(renamed.repositoryName, "owner-physical");
  assert.equal(renamed.repositoryId, "qa-repository-id");
  await open("renamed-logical");
  await fill("Repository name", "Kelvin", "renamed-logical");
  assert.equal(await disabled("Save repository details", "renamed-logical"), true);
  await fill("Repository name", "\u00a0name\u00a0", "renamed-logical");
  assert.equal(await disabled("Save repository details", "renamed-logical"), true);
  assert.equal((await calls("/api/projects/qa-owner/repository", "PATCH")).length, 1);
  await fill("Repository name", "external-logical", "renamed-logical");
  await click("Save repository details", "renamed-logical");
  await includes("This repository name is already used in your account.");
  assert.equal((await state()).repositories[0].logicalName, "renamed-logical");
  assert.equal((await state()).repositories[0].repositoryName, "owner-physical");
  await fill("Repository name", "another-logical", "renamed-logical");
  await click("Save repository details", "renamed-logical");
  await includes("Repository name: another-logical");
  assert.equal((await state()).repositories[0].repositoryName, "owner-physical");
  pass(
    "Logical rename and owner collision preserve physical identity",
    "Case-normalized logical rename leaves physical name/provider ID unchanged. Non-ASCII Kelvin/NBSP rename drafts send no PATCH. HTTP 409 collision preserves identity and allows correction to an available owner-scoped name.",
  );
  await navigate("legacy-approved");
  await includes("Create repository");
  await click("Create repository");
  await includes("legacy-approved-physical");
  await wait(
    async () =>
      (await state()).creations.some((record) => record.name === "legacy-approved-physical"),
    "approved legacy create completed",
  );
  assert.equal((await state()).repositories.at(-1).repositoryName, "legacy-approved-physical");
  assert.equal((await state()).creations[0].repositoryName, undefined);
  assert.deepEqual((await calls("/api/repositories/create", "POST"))[0].body, {
    name: "legacy-approved-physical",
    credentialConsent: true,
  });
  pass(
    "Legacy exact-approved creation retains its physical name",
    "With broad create/manage off, exact-approved creation emits the unchanged legacy body and preserves the exact approved physical name rather than generating a new namespace.",
  );
  await navigate();
  await open();
  await includes("pending@example.test");
  await fill("Username or email", "guest@example.test", "Owner display");
  await click("Create invitation link", "Owner display");
  await includes("Invitation created.");
  const link = await evaluate(`(${labelSource("Invitation link", "Owner display")}).value`);
  assert.match(link, /\?invitation=a{64}$/);
  assert.equal(await evaluate("localStorage.length+sessionStorage.length"), 0);
  // Grant only this synthetic origin clipboard access in the isolated profile.
  await call("Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await click("Copy invitation link", "Owner display");
  await includes("Invitation link copied.");
  assert.equal(await evaluate("navigator.clipboard.readText()"), link);
  await screenshot("02-invitation-owner-settings");
  await click("Close management", "Owner display");
  await open();
  assert.equal(
    await evaluate(`Boolean(${labelSource("Invitation link", "Owner display")})`),
    false,
  );
  await click("Revoke invitation", "Owner display");
  await includes("Invitation revoked.");
  assert.deepEqual(
    (
      await calls(
        "/api/projects/qa-owner/invitations/00000000-0000-4000-8000-000000000001/revoke",
        "POST",
      )
    )[0].body,
    {},
  );
  await click("Revoke member access", "Owner display");
  await includes("Member access revoked.");
  assert.equal((await calls("/api/projects/qa-owner/members/qa-editor-actor", "DELETE")).length, 1);
  assert.equal(
    await evaluate(`(${scopeSource("Owner display")}).innerText.includes('owner@example.test')`),
    true,
  );
  pass(
    "Invitation creation/copy/ephemeral cleanup and ID/member revoke",
    "64-hex fixture link copied via browser clipboard; no storage keys; closing clears link; UUID revoke and selected editor DELETE observed.",
  );
  await navigate();
  await open();
  await fill("Username or email", "guest@example.test", "Owner display");
  await click("Create invitation link", "Owner display");
  await includes("Invitation created.");
  await clickElement(
    `(()=>{const root=${scopeSource("Owner display")};const row=[...root.querySelectorAll('li')].find(el=>el.innerText.includes('guest@example.test'));return row.querySelector('button');})()`,
  );
  await includes("Invitation revoked.");
  assert.equal(
    await evaluate(`Boolean(${labelSource("Invitation link", "Owner display")})`),
    false,
  );
  assert.equal(
    (
      await calls(
        "/api/projects/qa-owner/invitations/00000000-0000-4000-8000-000000000002/revoke",
        "POST",
      )
    ).length,
    1,
  );
  pass(
    "Revoking the currently displayed invitation clears its link",
    "Selected invitation UUID is used; revoked ephemeral link disappears immediately.",
  );
  await navigate("normal", true);
  await open();
  await click("Review deletion", "Owner display");
  await includes("permanently removes");
  await fill("Type the physical repository name to confirm", "Owner display", "Owner display");
  assert.equal(await disabled("Permanently delete repository", "Owner display"), true);
  await fill("Type the physical repository name to confirm", "owner-physical", "Owner display");
  await click("Permanently delete repository", "Owner display");
  await observePendingDeletion();
  await delay(350);
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 1);
  assert.equal(await disabled("Recover repository deletion", "Owner display"), true);
  assert.equal(
    await evaluate(`Boolean(${labelSource("Username or email", "Owner display")})`),
    false,
  );
  await screenshot("03-pending-deletion");
  await click("Refresh deletion status", "Owner display");
  await includes("Confirm the permanent name to recover");
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 1);
  await fill("Type the physical repository name to confirm", "owner-physical", "Owner display");
  await click("Recover repository deletion", "Owner display");
  await wait(async () => !String(await text()).includes("Owner display"), "deleted row removed");
  assert.deepEqual(
    (await calls("/api/projects/qa-owner/repository/delete", "POST")).map((x) => x.body),
    [
      { confirmation: "owner-physical", repositoryId: "qa-repository-id" },
      { confirmation: "owner-physical", repositoryId: "qa-repository-id" },
    ],
  );
  pass(
    "Typed permanent delete, 202 observation and explicit same-resource recovery",
    "No automatic POST retry; GET preceded fresh typed confirmation and second explicit POST; deleted row removed.",
  );
  await navigate("normal", true);
  await fill("Repository name", "qa-lifecycle-slug");
  await ordinaryControls();
  await click("Create repository");
  await includes("qa-lifecycle-slug");
  assert.equal((await state()).creations[0].status, "ready");
  const originalLifecycle = (await state()).creations[0];
  await open("qa-lifecycle-slug");
  await click("Review deletion", "qa-lifecycle-slug");
  await fill(
    "Type the physical repository name to confirm",
    originalLifecycle.repositoryName,
    "qa-lifecycle-slug",
  );
  await click("Permanently delete repository", "qa-lifecycle-slug");
  await includes("Deletion pending");
  assert.equal((await state()).creations[0].status, "deleting");
  await click("Refresh");
  await includes("Deletion pending");
  assert.equal(String(await text()).includes("Could not check repository creation status"), false);
  assert.equal(
    await evaluate("Boolean(document.querySelector('form[aria-label=\"Create repository\"]'))"),
    true,
  );
  assert.equal(await evaluate("document.querySelectorAll('button[aria-expanded]').length"), 3);
  await fill("Repository name", "qa-lifecycle-slug");
  await ordinaryControls();
  assert.equal(await disabled("Create repository"), true);
  await open("qa-lifecycle-slug");
  await click("Refresh deletion status", "qa-lifecycle-slug");
  await includes("Confirm the permanent name to recover");
  await fill(
    "Type the physical repository name to confirm",
    originalLifecycle.repositoryName,
    "qa-lifecycle-slug",
  );
  await click("Recover repository deletion", "qa-lifecycle-slug");
  await wait(
    () => evaluate(`!document.querySelector('section[aria-label="Manage qa-lifecycle-slug"]')`),
    "created repository tombstone removed from directory",
  );
  assert.equal((await state()).creations[0].status, "deleted");
  await wait(
    () => evaluate("Boolean(document.querySelector('form[aria-label=\"Create repository\"]'))"),
    "create capability remains after deleted creation discovery",
  );
  assert.equal(String(await text()).includes("Could not check repository creation status"), false);
  await open();
  await fill("Repository name", "owner-after-tombstone", "Owner display");
  await click("Save repository details", "Owner display");
  await includes("owner-after-tombstone");
  await fill("Repository name", "qa-lifecycle-slug");
  await ordinaryControls();
  assert.equal(await disabled("Create repository"), false);
  await click("Create repository");
  await includes("qa-lifecycle-slug");
  await wait(async () => (await state()).creations.length === 2, "fresh UUID recreation completed");
  assert.deepEqual(
    (await state()).creations.map((record) => record.status),
    ["deleted", "ready"],
  );
  const freshLifecycle = (await state()).creations[1];
  assert.equal(freshLifecycle.logicalName, originalLifecycle.logicalName);
  assert.notEqual(freshLifecycle.repositoryName, originalLifecycle.repositoryName);
  assert.notEqual(freshLifecycle.projectId, originalLifecycle.projectId);
  await screenshot("05-lifecycle-tombstone-directory");
  pass(
    "Native creation discovery survives deleting and deleted lifecycle records",
    "Created resource record transitions ready→deleting on HTTP 202→deleted on HTTP 200. Deleting reserves the logical name. Directory refresh preserves create/manage capabilities and unrelated edits. Confirmed deletion permits the same logical name with a fresh project UUID/physical name; the old physical identity stays retired.",
  );
  await navigate("edit-conflict");
  await open();
  await fill("Repository name", "conflict-change", "Owner display");
  await click("Save repository details", "Owner display");
  await includes("This repository changed.");
  assert.equal((await calls("/api/projects/qa-owner/repository", "PATCH")).length, 1);
  assert.equal(String(await text()).includes("private-provider-diagnostic"), false);
  await navigate("delete-failure", true);
  await open();
  await click("Review deletion", "Owner display");
  await fill("Type the physical repository name to confirm", "owner-physical", "Owner display");
  await click("Permanently delete repository", "Owner display");
  await includes("The deletion result is unknown.");
  assert.equal(await disabled("Permanently delete repository", "Owner display"), true);
  await delay(250);
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 1);
  pass(
    "Mutation conflict and uncertain-delete constraints",
    "Generic error text excludes provider diagnostics; unknown delete blocks further mutation and does not retry.",
  );
  await navigate("wrong-delete-target", true);
  await open();
  await click("Review deletion", "Owner display");
  await fill("Type the physical repository name to confirm", "owner-physical", "Owner display");
  await click("Permanently delete repository", "Owner display");
  await observePendingDeletion();
  await click("Refresh deletion status", "Owner display");
  await includes("Could not check deletion status.");
  await fill("Type the physical repository name to confirm", "owner-physical", "Owner display");
  assert.equal(await disabled("Recover repository deletion", "Owner display"), true);
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 1);
  pass(
    "Mismatched deletion observation cannot authorize recovery",
    "GET with a different repository ID keeps recovery disabled even after retyping the correct physical name.",
  );
  await navigate("invite-failure");
  await open();
  await fill("Username or email", "guest@example.test", "Owner display");
  await click("Create invitation link", "Owner display");
  await includes("The invitation result is unknown.");
  assert.equal(await disabled("Create invitation link", "Owner display"), true);
  assert.equal((await calls("/api/projects/qa-owner/invitations", "POST")).length, 1);
  pass(
    "Unknown invitation constraint",
    "Creation disabled after uncertain result until access is refreshed.",
  );
  await navigate("recipient-mismatch");
  await open();
  await fill("Username or email", "guest@example.test", "Owner display");
  await click("Create invitation link", "Owner display");
  await includes("The invitation result is unknown.");
  assert.equal(await disabled("Create invitation link", "Owner display"), true);
  assert.equal(await evaluate(`Boolean(${labelSource("Invitation link", "Owner display")})`), false);
  assert.equal((await calls("/api/projects/qa-owner/invitations", "POST")).length, 1);
  await click("Refresh access", "Owner display");
  await wait(async () => !(await disabled("Create invitation link", "Owner display")), "explicit refresh releases unknown recipient outcome");
  assert.equal((await calls("/api/projects/qa-owner/invitations", "POST")).length, 1);
  pass(
    "Mismatched recipient response cannot expose a usable invitation link",
    "A successful synthetic mutation returning another canonical recipient is quarantined. No link or automatic retry appears; only explicit access refresh releases the unknown outcome.",
  );
  await navigate("create-failure");
  await fill("Repository name", "uncertain-create");
  await ordinaryControls();
  await click("Create repository");
  await includes("The creation result is unknown.");
  assert.equal((await calls("/api/repositories/create", "POST")).length, 1);
  await click("Refresh");
  await includes("creation result for uncertain-create is unknown");
  assert.equal(await disabled("Create repository"), true);
  pass(
    "Unknown creation constraint",
    "GET discovery does not silently retry POST or unlock another create while the prior outcome remains unknown.",
  );
  await navigate("delete-off");
  assert.equal((await state()).repositories[0].deletable, true);
  await open();
  assert.equal(await disabled("Review deletion", "Owner display"), true);
  await includes("Repository deletion is not enabled for this account.");
  await fill("Repository name", "owner-without-delete", "Owner display");
  await click("Save repository details", "Owner display");
  await includes("owner-without-delete");
  await open("owner-without-delete");
  await includes("pending@example.test");
  await fill("Username or email", "guest@example.test", "owner-without-delete");
  await click("Create invitation link", "owner-without-delete");
  await includes("Invitation created.");
  await fill("Repository name", "qa-delete-disabled");
  await ordinaryControls();
  await click("Create repository");
  await includes("qa-delete-disabled");
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 0);
  assert.equal((await calls("/api/projects/qa-owner/repository", "PATCH")).length, 1);
  assert.equal((await calls("/api/projects/qa-owner/invitations", "POST")).length, 1);
  await open("owner-without-delete");
  assert.equal(await disabled("Review deletion", "owner-without-delete"), true);
  await screenshot("06-management-on-delete-off");
  pass(
    "Independent delete-off capability preserves create and access management",
    "Explicit capabilities.delete:false overrides stale row.deletable:true. Repository creation, metadata PATCH, and invitation creation remain available; deletion review stays disabled and no delete POST is sent.",
  );
  await navigate("delete-omitted");
  await open();
  assert.equal(await disabled("Review deletion", "Owner display"), true);
  assert.equal(await disabled("Save repository details", "Owner display"), false);
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 0);
  pass(
    "Missing independent delete capability defaults off",
    "An older discovery response with only create/manage leaves metadata enabled and deletion disabled despite stale deletable:true.",
  );
  await navigate("normal", true);
  await open();
  await click("Review deletion", "Owner display");
  await fill("Type the physical repository name to confirm", "owner-physical", "Owner display");
  assert.equal(await disabled("Permanently delete repository", "Owner display"), false);
  await control("delete-capability", { enabled: false });
  await click("Refresh");
  await open();
  assert.equal(await disabled("Review deletion", "Owner display"), true);
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 0);
  await navigate("normal", true);
  await open();
  await click("Review deletion", "Owner display");
  await fill("Type the physical repository name to confirm", "owner-physical", "Owner display");
  await click("Permanently delete repository", "Owner display");
  await observePendingDeletion();
  await click("Refresh deletion status", "Owner display");
  await includes("Confirm the permanent name to recover");
  await fill("Type the physical repository name to confirm", "owner-physical", "Owner display");
  assert.equal(await disabled("Recover repository deletion", "Owner display"), false);
  await control("delete-capability", { enabled: false });
  await click("Refresh");
  await open();
  assert.equal(await disabled("Recover repository deletion", "Owner display"), true);
  assert.equal(
    await evaluate(
      `(${labelSource("Type the physical repository name to confirm", "Owner display")}).disabled`,
    ),
    true,
  );
  await click("Refresh deletion status", "Owner display");
  await wait(
    async () => (await calls("/api/projects/qa-owner/repository", "GET")).length === 2,
    "pending status remains observable with delete off",
  );
  await wait(
    async () => !(await disabled("Refresh deletion status", "Owner display")),
    "status read completed",
  );
  assert.equal(await disabled("Recover repository deletion", "Owner display"), true);
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 1);
  pass(
    "Refreshed delete-off capability blocks reviewed deletion and pending recovery",
    "Directory refresh after a capability change invalidates the reviewed delete state and blocks a previously authorized recovery action. Confirmation stays disabled while pending status GET remains usable. No additional destructive POST occurs after the false snapshot is observed; this does not claim external administrator TOCTOU prevention.",
  );
  await navigate("gate-off");
  assert.equal(await evaluate("document.querySelectorAll('button[aria-expanded]').length"), 0);
  assert.equal(
    await evaluate("Boolean(document.querySelector('form[aria-label=\"Create repository\"]'))"),
    false,
  );
  pass(
    "Gate-off constraints",
    "New arbitrary create/management UI absent when synthetic capability gate is off.",
  );
  await navigate("read-failure");
  await includes("Could not load repositories");
  assert.equal(await disabled("Create repository"), true);
  assert.equal(String(await text()).includes("private-provider-diagnostic"), false);
  pass(
    "Directory failure constraints",
    "Failed directory read hides previous records and disables create.",
  );
  await navigate("late-invite");
  await open();
  await fill("Username or email", "late-private@example.test", "Owner display");
  await click("Create invitation link", "Owner display");
  await wait(async () => (await state()).held === 1, "held synthetic invitation");
  const before = await evaluate("document.querySelector('output').value");
  await control("switch");
  await click("Switch fixture account");
  await includes("Second account repository");
  await control("release");
  await delay(300);
  assert.equal(await evaluate("document.querySelector('output').value"), before);
  assert.equal(String(await text()).includes("late-private"), false);
  assert.equal(String(await text()).includes("Invitation created."), false);
  assert.equal(await evaluate("Boolean(document.querySelector('input[readonly]'))"), false);
  pass(
    "Late invitation after account switch",
    "New account clears private drafts/link/member views; old response creates no late notice or callback.",
  );
  await navigate("late-invite");
  await open();
  await fill("Username or email", "late-unmounted@example.test", "Owner display");
  await click("Create invitation link", "Owner display");
  await wait(async () => (await state()).held === 1, "held before unmount");
  await click("Unmount directory");
  const unmountedBefore = await evaluate("document.querySelector('output').value");
  await control("release");
  await delay(250);
  assert.equal(await evaluate("document.querySelector('output').value"), unmountedBefore);
  assert.equal(String(await text()).includes("Invitation created."), false);
  pass(
    "Late invitation after unmount",
    "No private link/notice or late callback after directory removal.",
  );
  await navigate("late-read");
  await includes("Loading repositories…");
  await wait(async () => (await state()).held === 1, "held synthetic directory read");
  await control("switch");
  await click("Switch fixture account");
  await includes("Second account repository");
  await control("release");
  await delay(250);
  assert.equal(String(await text()).includes("Owner display"), false);
  pass(
    "Late private directory read after account switch",
    "Old account response cannot repopulate the new account directory.",
  );
  await navigate();
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await open();
  const overflow = await evaluate(
    "({scroll:document.documentElement.scrollWidth,viewport:innerWidth})",
  );
  assert.ok(overflow.scroll <= overflow.viewport, JSON.stringify(overflow));
  await screenshot("04-mobile-owner-settings");
  await evaluate(
    "document.querySelector('section[aria-label=\"Manage Owner display\"] > button').focus()",
  );
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
  });
  await cdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await wait(
    async () => !String(await text()).includes("Repository settings"),
    "keyboard closed settings",
  );
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
  });
  await cdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await includes("Repository settings");
  const ax = await cdp("Accessibility.getFullAXTree");
  const names = ax.nodes
    .filter((n) => !n.ignored)
    .map((n) => n.name?.value)
    .filter(Boolean);
  assert.ok(names.includes("Manage Owner display"));
  assert.ok(names.includes("Save repository details"));
  await writeFile(join(evidence, "accessible-names.json"), JSON.stringify(names, null, 2));
  pass(
    "Mobile layout and keyboard/accessibility",
    "390px viewport has no horizontal document overflow; Enter toggles management; browser accessibility tree includes section/action names.",
  );
  assert.equal(consoleErrors.length, 0, JSON.stringify(consoleErrors));
  assert.ok(
    network.every((url) => url.startsWith(origin + "/") || url === "about:blank"),
    JSON.stringify(network),
  );
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify(
      {
        browser: "isolated headless Chromium",
        scope:
          "Actual AccountRepositories/RepositoryManagement and httpApi with loopback synthetic transport; Codex IAB, live provider and real auth not verified",
        results,
        network,
        consoleErrors,
      },
      null,
      2,
    ),
  );
  await rm(join(evidence, "failure.json"), { force: true });
  await rm(join(evidence, "failure.png"), { force: true });
  process.stdout.write(`Completed ${results.length} browser scenarios. Evidence: ${evidence}\n`);
} catch (error) {
  if (cdp) {
    try {
      const shot = await cdp("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      await writeFile(join(evidence, "failure.png"), Buffer.from(shot.data, "base64"));
    } catch {}
  }
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify(
      {
        error: String(error),
        results,
        network,
        consoleErrors,
        fixture: { ...fixture.state, held: fixture.state.held.length },
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  ws?.close();
  chrome.kill("SIGTERM");
  await new Promise((done) => (chrome.exitCode !== null ? done() : chrome.once("exit", done)));
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(buildDir, { recursive: true, force: true });
}
