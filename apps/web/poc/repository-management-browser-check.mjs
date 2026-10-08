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
    `[...${scopeSource(scope)}.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(name)})`;
  const labelSource = (name, scope) =>
    `[...${scopeSource(scope)}.querySelectorAll('label')].find(el=>[...el.childNodes].filter(node=>node.nodeType===3).map(node=>node.textContent).join('').trim()===${JSON.stringify(name)})?.querySelector('input,textarea')`;
  const disabled = (name, scope) => evaluate(`Boolean((${buttonSource(name, scope)})?.disabled)`);
  const clickElement = async (source) => {
    await wait(
      () => evaluate(`Boolean((${source}) && !(${source}).disabled)`),
      "enabled rendered control",
    );
    const rect = await evaluate(
      `(()=>{const el=${source};el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`,
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
  const checkbox = async () =>
    clickElement(
      `document.querySelector('form[aria-label="Create repository"] input[type=checkbox]')`,
    );
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
  const navigate = async (scenario = "normal") => {
    await control("reset", { scenario });
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
  assert.equal(await disabled("Create empty repository"), true);
  await fill("Permanent repository name", "qa-arbitrary-slug");
  await fill("Display name (optional)", "Created display");
  await fill("Description (optional)", "Created description");
  assert.equal(await disabled("Create empty repository"), true);
  await checkbox();
  assert.equal(await disabled("Create empty repository"), false);
  await click("Create empty repository");
  await includes("Created display");
  assert.deepEqual((await calls("/api/repositories/create", "POST"))[0].body, {
    name: "qa-arbitrary-slug",
    credentialConsent: true,
    displayName: "Created display",
    description: "Created description",
  });
  pass(
    "Arbitrary repository creation with explicit consent",
    "Real HTTP client emitted the expected synthetic create request only after consent.",
  );
  await navigate();
  await open();
  await fill("Display name", "Changed display", "Owner display");
  await fill("Description", "Changed description", "Owner display");
  await click("Save repository details", "Owner display");
  await includes("Changed display");
  await open("Changed display");
  const edited = (await state()).repositories[0];
  assert.equal(edited.repositoryName, "owner-physical");
  assert.equal(edited.repositoryId, "qa-repository-id");
  assert.deepEqual((await calls("/api/projects/qa-owner/repository", "PATCH"))[0].body, {
    displayName: "Changed display",
    description: "Changed description",
    expectedRevision: 0,
  });
  pass(
    "Display metadata edit preserves physical identity",
    "PATCH changed display/description and kept physical name/id; browser still renders permanent identifiers.",
  );
  await navigate();
  await open();
  await includes("pending@example.test");
  await fill("Invitation recipient email", "guest@example.test", "Owner display");
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
  await fill("Invitation recipient email", "guest@example.test", "Owner display");
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
  await navigate();
  await open();
  await click("Review deletion", "Owner display");
  await includes("permanently removes");
  await fill("Type the permanent repository name to confirm", "Owner display", "Owner display");
  assert.equal(await disabled("Permanently delete repository", "Owner display"), true);
  await fill("Type the permanent repository name to confirm", "owner-physical", "Owner display");
  await click("Permanently delete repository", "Owner display");
  await observePendingDeletion();
  await delay(350);
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 1);
  assert.equal(await disabled("Recover repository deletion", "Owner display"), true);
  assert.equal(
    await evaluate(`Boolean(${labelSource("Invitation recipient email", "Owner display")})`),
    false,
  );
  await screenshot("03-pending-deletion");
  await click("Refresh deletion status", "Owner display");
  await includes("Confirm the permanent name to recover");
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 1);
  await fill("Type the permanent repository name to confirm", "owner-physical", "Owner display");
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
  await navigate();
  await fill("Permanent repository name", "qa-lifecycle-slug");
  await fill("Display name (optional)", "Lifecycle display");
  await checkbox();
  await click("Create empty repository");
  await includes("Lifecycle display");
  assert.equal((await state()).creations[0].status, "ready");
  await open("Lifecycle display");
  await click("Review deletion", "Lifecycle display");
  await fill(
    "Type the permanent repository name to confirm",
    "qa-lifecycle-slug",
    "Lifecycle display",
  );
  await click("Permanently delete repository", "Lifecycle display");
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
  await open("Lifecycle display");
  await click("Refresh deletion status", "Lifecycle display");
  await includes("Confirm the permanent name to recover");
  await fill(
    "Type the permanent repository name to confirm",
    "qa-lifecycle-slug",
    "Lifecycle display",
  );
  await click("Recover repository deletion", "Lifecycle display");
  await wait(
    async () => !String(await text()).includes("Lifecycle display"),
    "created repository tombstone removed from directory",
  );
  assert.equal((await state()).creations[0].status, "deleted");
  await wait(
    () => evaluate("Boolean(document.querySelector('form[aria-label=\"Create repository\"]'))"),
    "create capability remains after deleted creation discovery",
  );
  assert.equal(String(await text()).includes("Could not check repository creation status"), false);
  await open();
  await fill("Display name", "Owner after tombstone", "Owner display");
  await click("Save repository details", "Owner display");
  await includes("Owner after tombstone");
  await fill("Permanent repository name", "qa-lifecycle-slug");
  await checkbox();
  assert.equal(await disabled("Create empty repository"), true);
  await fill("Permanent repository name", "qa-after-tombstone");
  await fill("Display name (optional)", "Created after tombstone");
  await checkbox();
  await click("Create empty repository");
  await includes("Created after tombstone");
  assert.deepEqual(
    (await state()).creations.map((record) => record.status),
    ["deleted", "ready"],
  );
  await screenshot("05-lifecycle-tombstone-directory");
  pass(
    "Native creation discovery survives deleting and deleted lifecycle records",
    "Created resource record transitions ready→deleting on HTTP 202→deleted on HTTP 200. Directory refresh preserves create/manage capabilities, unrelated owner metadata remains editable, deleted physical name cannot be reused, and a different repository can be created after the tombstone.",
  );
  await navigate("edit-conflict");
  await open();
  await fill("Display name", "Conflict change", "Owner display");
  await click("Save repository details", "Owner display");
  await includes("This repository changed.");
  assert.equal((await calls("/api/projects/qa-owner/repository", "PATCH")).length, 1);
  assert.equal(String(await text()).includes("private-provider-diagnostic"), false);
  await navigate("delete-failure");
  await open();
  await click("Review deletion", "Owner display");
  await fill("Type the permanent repository name to confirm", "owner-physical", "Owner display");
  await click("Permanently delete repository", "Owner display");
  await includes("The deletion result is unknown.");
  assert.equal(await disabled("Permanently delete repository", "Owner display"), true);
  await delay(250);
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 1);
  pass(
    "Mutation conflict and uncertain-delete constraints",
    "Generic error text excludes provider diagnostics; unknown delete blocks further mutation and does not retry.",
  );
  await navigate("wrong-delete-target");
  await open();
  await click("Review deletion", "Owner display");
  await fill("Type the permanent repository name to confirm", "owner-physical", "Owner display");
  await click("Permanently delete repository", "Owner display");
  await observePendingDeletion();
  await click("Refresh deletion status", "Owner display");
  await includes("Could not check deletion status.");
  await fill("Type the permanent repository name to confirm", "owner-physical", "Owner display");
  assert.equal(await disabled("Recover repository deletion", "Owner display"), true);
  assert.equal((await calls("/api/projects/qa-owner/repository/delete", "POST")).length, 1);
  pass(
    "Mismatched deletion observation cannot authorize recovery",
    "GET with a different repository ID keeps recovery disabled even after retyping the correct physical name.",
  );
  await navigate("invite-failure");
  await open();
  await fill("Invitation recipient email", "guest@example.test", "Owner display");
  await click("Create invitation link", "Owner display");
  await includes("The invitation result is unknown.");
  assert.equal(await disabled("Create invitation link", "Owner display"), true);
  assert.equal((await calls("/api/projects/qa-owner/invitations", "POST")).length, 1);
  pass(
    "Unknown invitation constraint",
    "Creation disabled after uncertain result until access is refreshed.",
  );
  await navigate("create-failure");
  await fill("Permanent repository name", "uncertain-create");
  await checkbox();
  await click("Create empty repository");
  await includes("The creation result is unknown.");
  assert.equal((await calls("/api/repositories/create", "POST")).length, 1);
  await click("Refresh");
  await includes("creation result for uncertain-create is unknown");
  assert.equal(await disabled("Create empty repository"), true);
  pass(
    "Unknown creation constraint",
    "GET discovery does not silently retry POST or unlock another create while the prior outcome remains unknown.",
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
  assert.equal(await disabled("Create empty repository"), true);
  assert.equal(String(await text()).includes("private-provider-diagnostic"), false);
  pass(
    "Directory failure constraints",
    "Failed directory read hides previous records and disables create.",
  );
  await navigate("late-invite");
  await open();
  await fill("Invitation recipient email", "late-private@example.test", "Owner display");
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
  await fill("Invitation recipient email", "late-unmounted@example.test", "Owner display");
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
  await rm(profile, { recursive: true, force: true });
  await rm(buildDir, { recursive: true, force: true });
}
