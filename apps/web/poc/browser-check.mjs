// Dedicated, empty browser profile and fixture server. No user sessions or APIs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fixtureVisualizationService } from "./dist/security-service.mjs";

if (!process.argv[2])
  throw Error("Provide the prepared security artifact temporary output directory.");
const evidence = resolve(process.argv[2]);
await readFile(resolve("apps/web/poc/dist/index.html"));
await mkdir(evidence, { recursive: true });
const service = await fixtureVisualizationService();
const hits = [];
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(req.method === "GET" ? {} : { body: Readable.toWeb(req), duplex: "half" }),
    });
    const result = await service.request(request);
    res.writeHead(result?.status ?? 404, Object.fromEntries(result?.headers ?? []));
    res.end(result ? await result.text() : "missing");
    return;
  }
  if (req.url === "/fixture/revoke" && req.method === "POST") {
    service.revoke();
    res.end("revoked");
    return;
  }
  if (req.url.startsWith("/sentinel")) {
    hits.push({
      path: req.url,
      fixtureCookieSent: (req.headers.cookie ?? "").includes("fixture-private=value"),
    });
    res.end("local navigation sentinel");
    return;
  }
  const file = ["/", "/secure", "/polling"].includes(req.url) ? "index.html" : req.url.slice(1);
  if (
    ![
      "index.html",
      "visualizations.js",
      "visualizations.css",
      "security.js",
      "security.css",
      "polling.js",
      "polling.css",
      "counterexample",
    ].includes(file)
  ) {
    res.writeHead(404).end();
    return;
  }
  if (file === "counterexample") {
    const child = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-test'; connect-src 'none'; form-action 'none'; base-uri 'none'"><script nonce="test">location.href='http://127.0.0.1:${server.address().port}/sentinel?own-frame-navigation'</script>`;
    res.setHeader("content-type", "text/html");
    res.end(
      `<iframe sandbox="allow-scripts" srcdoc="${child.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`,
    );
    return;
  }
  res.setHeader(
    "content-type",
    file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html",
  );
  res.setHeader("cache-control", "no-store");
  const body = await readFile(resolve("apps/web/poc/dist", file));
  res.end(
    req.url === "/secure" || req.url === "/polling"
      ? body
          .toString()
          .replaceAll("visualizations.js", req.url === "/secure" ? "security.js" : "polling.js")
          .replaceAll("visualizations.css", req.url === "/secure" ? "security.css" : "polling.css")
      : body,
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "pitcrew-viz-browser-"));
const chrome = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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
let ws;
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
  assert.ok(port, "Dedicated browser started");
  ws = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
  await new Promise((done, reject) => {
    ws.onopen = done;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  const contexts = new Map();
  const network = [];
  let childSetupError;
  const childSetupTasks = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const pair = pending.get(message.id);
      if (!pair) return;
      pending.delete(message.id);
      clearTimeout(pair.timeout);
      if (message.error) pair.reject(Error(message.error.message));
      else pair.resolve(message.result);
    } else if (message.method === "Runtime.executionContextCreated") {
      contexts.set(`${message.sessionId}:${message.params.context.id}`, {
        ...message.params.context,
        sessionId: message.sessionId,
      });
    } else if (message.method === "Runtime.executionContextDestroyed") {
      contexts.delete(`${message.sessionId}:${message.params.executionContextId}`);
    } else if (message.method === "Runtime.executionContextsCleared") {
      for (const [key, context] of contexts)
        if (context.sessionId === message.sessionId) contexts.delete(key);
    } else if (message.method === "Target.detachedFromTarget") {
      const detached = message.params.sessionId;
      for (const [id, pair] of pending)
        if (pair.sessionId === detached) {
          pending.delete(id);
          clearTimeout(pair.timeout);
          pair.reject(Error("Session with given id not found."));
        }
      for (const [key, context] of contexts)
        if (context.sessionId === detached) contexts.delete(key);
    } else if (
      message.method === "Target.attachedToTarget" &&
      message.params.targetInfo.type === "iframe"
    ) {
      // Paging can dispose a frame before its asynchronous debugger attachment finishes.
      childSetupTasks.push(
        Promise.allSettled([
          call("Runtime.enable", {}, message.params.sessionId),
          call("Network.enable", {}, message.params.sessionId),
        ]).then((results) => {
          for (const result of results)
            if (
              result.status === "rejected" &&
              result.reason?.message !== "Session with given id not found."
            )
              childSetupError ??= result.reason ?? Error("Unknown child debugger setup error");
        }),
      );
    } else if (message.method === "Network.requestWillBeSent")
      network.push(message.params.request.url);
  };
  function call(method, params = {}, sessionId) {
    const id = ++sequence;
    return new Promise((resolveCall, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(Error(`Debugger command timed out: ${method}`));
      }, 10000);
      pending.set(id, { resolve: resolveCall, reject, sessionId, timeout });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  const cdp = (method, params) => call(method, params, sessionId);
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  await cdp("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1180,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Network.setCookie", {
    name: "fixture-private",
    value: "value",
    url: origin,
    sameSite: "Lax",
  });
  await cdp("Page.navigate", { url: origin });
  async function evaluate(expression, contextId) {
    const result = await call(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(contextId ? { contextId: contextId.id } : {}),
      },
      contextId?.sessionId ?? sessionId,
    );
    if (result.exceptionDetails)
      throw Error(
        result.exceptionDetails.text + ": " + result.exceptionDetails.exception?.description,
      );
    return result.result.value;
  }
  async function until(expression, attempts = 100) {
    for (let i = 0; i < attempts; i++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw Error(`Timed out: ${expression}`);
  }
  async function childContext() {
    for (let i = 0; i < 100; i++) {
      const { targetInfos } = await call("Target.getTargets");
      const frameId = targetInfos.find(
        (target) =>
          target.type === "iframe" && target.parentId === targetId && target.url === "about:srcdoc",
      )?.targetId;
      const found = [...contexts.values()].find(
        (context) => context.auxData?.isDefault && context.auxData.frameId === frameId,
      );
      if (found) return found;
      await delay(50);
    }
    console.log(
      JSON.stringify(
        {
          frameTree: await cdp("Page.getFrameTree"),
          contexts: [...contexts.values()],
          targets: await call("Target.getTargets"),
        },
        null,
        2,
      ),
    );
    throw Error("Missing frame execution context");
  }
  async function click(text) {
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`,
    );
  }
  async function screenshot(name) {
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await writeFile(join(evidence, name), Buffer.from(data, "base64"));
  }
  await until("!!document.querySelector('.pitcrew-visualization iframe')");
  let child = await childContext();
  assert.equal(
    await evaluate("getComputedStyle(document.documentElement).backgroundColor", child),
    "rgb(247, 247, 248)",
  );
  assert.equal(await evaluate("document.querySelectorAll('tbody tr').length", child), 4);
  await evaluate(
    "document.getElementById('minimum').value='20';document.getElementById('minimum').dispatchEvent(new Event('input'))",
    child,
  );
  assert.equal(
    await evaluate("document.querySelectorAll('tbody tr:not([hidden])').length", child),
    2,
  );
  await evaluate("document.getElementById('sort').click()", child);
  assert.equal(await evaluate("document.querySelector('tbody tr').dataset.value", child), "12");
  await evaluate(
    "document.getElementById('minimum').value='0';document.getElementById('minimum').dispatchEvent(new Event('input'))",
    child,
  );
  await screenshot("thread-light.png");
  const isolation = await evaluate(
    `(()=>{let parentBlocked=false,storageBlocked=false;try{parent.document.cookie}catch{parentBlocked=true}try{localStorage.getItem('x')}catch{storageBlocked=true}return {parentBlocked,storageBlocked}})()`,
    child,
  );
  assert.deepEqual(isolation, { parentBlocked: true, storageBlocked: true });
  const blockedFetch = await evaluate(
    `fetch(${JSON.stringify(origin + "/sentinel?fetch")},{credentials:'include'}).then(()=>false,()=>true)`,
    child,
  );
  assert.equal(blockedFetch, true);
  await evaluate(
    `(()=>{let s=document.createElement('script');s.textContent='globalThis.generatedScriptRan=true';document.body.append(s);let i=new Image();i.src=${JSON.stringify(origin + "/sentinel?image")};document.body.append(i);parent.postMessage({type:'resize',height:999999,method:'ui/open-link',url:${JSON.stringify(origin + "/sentinel?message")}},'*')})()`,
    child,
  );
  await delay(100);
  assert.equal(await evaluate("globalThis.generatedScriptRan === undefined", child), true);
  assert.equal(await evaluate("document.querySelector('iframe').clientHeight"), 358);
  assert.deepEqual(hits, []);
  await click("Dark theme");
  await until("document.documentElement.style.colorScheme==='dark'");
  child = await childContext();
  assert.equal(
    await evaluate("getComputedStyle(document.documentElement).backgroundColor", child),
    "rgb(24, 25, 28)",
  );
  await click("Open in workspace");
  await until("!!document.querySelector('aside iframe')");
  child = await childContext();
  assert.equal(await evaluate("document.querySelectorAll('tbody tr').length", child), 4);
  await screenshot("workspace-dark.png");
  await click("Try blocked content");
  await until("!document.querySelector('iframe')");
  assert.equal(await evaluate("!!document.querySelector('.visualization-description')"), true);
  assert.deepEqual(hits, []);
  await click("Simulate access loss");
  await until("!document.querySelector('.visualization-description')");
  await click("Restore demo access");
  await click("Show chart");
  await until("!!document.querySelector('iframe')");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= 390"), true);
  await screenshot("workspace-mobile.png");
  await click("Show HTML summary");
  await until(
    "!!document.querySelector('iframe') && document.querySelector('iframe').title==='A visual planning note'",
  );
  assert.equal(await evaluate("document.querySelector('iframe').getAttribute('sandbox')"), "");
  child = await childContext();
  assert.equal(
    await evaluate("document.querySelectorAll('script, a, img, iframe, form').length", child),
    0,
  );
  assert.equal(await evaluate("!!document.querySelector('details summary')", child), true);
  await screenshot("html-mobile.png");
  await cdp("Page.navigate", { url: origin + "/secure" });
  await until(
    "Array.from(document.querySelectorAll('[role=tab]')).some(b=>b.textContent.includes('Visuals'))",
  );
  await evaluate(
    "Array.from(document.querySelectorAll('[role=tab]')).find(b=>b.textContent.includes('Visuals')).click()",
  );
  await until("document.querySelectorAll('iframe').length===2");
  const firstPageTitles = await evaluate(
    "Array.from(document.querySelectorAll('iframe')).map(f=>f.title)",
  );
  await evaluate("document.querySelector('[aria-label=\"Next visualizations\"]').click()");
  await until("document.querySelectorAll('iframe').length===1");
  const secondPageTitles = await evaluate(
    "Array.from(document.querySelectorAll('iframe')).map(f=>f.title)",
  );
  assert.deepEqual(
    new Set([...firstPageTitles, ...secondPageTitles]),
    new Set(["Server admitted chart", "Server admitted note", "Server admitted third chart"]),
  );
  assert.equal(
    await evaluate("document.querySelector('[aria-label=\"Next visualizations\"]').disabled"),
    true,
  );
  await evaluate("document.querySelector('[aria-label=\"Previous visualizations\"]').click()");
  await until("document.querySelectorAll('iframe').length===2");
  const beforeRenew = await evaluate("document.querySelector('iframe').getAttribute('srcdoc')");
  await delay(3000);
  assert.equal(
    await evaluate("document.querySelector('iframe').getAttribute('srcdoc')"),
    beforeRenew,
  );
  await evaluate(
    "Array.from(document.querySelectorAll('[role=tab]')).find(b=>b.textContent.includes('Files')).click()",
  );
  await until("document.querySelectorAll('iframe').length===0");
  assert.equal(
    await evaluate("document.body.textContent.includes('Private server description')"),
    false,
  );
  await evaluate(
    "Array.from(document.querySelectorAll('[role=tab]')).find(b=>b.textContent.includes('Visuals')).click()",
  );
  await until("document.querySelectorAll('iframe').length===2");
  await evaluate("document.querySelector('[aria-label=\"Collapse workspace\"]').click()");
  await until("document.querySelectorAll('iframe').length===0");
  assert.equal(
    await evaluate("document.body.textContent.includes('Private server description')"),
    false,
  );
  await evaluate("document.querySelector('[aria-label=\"Expand workspace\"]').click()");
  await until("document.querySelectorAll('iframe').length===2");
  const securePath = "/api/projects/pitcrew/threads/visualization/visualizations";
  const denied = await evaluate(
    `fetch(${JSON.stringify(securePath)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:'hostile',content:{kind:'document',title:'Bad',summary:'Bad',height:320,nodes:[{tag:'script',children:[{text:"location='/sentinel'"}]}]}})}).then(r=>r.status)`,
  );
  assert.equal(denied, 405);
  assert.equal(await evaluate("document.querySelectorAll('iframe').length"), 2);
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('iframe')).every(f=>!f.getAttribute('sandbox').includes('allow-same-origin'))",
    ),
    true,
  );
  if (
    !(await evaluate(
      "!!Array.from(document.querySelectorAll('iframe')).find(f=>f.title==='Server admitted note')",
    ))
  ) {
    await evaluate("document.querySelector('[aria-label=\"Next visualizations\"]').click()");
    await until("document.querySelectorAll('iframe').length===1");
  }
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('iframe')).find(f=>f.title==='Server admitted note').getAttribute('srcdoc').includes('&lt;script')",
    ),
    true,
  );
  await screenshot("private-admission-mobile.png");
  await click("Revoke fixture membership");
  await until("document.querySelectorAll('iframe').length===0");
  assert.equal(
    await evaluate(
      "document.body.textContent.includes('Private server description') || document.body.textContent.includes('Private document description') || document.body.textContent.includes('Private third description')",
    ),
    false,
  );
  assert.deepEqual(hits, []);
  const productionHits = [...hits];
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1180,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Page.navigate", { url: origin + "/polling" });
  await until(
    "Array.from(document.querySelectorAll('[role=tab]')).some(b=>b.textContent.includes('Visuals'))",
  );
  await evaluate(
    "Array.from(document.querySelectorAll('[role=tab]')).find(b=>b.textContent.includes('Visuals')).click()",
  );
  await until("document.querySelectorAll('iframe').length===2");
  await evaluate("document.querySelector('[aria-label=\"Next visualizations\"]').click()");
  await until("document.querySelectorAll('iframe').length===1");
  child = await childContext();
  await evaluate(
    "document.getElementById('minimum').value='12';document.getElementById('minimum').dispatchEvent(new Event('input'))",
    child,
  );
  await evaluate(
    "window.visualizationPollingFrame=document.querySelector('iframe');window.visualizationPollingStart=visualizationPollingObservation.polls",
  );
  await screenshot("polling-page-before.png");
  for (let poll = 1; poll <= 3; poll++) {
    await until(
      `visualizationPollingObservation.polls >= visualizationPollingStart + ${poll}`,
      600,
    );
    await delay(100);
    await screenshot("polling-page-after.png");
    assert.equal(
      await evaluate("document.querySelector('iframe')===visualizationPollingFrame"),
      true,
      "unchanged membership poll preserves the iframe",
    );
    assert.equal(await evaluate("document.body.textContent.includes('Page 2 of 2')"), true);
    assert.equal(await evaluate("document.getElementById('minimum').value", child), "12");
  }
  await evaluate("visualizationPollingFixture.failNextRead()");
  await until("document.querySelectorAll('iframe').length===0");
  assert.equal(
    await evaluate("document.body.textContent.includes('Private polling description')"),
    false,
  );
  await evaluate(
    "window.visualizationPollingFailedReads=visualizationPollingFixture.counts.visualizations",
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Retry visualizations').focus()",
  );
  assert.equal(await evaluate("document.activeElement.textContent"), "Retry visualizations");
  await screenshot("polling-read-unavailable.png");
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    unmodifiedText: "\r",
    windowsVirtualKeyCode: 13,
  });
  await cdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await until(
    "visualizationPollingFixture.counts.visualizations===visualizationPollingFailedReads+1",
  );
  await until("document.querySelectorAll('iframe').length===1");
  assert.equal(await evaluate("document.body.textContent.includes('Page 2 of 2')"), true);
  assert.equal(
    await evaluate(
      "visualizationPollingFixture.counts.visualizations===visualizationPollingFailedReads+1",
    ),
    true,
  );
  assert.equal(
    await evaluate("document.querySelector('iframe')===visualizationPollingFrame"),
    false,
  );
  await screenshot("polling-read-recovery.png");
  await evaluate("visualizationPollingFixture.revoke()");
  await until("document.querySelectorAll('iframe').length===0");
  assert.equal(
    await evaluate("document.body.textContent.includes('Private polling description')"),
    false,
  );
  await evaluate(
    "window.visualizationPollingRevokedReads=visualizationPollingFixture.counts.visualizations",
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Retry visualizations').click()",
  );
  await until(
    "visualizationPollingFixture.counts.visualizations===visualizationPollingRevokedReads+1",
  );
  assert.equal(await evaluate("document.querySelectorAll('iframe').length"), 0);
  assert.equal(
    await evaluate("document.body.textContent.includes('Private polling description')"),
    false,
  );
  assert.deepEqual(hits, []);
  // Evidence for why arbitrary generated scripts are deliberately excluded.
  await cdp("Page.navigate", { url: origin + "/counterexample" });
  for (let i = 0; i < 100 && !hits.length; i++) await delay(50);
  assert.ok(
    hits.some((hit) => hit.path.includes("own-frame-navigation")),
    "Opaque sandbox+CSP still permits own-frame navigation",
  );
  await cdp("Target.setAutoAttach", {
    autoAttach: false,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await Promise.all(childSetupTasks);
  assert.equal(childSetupError, undefined, "Child debugger setup had no unexpected error");
  const report = {
    browser: await call("Browser.getVersion"),
    checks: [
      "trusted chart runtime filter/sort",
      "light/dark theme",
      "thread/workspace",
      "mobile width",
      "opaque parent/storage isolation",
      "CSP blocks credentialed fetch/image and nonnonce script",
      "no message bridge accepts fake resize/link",
      "rejected generated content uses text fallback",
      "revocation removes fallback and frame",
      "legitimate HTML has no script permission and uses native details control",
      "public HTTP writes denied; trusted structured publication escapes hostile text",
      "scoped JSON service mounts at most two previews",
      "all admitted artifacts are reachable through bounded preview pages",
      "actual workspace tab switch/collapse dispose private text and frames",
      "authorization renewal preserves immutable preview controls",
      "remote membership revocation removes running frames and private text on revalidation",
      "actual App preserves page and chart controls across three real 15-second membership polls",
      "temporary visualization read failure clears private content; keyboard Retry requires a fresh read",
      "actual App membership revocation removes frames and private fallback",
      "Retry cannot restore revoked visualizations",
    ],
    productionFixtureSentinelHits: productionHits,
    counterexample: hits,
    screenshots: [
      "thread-light.png",
      "workspace-dark.png",
      "workspace-mobile.png",
      "html-mobile.png",
      "private-admission-mobile.png",
      "polling-page-before.png",
      "polling-page-after.png",
      "polling-read-unavailable.png",
      "polling-read-recovery.png",
    ],
    limitations:
      "Chromium only; local service account/session authorization is simulated. Private SQL/API and disposal are exercised with fixtures, not a deployed account system. No arbitrary generated JS or production deployment. The own-frame navigation counterexample remains unsafe and outside the supported content contract.",
  };
  await writeFile(join(evidence, "browser-check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await call("Browser.close");
} finally {
  ws?.close();
  chrome.kill("SIGTERM");
  await new Promise((done) => server.close(done));
  service.close();
  await delay(100);
  await rm(profile, { recursive: true, force: true });
}
