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
import { browser, delay } from "./recipient-invitations-browser.mjs";

if (!process.argv[2]) throw Error("Provide an evidence directory");
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
const harness = process.env.PITCREW_QA_SHARING_HARNESS ?? resolve("apps/worker/test/repository-management-sharing-harness.ts");
const { sharingFixture, base } = await import(pathToFileURL(harness).href);
const fixture = await sharingFixture();
const threads = [await fixture.makeThread("Synthetic notes A"), await fixture.makeThread("Synthetic notes B")];
const buildDir = await mkdtemp(join(tmpdir(), "pitcrew-recipient-ui-"));
const calls = [], results = [];
let server, chromium, owner, recipient;
const virtualOrigin = "http://localhost:5173";
let origin;
let responseHold;
try {
  await build({ entryPoints: ["apps/web/poc/recipient-invitations.tsx"], bundle: true, format: "esm", jsx: "automatic", loader: { ".svg": "dataurl" }, outdir: buildDir });
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
    const body = (/\/invitations$|\/repositories\/create$|\/repository$/.test(target.pathname)) && ["POST", "PATCH"].includes(method) && options.body ? JSON.parse(options.body) : undefined;
    const record = { route, method, status: "pending", ...(body ? { body } : {}) };
    calls.push(record);
    const response = await fixture.mf.dispatchFetch(target.href, { method, headers, body: options.body });
    // Account-switch latency is after the genuine Worker result. Holding a D1
    // authority lookup would also correctly serialize logout behind that lookup.
    if (responseHold && method === "POST" && target.pathname.endsWith(responseHold.suffix ?? "/invitations")) {
      responseHold.entered = true;
      await responseHold.wait;
    }
    record.status = response.status;
    return response;
  };
  const noAccess = () => { throw Error("Unexpected Access token/provider transport"); };
  const auth = createAuthRelayMiddleware({ enabled: true, passwordMode: true, origin: virtualOrigin, tokenProvider: noAccess, verifyAccess: noAccess, requestBackend: transport });
  const backend = createBackendRelayMiddleware({ enabled: true, passwordMode: true, sharedApi: true, origin: virtualOrigin, tokenProvider: noAccess, verifyToken: noAccess, fetchImpl: transport, sessionHeaders: auth.sessionHeaders });
  server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return res.writeHead(403).end();
      if (req.url === "/fixture/meta") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ projectId: fixture.ownedRepository.projectId, threads: threads.map(t => t.id) })); }
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
      if (file === "/") return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temporary recipient sharing QA</title><link rel="stylesheet" href="/recipient-invitations.css"></head><body><div id="root"></div><script type="module" src="/recipient-invitations.js"></script></body></html>');
      if (!["/recipient-invitations.js", "/recipient-invitations.css"].includes(file)) return res.writeHead(404).end();
      res.setHeader("content-type", file.endsWith("js") ? "text/javascript" : "text/css");
      res.end(await readFile(join(buildDir, file.slice(1))));
    } catch (error) { console.error(error); res.writeHead(500).end("Temporary fixture failure"); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${server.address().port}`;
  assert.notEqual(server.address().port, 5173);
  chromium = await browser(origin, evidence);
  owner = await chromium.page(); recipient = await chromium.page();
  const pass = name => { results.push({ name, status: "passed" }); console.log("PASS", name); };
  const login = async (page, persona) => {
    await page.navigate(); await page.includes("Sign in");
    await page.fill("Username", persona.username); await page.fill("Password", persona.password);
    await page.click("Sign in"); await page.includes(persona.email); await page.includes("Repositories");
  };
  await login(owner, fixture.personas.issuer);
  await login(recipient, fixture.personas.recipient);
  pass("Two empty Chromium contexts authenticate through production relays and real Better Auth 1.7.7/D1");
  const management = 'section[aria-label="Manage synthetic-shared-repository"]';
  const sharing = 'section[aria-label="Sharing"]';
  const invitation = 'section[aria-label="Invitation"]';
  const createForm = 'form[aria-label="Create repository"]';
  assert.equal(await owner.evaluate(`document.querySelector(${JSON.stringify(createForm)}).querySelectorAll('input[type=checkbox]').length`), 0);
  assert.equal((await owner.text()).includes("Display name"), false);
  assert.equal((await owner.text()).includes("This creates no code"), false);
  await owner.fill("Repository name", "  Browser-Visible-Name  ", createForm);
  await owner.fill("Description (optional)", "Synthetic browser creation", createForm);
  await owner.click("Create repository", createForm);
  await owner.includes("Repository name: browser-visible-name");
  const createCall = calls.find(c => c.route.endsWith("/repositories/create") && c.method === "POST");
  assert.deepEqual(createCall.body, { name: "browser-visible-name", credentialConsent: true, displayName: "browser-visible-name", description: "Synthetic browser creation" });
  const createdManagement = 'section[aria-label="Manage browser-visible-name"]';
  await owner.click("Manage repository", createdManagement);
  const originalIdentity = await owner.evaluate(`Array.from(document.querySelector(${JSON.stringify(createdManagement)}).querySelectorAll('dd')).map(el=>el.textContent)`);
  await owner.fill("Repository name", "Browser-Renamed", createdManagement);
  await owner.fill("Description", "Renamed by synthetic owner", createdManagement);
  await owner.click("Save repository details", createdManagement);
  await owner.includes("Repository name: browser-renamed");
  const renamedManagement = 'section[aria-label="Manage browser-renamed"]';
  await owner.click("Manage repository", renamedManagement);
  assert.deepEqual(await owner.evaluate(`Array.from(document.querySelector(${JSON.stringify(renamedManagement)}).querySelectorAll('dd')).map(el=>el.textContent)`), originalIdentity);
  const patchCall = calls.find(c => c.method === "PATCH");
  assert.equal(patchCall.body.logicalName, "browser-renamed");
  assert.equal(patchCall.body.displayName, "browser-renamed");
  assert.equal(await owner.evaluate(`Boolean((${owner.button("Review deletion", renamedManagement)}).disabled)`), true);
  assert.equal(calls.some(c => c.route.endsWith("/repository/delete")), false);
  await owner.screenshot("canonical-create-and-settings");
  pass("One canonical name/explicit Create consent, real logical rename with unchanged physical UUID identity, delete gate off");
  await owner.click("Manage repository", management); await owner.includes("Repository settings");
  await owner.fill("Username or email", "@JOHNCENA", management);
  await owner.click("Create invitation link", management);
  await owner.includes("Invitation created.");
  const link = await owner.evaluate(`(${owner.label("Invitation link", management)}).value`);
  const token = new URL(link).searchParams.get("invitation");
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.find(c => c.route.endsWith("/invitations") && c.method === "POST").body, { recipient: "@JOHNCENA", role: "editor" });
  await owner.screenshot("owner-username-link");
  assert.equal(await owner.evaluate(`JSON.stringify([localStorage,sessionStorage]).includes(${JSON.stringify(token)})`), false);
  pass("Repository username input creates exact recipient/editor request and ephemeral link");
  await recipient.navigate(`?invitation=${token}`);
  await recipient.includes("Repository invitation for @johncena.");
  assert.equal(await recipient.evaluate("new URL(location.href).searchParams.has('invitation')"), false);
  await recipient.click("Accept invitation", invitation);
  await recipient.includes("synthetic-shared-repository");
  assert.equal(await recipient.evaluate("document.querySelector('output[aria-label=\"Accepted invitations\"]').textContent"), "project");
  const members = await (await fixture.owner(`/projects/${fixture.ownedRepository.projectId}/members`)).json();
  assert.ok(members.some(m => m.actor === fixture.recipientActor && m.role === "editor"));
  pass("Recipient URL preview/acceptance grants real immutable account membership in D1/Worker");
  await recipient.screenshot("recipient-accepted-repository");
  await owner.click("Share"); await owner.includes("Invite a person");
  await owner.select("Access", "thread", sharing);
  await owner.fill("Username or email", fixture.personas.recipient.email, sharing);
  await owner.click("Create invite code", sharing);
  await owner.includes(`Invite code for ${fixture.personas.recipient.email}`);
  const threadToken = await owner.evaluate("document.getElementById('invite-code').value");
  assert.match(threadToken, /^[a-f0-9]{64}$/);
  await recipient.fill("Invite code", threadToken, invitation); await recipient.click("Check invitation", invitation);
  await recipient.includes(`Thread invitation for ${fixture.personas.recipient.email}.`);
  await recipient.click("Accept invitation", invitation);
  await recipient.wait(async () => (await recipient.evaluate("document.querySelector('output[aria-label=\"Accepted invitations\"]').textContent")) === "project,thread", "thread accepted callback");
  const threadMembers = await (await fixture.owner(`/threads/${threads[0].id}/members`)).json();
  assert.ok(threadMembers.some(m => m.actor === fixture.recipientActor));
  const otherMembers = await (await fixture.owner(`/threads/${threads[1].id}/members`)).json();
  assert.ok(!otherMembers.some(m => m.actor === fixture.recipientActor));
  pass("Email invite/manual code acceptance grants only selected real thread");
  await owner.screenshot("owner-email-thread-code");
  await owner.fill("Username or email", "unknown_synthetic_person", sharing); await owner.click("Create invite code", sharing);
  await owner.includes("That recipient is unavailable");
  pass("Unavailable recipient is actionable and receives no grant");
  const waitLookup = async () => { for (let n = 0; n < 100; n++) { if (await fixture.repository.recipientLookupEntered()) return; await delay(50); } throw Error("Real held D1 recipient lookup not reached"); };
  const waitInviteComplete = async since => { for (let n = 0; n < 100; n++) { if (calls.slice(since).some(c => c.method === "POST" && c.route.endsWith("/invitations") && c.status !== "pending")) return; await delay(50); } throw Error("Held invitation did not complete"); };
  await owner.click("Switch fixture resource");
  await owner.includes("Invite a person");
  await owner.select("Access", "thread", sharing);
  await owner.fill("Username or email", "johncena", sharing);
  await fixture.repository.holdRecipientLookup();
  let since = calls.length;
  await owner.click("Create invite code", sharing); await waitLookup();
  await owner.click("Switch fixture resource");
  await fixture.repository.releaseRecipientLookup(); await waitInviteComplete(since); await delay(200);
  assert.equal(await owner.evaluate("Boolean(document.getElementById('invite-code'))"), false);
  assert.equal((await owner.text()).includes("Invite code ready."), false);
  pass("Resource switch clears private code and fences delayed real D1 invitation response");
  await owner.click("Switch fixture resource"); await owner.includes("Invite a person");
  await owner.select("Access", "thread", sharing); await owner.fill("Username or email", "johncena", sharing);
  await fixture.repository.holdRecipientLookup(); since = calls.length;
  await owner.click("Create invite code", sharing); await waitLookup();
  await owner.click("Unmount sharing");
  await fixture.repository.releaseRecipientLookup(); await waitInviteComplete(since); await delay(200);
  assert.equal(await owner.evaluate("Boolean(document.getElementById('invite-code'))"), false);
  pass("Unmount fences delayed invitation result without resurrecting private sharing UI");
  await owner.click("Mount sharing"); await owner.click("Share"); await owner.includes("Invite a person");
  await owner.select("Access", "thread", sharing); await owner.fill("Username or email", "johncena", sharing);
  let releaseResponse;
  responseHold = { entered: false, wait: new Promise(done => { releaseResponse = done; }), release: () => releaseResponse() };
  since = calls.length;
  await owner.click("Create invite code", sharing);
  for (let n = 0; !responseHold.entered && n < 100; n++) await delay(50);
  assert.equal(responseHold.entered, true);
  await owner.click("Sign out"); await owner.includes("Sign in");
  await login(owner, fixture.personas.recipient);
  responseHold.release(); responseHold = undefined;
  await waitInviteComplete(since); await delay(200);
  assert.equal((await owner.text()).includes("Invitation link"), false);
  assert.equal(await owner.evaluate("Boolean(document.getElementById('invite-code'))"), false);
  pass("Sign out/account switch clears owner private data and fences late response");
  const prepared = await fixture.owner(`/threads/${threads[1].id}/invitations`, { recipient: "johncena", role: "editor" });
  assert.equal(prepared.status, 201);
  const { token: delayedAcceptanceToken } = await prepared.json();
  await recipient.fill("Invite code", delayedAcceptanceToken, invitation);
  await recipient.click("Check invitation", invitation);
  await recipient.includes("Thread invitation for @johncena.");
  const callbacks = await recipient.evaluate("document.querySelector('output[aria-label=\"Global acceptance callbacks\"]').textContent");
  const completedAccepts = recipient.finished().filter(r => r.route?.endsWith("/accept")).length;
  responseHold = { suffix: "/accept", entered: false, wait: new Promise(done => { releaseResponse = done; }), release: () => releaseResponse() };
  await recipient.click("Accept invitation", invitation);
  for (let n = 0; !responseHold.entered && n < 100; n++) await delay(50);
  assert.equal(responseHold.entered, true);
  await recipient.click("Unmount invitation");
  responseHold.release(); responseHold = undefined;
  await recipient.wait(async () => recipient.finished().filter(r => r.route?.endsWith("/accept")).length > completedAccepts, "delayed acceptance actually received by browser");
  await delay(100);
  assert.equal(await recipient.evaluate("document.querySelector('output[aria-label=\"Global acceptance callbacks\"]').textContent"), callbacks);
  pass("Unmounted InvitationGate ignores delayed genuine acceptance result and parent callback");
  await owner.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await owner.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Narrow viewport fits");
  await owner.screenshot("recipient-mobile");
  pass("Recipient narrow viewport remains bounded");
  assert.equal(chromium.errors.length, 0, "No renderer exceptions");
  assert.equal(chromium.external.length, 0, "No renderer external transport");
  await writeFile(join(evidence, "results.json"), JSON.stringify({ results, calls, browserErrors: chromium.errors, blockedExternalOrigins: chromium.external, limits: ["Isolated Chromium, not Codex IAB or a human session", "Temporary real Worker/Better Auth/D1; synthetic provider and accounts; no live cloud or email", "QA adapter checks ephemeral origin then maps production relay admission to its fixed dev origin; exact production origin admission excluded", "Screenshots captured; Library 403 prevents claimed pixel inspection"] }, null, 2));
  for (const file of ["failure.json", "failure-owner.txt", "failure-owner.png"]) await rm(join(evidence, file), { force: true });
  console.log(`${results.length} browser scenarios passed; evidence ${evidence}`);
} catch (error) {
  await writeFile(join(evidence, "failure.json"), JSON.stringify({ error: String(error), results, calls }, null, 2));
  if (owner) { await owner.screenshot("failure-owner").catch(() => {}); await writeFile(join(evidence, "failure-owner.txt"), await owner.text().catch(() => "")); }
  throw error;
} finally {
  responseHold?.release();
  await fixture.repository.releaseRecipientLookup().catch(() => {});
  await chromium?.close(); server?.closeAllConnections();
  if (server) await new Promise(done => server.close(done));
  await fixture.mf.dispose(); await rm(buildDir, { recursive: true, force: true });
}
