import {
  readVisualizationContent,
  documentFragment,
  scopeId,
  text,
  VisualizationError,
  VISUALIZATION_LIMITS,
  type VisualizationRecord,
  type VisualizationEnvelope,
} from "../../../packages/protocol/src/visualizations";
import type { VisualizationStore } from "./visualization-store";

export type VisualizationPrincipal = { actor: string; accessEpoch: string; expiresAt: number };
export type VisualizationContext = {
  actor: string;
  repositoryId: string;
  threadId: string;
};
export type VisualizationPublisher = VisualizationContext & {
  turnId: string;
  invocationId: string;
};
export interface VisualizationAuthority {
  // Must consult current verified account/session, with no cookie-cache authority.
  session(request: Request): Promise<VisualizationPrincipal | undefined>;
  // Must check current project AND thread membership. Never optional or fixture-fallback.
  requireThread(context: VisualizationContext): void;
}
const digest = async (value: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
export async function publishVisualization(
  store: VisualizationStore,
  context: VisualizationPublisher,
  input: unknown,
  freshAuthority: () => Promise<void>,
  liveFence: () => void,
): Promise<VisualizationRecord> {
  context = Object.freeze({ ...context });
  if (
    !scopeId(context.repositoryId) ||
    !scopeId(context.threadId) ||
    !text(context.actor, 256, true) ||
    !scopeId(context.turnId) ||
    !text(context.invocationId, 200, true)
  )
    throw new VisualizationError("invalid_visualization");
  await freshAuthority();
  liveFence();
  const content = readVisualizationContent(input);
  // Also bound escaped XHTML expansion before retaining a structured document.
  if (content.kind === "document") documentFragment(content);
  const [hashed, key] = await Promise.all([
    digest(JSON.stringify(content)),
    digest(JSON.stringify([context.turnId, context.invocationId])),
  ]);
  await freshAuthority();
  liveFence();
  return store.put(
    {
      id: crypto.randomUUID(),
      version: 1,
      repositoryId: context.repositoryId,
      threadId: context.threadId,
      creatorActor: context.actor,
      turnId: context.turnId,
      invocationId: context.invocationId,
      createdAt: Date.now(),
      revision: 1,
      digest: hashed,
      content,
    },
    key,
    liveFence,
  );
}
const response = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    },
  });
// New isolated route adapter: unmatched paths return undefined to the existing API.
// JSON only; generated pages are never served as navigable HTML or public asset URLs.
export async function visualizationRequest(
  request: Request,
  store: VisualizationStore,
  authority: VisualizationAuthority,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = /^\/api\/projects\/([^/]+)\/threads\/([^/]+)\/visualizations(?:\/([^/]+))?$/.exec(
    url.pathname,
  );
  if (!match) return;
  try {
    const [, repositoryId, threadId, id] = match;
    if (
      !scopeId(repositoryId) ||
      !scopeId(threadId) ||
      (id !== undefined && !scopeId(id)) ||
      url.search
    )
      throw new VisualizationError("not_found", 404);
    // Public creation is disabled: only admitted tool execution may publish.
    if (request.method !== "GET") throw new VisualizationError("method_not_allowed", 405);
    if (
      request.headers.get("sec-fetch-mode") === "navigate" ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new VisualizationError("forbidden", 403);
    const initial = await authority.session(request);
    if (!initial || initial.expiresAt <= Date.now())
      throw new VisualizationError("unauthorized", 401);
    const context = { actor: initial.actor, repositoryId, threadId };
    const fence = () => {
      if (initial.expiresAt <= Date.now()) throw new VisualizationError("unauthorized", 401);
      authority.requireThread(context);
    };
    const fresh = async () => {
      const current = await authority.session(request);
      if (
        !current ||
        current.actor !== initial.actor ||
        current.accessEpoch !== initial.accessEpoch ||
        current.expiresAt <= Date.now()
      )
        throw new VisualizationError("unauthorized", 401);
      fence();
    };
    fence();
    await fresh();
    const artifacts = id
      ? [store.get(repositoryId, threadId, id)].filter((a): a is VisualizationRecord => !!a)
      : store.list(repositoryId, threadId);
    if (id && !artifacts.length) throw new VisualizationError("not_found", 404);
    await fresh();
    fence();
    const leaseMs = Math.min(
      VISUALIZATION_LIMITS.leaseMs,
      Math.floor(initial.expiresAt - Date.now()),
    );
    if (leaseMs <= 0) throw new VisualizationError("unauthorized", 401);
    const envelope: VisualizationEnvelope = {
      accountId: initial.actor,
      repositoryId,
      threadId,
      accessEpoch: initial.accessEpoch,
      leaseMs,
      artifacts,
    };
    return response(envelope);
  } catch (error) {
    const known = error instanceof VisualizationError;
    const admission = error && typeof error === "object" && "status" in error && "code" in error;
    return response(
      {
        error: known
          ? error.code
          : admission
            ? (error as { code: string }).code
            : "visualization_unavailable",
      },
      known ? error.status : admission ? (error as { status: number }).status : 503,
    );
  }
}
