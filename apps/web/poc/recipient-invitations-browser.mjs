import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export async function browser(origin, evidence) {
  const profile = await mkdtemp(join(tmpdir(), "pitcrew-recipient-browser-"));
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
  let ws;
  try {
    let port;
    for (let n = 0; n < 100; n++) {
      try {
        port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
        break;
      } catch {
        await delay(100);
      }
    }
    if (!port) throw Error("Empty-profile Chromium did not start");
    ws = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
    await new Promise((done, reject) => {
      ws.onopen = done;
      ws.onerror = reject;
    });
    let sequence = 0;
    const pending = new Map(),
      errors = [],
      external = [],
      requests = new Map(),
      finished = [];
    const call = (method, params = {}, sessionId) =>
      new Promise((done, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error(`CDP timeout ${method}`));
        }, 15000);
        pending.set(id, { done, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id) {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        msg.error ? p.reject(Error(msg.error.message)) : p.done(msg.result);
      }
      if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.text);
      if (msg.method === "Network.requestWillBeSent") {
        const route = new URL(msg.params.request.url).pathname.replace(
          /\/invitations\/[a-f0-9]{64}/g,
          "/invitations/:token",
        );
        requests.set(msg.sessionId + ":" + msg.params.requestId, route);
      }
      if (msg.method === "Network.loadingFinished")
        finished.push({
          sessionId: msg.sessionId,
          route: requests.get(msg.sessionId + ":" + msg.params.requestId),
        });
      if (msg.method === "Fetch.requestPaused") {
        const allowed = msg.params.request.url.startsWith(origin + "/");
        if (!allowed) external.push(new URL(msg.params.request.url).origin);
        void call(
          allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
          {
            requestId: msg.params.requestId,
            ...(!allowed ? { errorReason: "BlockedByClient" } : {}),
          },
          msg.sessionId,
        );
      }
    };
    const page = async () => {
      const { browserContextId } = await call("Target.createBrowserContext");
      const { targetId } = await call("Target.createTarget", {
        url: "about:blank",
        browserContextId,
      });
      const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
      const cdp = (method, params) => call(method, params, sessionId);
      for (const method of ["Page.enable", "Runtime.enable", "Network.enable"]) await cdp(method);
      await cdp("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const evaluate = async (expression) => {
        const r = await cdp("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (r.exceptionDetails)
          throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      };
      const text = () => evaluate("document.body?.innerText ?? ''");
      const wait = async (predicate, label) => {
        for (let n = 0; n < 200; n++) {
          if (await predicate()) return;
          await delay(50);
        }
        throw Error(`Timed out: ${label}`);
      };
      const includes = (phrase) => wait(async () => (await text()).includes(phrase), phrase);
      const root = (selector) =>
        selector ? `document.querySelector(${JSON.stringify(selector)})` : "document";
      const button = (name, scope) =>
        `[...(${root(scope)}?.querySelectorAll('button') ?? [])].find(el=>el.textContent.trim()===${JSON.stringify(name)})`;
      const label = (name, scope) =>
        `(()=>{const l=[...(${root(scope)}?.querySelectorAll('label') ?? [])].find(el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()===${JSON.stringify(name)});return l?.control ?? l?.querySelector('input,textarea,select')})()`;
      const clickElement = async (source) => {
        await wait(
          () => evaluate(`Boolean((${source}) && !(${source}).disabled)`),
          "enabled rendered control",
        );
        let rect;
        await wait(async () => {
          rect = await evaluate(
            `(async()=>{const el=${source};if(!el || el.disabled)return null;el.scrollIntoView({block:'center',behavior:'instant'});await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));if(!el.isConnected || el.disabled)return null;const r=el.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,
          );
          return !!rect;
        }, "stable rendered control");
        const hit = await evaluate(
          `(()=>{const el=${source};const hit=document.elementFromPoint(${rect.x},${rect.y});return el===hit||el?.contains(hit);})()`,
        );
        if (!hit) throw Error(`Rendered control is covered: ${source}`);
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
      return {
        cdp,
        evaluate,
        text,
        wait,
        includes,
        button,
        label,
        finished: () => finished.filter((r) => r.sessionId === sessionId),
        click: (name, scope) => clickElement(button(name, scope)),
        fill: async (name, value, scope) => {
          await clickElement(label(name, scope));
          await evaluate(`(${label(name, scope)}).select()`);
          await cdp("Input.insertText", { text: value });
        },
        select: async (name, value, scope) => {
          await clickElement(label(name, scope));
          await evaluate(
            `(()=>{const el=${label(name, scope)};el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
          );
        },
        navigate: (query) => cdp("Page.navigate", { url: origin + "/" + (query ?? "") }),
        screenshot: async (name) => {
          const r = await cdp("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
          });
          await writeFile(join(evidence, name + ".png"), Buffer.from(r.data, "base64"));
        },
      };
    };
    return {
      page,
      errors,
      external,
      close: async () => {
        ws.close();
        chrome.kill();
        await Promise.race([new Promise((done) => chrome.once("exit", done)), delay(3000)]);
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      },
    };
  } catch (error) {
    ws?.close();
    chrome.kill();
    await delay(200);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
}
