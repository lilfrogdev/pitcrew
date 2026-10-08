import { createServer } from "node:http";
import { ExecutionError, LocalBaselineFork, LocalGitWorkspace, resolveLocalPaths } from "../packages/execution/src/index.ts";

const token = process.env.LOCAL_EXECUTOR_TOKEN ?? "local-agent-v1";
const port = Number(process.env.LOCAL_EXECUTOR_PORT ?? 8791);
const paths = resolveLocalPaths(
  process.env.LOCAL_FIXTURE_DIR ?? "fixtures/baseline",
  process.env.LOCAL_WORKSPACE_ROOT ?? ".wrangler/local-workspaces",
);
const workspaces = new LocalGitWorkspace(paths.root);
const forks = new LocalBaselineFork(paths.fixture, workspaces);

const operations = {
  async fork(body) {
    await forks.fork(body.source, body.target, body.baseSha);
  },
  async prepare(body) {
    await workspaces.prepare(body.workspace);
  },
  run(body, signal) {
    return workspaces.run(body.workspace, body.command, signal);
  },
  inspect(body) {
    return workspaces.inspect(body.workspace);
  },
  async publish(body) {
    await workspaces.publish(body.workspace, body.candidateSha);
  },
  readFile(body) {
    return workspaces.readFile(body.workspace, body.path);
  },
  async writeFile(body) {
    await workspaces.writeFile(body.workspace, body.path, body.content);
  },
  stop(body) {
    return workspaces.stop(body.workspace);
  },
  duplicate(body) {
    return workspaces.duplicate(body.source, body.target);
  },
  discard(body) {
    return workspaces.discard(body.workspace);
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > 1_048_576) {
        reject(new ExecutionError("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ExecutionError("INVALID_BODY"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const send = (status, body) => {
    if (res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST" || req.headers["x-pitcrew-local-executor"] !== token) {
    send(403, { ok: false, error: "executor_forbidden" });
    return;
  }
  const op = operations[new URL(req.url ?? "/", "http://127.0.0.1").pathname.slice(1)];
  if (!op) {
    send(404, { ok: false, error: "executor_unknown" });
    return;
  }
  const abort = new AbortController();
  let finished = false;
  res.on("finish", () => {
    finished = true;
  });
  res.on("close", () => {
    if (!finished) abort.abort();
  });
  try {
    const result = await op(await readBody(req), abort.signal);
    send(200, { ok: true, result: result ?? null });
  } catch (error) {
    const code = error instanceof ExecutionError ? error.code : "executor_failed";
    console.error(JSON.stringify({ event: "local_executor", error: code }));
    send(400, { ok: false, error: code });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      event: "local_executor_ready",
      port,
      fixture: paths.fixture,
      root: paths.root,
    }),
  );
});
