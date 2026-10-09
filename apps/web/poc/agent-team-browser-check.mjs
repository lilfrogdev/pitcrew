// Real UI -> production relays -> temporary real Better Auth/Worker/D1.
// Only Artifacts provider transport is synthetic. Never attaches a human browser.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createAuthRelayMiddleware } from "../../../scripts/auth-relay.mjs";
import { createBackendRelayMiddleware, BACKEND_ACCESS } from "../../../scripts/backend-relay.mjs";
import { browser } from "./recipient-invitations-browser.mjs";

if (!process.argv[2]) throw Error("Provide an evidence directory");
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
const harness =
  process.env.PITCREW_QA_SHARING_HARNESS ?? resolve("apps/worker/test/agent-team-harness.ts");
const { agentTeamFixture, base } = await import(pathToFileURL(harness).href);
const fixture = await agentTeamFixture({ memoryEnabled: true });
const threads = [
  await fixture.makeThread("Synthetic notes A"),
  await fixture.makeThread("Synthetic notes B"),
];
const buildDir = await mkdtemp(join(tmpdir(), "pitcrew-agent-team-ui-"));
const calls = [],
  results = [];
let server, chromium, owner, recipient;
const virtualOrigin = "http://localhost:5173";
let origin;
try {
  await build({
    entryPoints: ["apps/web/poc/agent-team.tsx"],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    loader: { ".svg": "dataurl" },
    outdir: buildDir,
  });
  const transport = async (url, options = {}) => {
    const upstream = new URL(url);
    assert.equal(upstream.origin, BACKEND_ACCESS.origin, "No external cloud transport");
    const target = new URL(upstream.pathname + upstream.search, base);
    const headers = new Headers(options.headers);
    if (headers.has("origin")) headers.set("origin", base);
    headers.set("cf-connecting-ip", "192.0.2.44");
    const method = options.method ?? "GET";
    // Log safe route/body shape only, never credentials, cookies or invitation tokens.
    const route = target.pathname.replace(/\/invitations\/[a-f0-9]{64}/g, "/invitations/:token");
    const body =
      /\/invitations$|\/repositories\/create$|\/repository$|\/messages$/.test(target.pathname) &&
      ["POST", "PATCH"].includes(method) &&
      options.body
        ? JSON.parse(options.body)
        : undefined;
    const record = { route, method, status: "pending", ...(body ? { body } : {}) };
    calls.push(record);
    const response = await fixture.mf.dispatchFetch(target.href, {
      method,
      headers,
      body: options.body,
    });
    record.status = response.status;
    return response;
  };
  const noAccess = () => {
    throw Error("Unexpected Access token/provider transport");
  };
  const auth = createAuthRelayMiddleware({
    enabled: true,
    passwordMode: true,
    origin: virtualOrigin,
    tokenProvider: noAccess,
    verifyAccess: noAccess,
    requestBackend: transport,
  });
  const backend = createBackendRelayMiddleware({
    enabled: true,
    passwordMode: true,
    sharedApi: true,
    origin: virtualOrigin,
    tokenProvider: noAccess,
    verifyToken: noAccess,
    fetchImpl: transport,
    sessionHeaders: auth.sessionHeaders,
  });
  server = createServer(async (req, res) => {
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return res.writeHead(403).end();
      if (req.url === "/fixture/meta") {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            projectId: fixture.ownedRepository.projectId,
            threads: threads.map((t) => t.id),
          }),
        );
      }
      if (req.url.startsWith("/api/")) {
        // QA-only adapter for fixed auth-relay dev-origin allowlist. Distinct real
        // port checked above; no listener exists at virtual port 5173.
        req.headers.host = new URL(virtualOrigin).host;
        if (req.headers.origin) req.headers.origin = virtualOrigin;
        for (let n = 0; n < req.rawHeaders.length; n += 2) {
          if (req.rawHeaders[n].toLowerCase() === "host") req.rawHeaders[n + 1] = req.headers.host;
          if (req.rawHeaders[n].toLowerCase() === "origin") req.rawHeaders[n + 1] = virtualOrigin;
        }
        return auth(req, res, () => backend(req, res, () => res.writeHead(404).end()));
      }
      const file = new URL(req.url, origin).pathname;
      if (file === "/")
        return res.end(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temporary Agent Team QA</title><link rel="stylesheet" href="/agent-team.css"></head><body><div id="root"></div><script type="module" src="/agent-team.js"></script></body></html>',
        );
      if (!["/agent-team.js", "/agent-team.css"].includes(file)) return res.writeHead(404).end();
      res.setHeader("content-type", file.endsWith("js") ? "text/javascript" : "text/css");
      res.end(await readFile(join(buildDir, file.slice(1))));
    } catch (error) {
      console.error(error);
      res.writeHead(500).end("Temporary fixture failure");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${server.address().port}`;
  assert.notEqual(server.address().port, 5173);
  chromium = await browser(origin, evidence);
  owner = await chromium.page();
  recipient = await chromium.page();
  const pass = (name) => {
    results.push({ name, status: "passed" });
    console.log("PASS", name);
  };
  const login = async (page, persona) => {
    await page.navigate();
    await page.includes("Sign in");
    await page.fill("Username", persona.username);
    await page.fill("Password", persona.password);
    await page.click("Sign in");
    await page.includes("Synthetic notes A");
  };
  for (const path of [
    `/projects/${fixture.ownedRepository.projectId}/invitations`,
    `/threads/${threads[0].id}/invitations`,
  ]) {
    const response = await fixture.owner(path, { recipient: "@johncena", role: "editor" });
    assert.equal(response.status, 201);
    const invitation = await response.json();
    assert.equal((await fixture.john(`/invitations/${invitation.token}/accept`, {})).status, 200);
  }
  await login(owner, fixture.personas.issuer);
  await login(recipient, fixture.personas.recipient);
  pass(
    "Two empty Chromium contexts authenticate through production relays and real Better Auth 1.7.7/D1",
  );
  const textarea = 'document.querySelector("textarea#message")';
  const focus = (page) => page.evaluate(`(${textarea}).focus()`);
  const value = (page) => page.evaluate(`(${textarea}).value`);
  const destination = (page) =>
    page.evaluate(
      `document.querySelector('.composer-destination button[aria-pressed="true"]')?.textContent.trim()`,
    );
  const key = async (page, key, modifiers = 0) => {
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, modifiers });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, modifiers });
  };
  const type = async (page, text) => {
    await focus(page);
    if (text) await key(page, text[0]);
    await page.cdp("Input.insertText", { text });
  };
  const snapshot = () => fixture.repository.invocationSnapshot(fixture.ownedRepository.projectId);
  await owner.wait(() => owner.evaluate(`Boolean(${textarea})`), "composer ready");
  assert.equal(await destination(owner), "Team");
  await type(owner, "Browser draft retained across destinations");
  await key(owner, "Tab");
  assert.equal(await destination(owner), "Agent");
  assert.equal(await value(owner), "Browser draft retained across destinations");
  assert.equal(await owner.evaluate(`document.activeElement===${textarea}`), true);
  await key(owner, "Tab");
  assert.equal(await destination(owner), "Team");
  await key(owner, "Escape");
  await key(owner, "Tab");
  assert.equal(await owner.evaluate(`document.activeElement===${textarea}`), false);
  assert.equal(await destination(owner), "Team");
  await focus(owner);
  await key(owner, "Tab", 8);
  assert.equal(await owner.evaluate(`document.activeElement===${textarea}`), false);
  pass("Textarea Tab swaps destinations, retains draft, and Escape/Shift Tab provide focus exits");
  await owner.click("Agent", "form.composer");
  await owner.click("Team", "form.composer");
  assert.equal(await value(owner), "Browser draft retained across destinations");
  const file = join(buildDir, "browser-draft.txt");
  await writeFile(file, "Synthetic attachment retained across destination switches");
  const doc = await owner.cdp("DOM.getDocument");
  const input = await owner.cdp("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "form.composer input[type=file]",
  });
  await owner.cdp("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [file] });
  await owner.includes("browser-draft.txt");
  await owner.click("Agent", "form.composer");
  await owner.click("Team", "form.composer");
  await owner.includes("browser-draft.txt");
  await owner.click("Send message", "form.composer").catch(async () => {
    await owner.evaluate(
      `document.querySelector('form.composer button[aria-label="Send message"]').click()`,
    );
  });
  await owner.wait(
    async () =>
      (await snapshot()).messages.some(
        (m) => m.content === "Browser draft retained across destinations",
      ),
    "Team note stored",
  );
  let state = await snapshot();
  assert.equal(state.turns.length, 0);
  assert.equal(state.modelCalls.length, 0);
  assert.equal(state.runs.length, 0);
  assert.equal(
    state.messages.find((m) => m.content === "Browser draft retained across destinations")
      .attachments.length,
    1,
  );
  pass("Clickable destinations preserve attachment and Team posts are durable with no inference");
  await recipient.wait(() => recipient.evaluate(`Boolean(${textarea})`), "recipient composer");
  await focus(recipient);
  await recipient.evaluate(
    `(${textarea}).dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:new DataTransfer()}))`,
  );
  await recipient.cdp("Input.insertText", { text: "Pasted @agent stays a Team note" });
  await key(recipient, "Escape");
  await key(recipient, "Enter");
  await recipient.wait(
    async () =>
      (await snapshot()).messages.some((m) => m.content.startsWith("Pasted @agent stays")),
    "literal Team note stored",
  );
  assert.equal((await snapshot()).turns.length, 0);
  pass("Pasted literal agent text from the second native account creates no invocation");
  await type(recipient, "@ag");
  await recipient.includes("@agent · Agent");
  await key(recipient, "Tab");
  assert.equal(await destination(recipient), "Team");
  assert.equal(await value(recipient), "@agent ");
  await recipient.cdp("Input.insertText", { text: "Explain the saved notes" });
  await key(recipient, "Enter");
  await recipient.wait(
    async () => (await snapshot()).turns.some((t) => t.status === "completed"),
    "explicit Team mention completes",
  );
  state = await snapshot();
  assert.equal(state.turns.length, 1);
  assert.equal(state.modelCalls.length, 1);
  assert.equal(state.runs.length, 0);
  assert.equal(state.turns[0].input.credentialActor, fixture.recipientActor);
  pass(
    "Autocomplete consumes Tab, explicit reserved agent mention invokes once and freezes the sender payer",
  );
  await fixture.restart();
  await recipient.navigate();
  await recipient.includes("Synthetic notes A");
  assert.equal((await snapshot()).modelCalls.length, 1);
  pass("Reload after real Worker restart restores history without repeating the invocation");
  await owner.screenshot("agent-team-desktop");
  await recipient.cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await recipient.wait(
    () => recipient.evaluate("document.documentElement.scrollWidth<=window.innerWidth"),
    "bounded narrow composer",
  );
  await recipient.screenshot("agent-team-narrow");
  pass(
    "Desktop and 390px narrow layout retain visible Agent Team controls without horizontal overflow",
  );
  assert.equal(chromium.errors.length, 0, "No renderer exceptions");
  assert.equal(chromium.external.length, 0, "No renderer external transport");
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify(
      {
        results,
        calls,
        browserErrors: chromium.errors,
        blockedExternalOrigins: chromium.external,
        limits: [
          "Isolated empty-profile Chromium, not a human session",
          "Real local BetterAuth/D1/DurableObjects/Pi, synthetic credentials and faux model transport only",
          "Ephemeral origin adapter excludes exact deployed-origin admission",
          "Provider stream replacement does not test production per-request option wrapper; bounded production model tests run separately",
        ],
      },
      null,
      2,
    ),
  );
  for (const file of ["failure.json", "failure-owner.txt", "failure-owner.png"])
    await rm(join(evidence, file), { force: true });
  console.log(`${results.length} browser scenarios passed; evidence ${evidence}`);
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ error: String(error), results, calls }, null, 2),
  );
  if (owner) {
    await owner.screenshot("failure-owner").catch(() => {});
    await writeFile(join(evidence, "failure-owner.txt"), await owner.text().catch(() => ""));
  }
  throw error;
} finally {
  await fixture.repository.releaseModel().catch(() => {});
  await chromium?.close();
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await fixture.mf.dispose();
  await rm(buildDir, { recursive: true, force: true });
}
