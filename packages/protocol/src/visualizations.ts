import { validAttachmentText } from "./attachments";

export const VISUALIZATION_LIMITS = {
  contentBytes: 65536,
  requestBytes: 98304,
  recordBytes: 98304,
  threadCount: 10,
  threadBytes: 524288,
  repositoryCount: 100,
  repositoryBytes: 4194304,
  nodes: 512,
  depth: 12,
  points: 32,
  frames: 2,
  leaseMs: 5000,
} as const;
export const DOCUMENT_TAGS = [
  "article",
  "section",
  "div",
  "p",
  "span",
  "h2",
  "h3",
  "h4",
  "strong",
  "em",
  "small",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "table",
  "caption",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "details",
  "summary",
  "br",
  "hr",
] as const;
export type DocumentNode =
  | { text: string }
  | {
      tag: (typeof DOCUMENT_TAGS)[number];
      children?: DocumentNode[];
      class?: "viz-card" | "viz-grid" | "viz-muted" | "viz-accent";
      ariaLabel?: string;
      scope?: "row" | "col";
    };
type Description = { title: string; summary: string; height: number };
export type VisualizationContent = Description &
  (
    | { kind: "bars"; points: { label: string; value: number }[] }
    | { kind: "document"; nodes: DocumentNode[] }
  );
export type VisualizationRecord = {
  id: string;
  version: 1;
  repositoryId: string;
  threadId: string;
  creatorActor: string;
  turnId: string;
  invocationId: string;
  createdAt: number;
  revision: 1;
  digest: string;
  content: VisualizationContent;
};
export type VisualizationEnvelope = {
  accountId: string;
  repositoryId: string;
  threadId: string;
  accessEpoch: string;
  leaseMs: number;
  artifacts: VisualizationRecord[];
};
export class VisualizationError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const encodedBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function scopeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
}
export function text(value: unknown, max: number, nonempty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    validAttachmentText(value) &&
    (!nonempty || !!value.trim())
  );
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new VisualizationError("invalid_visualization");
  return value as Record<string, unknown>;
}
export function readVisualizationContent(value: unknown): VisualizationContent {
  // Bound before traversing the tree. HTTP callers additionally bound raw body bytes.
  if (encodedBytes(value) > VISUALIZATION_LIMITS.contentBytes)
    throw new VisualizationError("visualization_too_large", 413);
  const v = object(value, ["kind", "title", "summary", "height", "points", "nodes"]);
  if (
    !text(v.title, 160, true) ||
    !text(v.summary, 4000, true) ||
    !Number.isInteger(v.height) ||
    (v.height as number) < 160 ||
    (v.height as number) > 640
  )
    throw new VisualizationError("invalid_visualization");
  const base = { title: v.title, summary: v.summary, height: v.height as number };
  if (
    v.kind === "bars" &&
    v.nodes === undefined &&
    Array.isArray(v.points) &&
    v.points.length > 0 &&
    v.points.length <= VISUALIZATION_LIMITS.points
  ) {
    const points = v.points.map((value) => {
      const point = object(value, ["label", "value"]);
      if (
        !text(point.label, 100, true) ||
        typeof point.value !== "number" ||
        !Number.isFinite(point.value) ||
        point.value < 0 ||
        point.value > 1000000
      )
        throw new VisualizationError("invalid_visualization");
      return { label: point.label, value: point.value };
    });
    return { ...base, kind: "bars", points };
  }
  if (v.kind !== "document" || v.points !== undefined || !Array.isArray(v.nodes) || !v.nodes.length)
    throw new VisualizationError("invalid_visualization");
  let count = 0;
  const node = (input: unknown, depth: number): DocumentNode => {
    if (++count > VISUALIZATION_LIMITS.nodes || depth > VISUALIZATION_LIMITS.depth)
      throw new VisualizationError("visualization_complexity", 413);
    const n = object(input, ["text", "tag", "children", "class", "ariaLabel", "scope"]);
    if ("text" in n) {
      if (Object.keys(n).length !== 1 || !text(n.text, VISUALIZATION_LIMITS.contentBytes))
        throw new VisualizationError("invalid_visualization");
      return { text: n.text };
    }
    if (
      !DOCUMENT_TAGS.includes(n.tag as never) ||
      (n.class !== undefined &&
        !["viz-card", "viz-grid", "viz-muted", "viz-accent"].includes(n.class as string)) ||
      (n.ariaLabel !== undefined && !text(n.ariaLabel, 200)) ||
      (n.scope !== undefined && (n.tag !== "th" || !["row", "col"].includes(n.scope as string))) ||
      (n.children !== undefined && !Array.isArray(n.children)) ||
      (["br", "hr"].includes(n.tag as string) && n.children !== undefined)
    )
      throw new VisualizationError("invalid_visualization");
    return {
      tag: n.tag as (typeof DOCUMENT_TAGS)[number],
      ...(n.class === undefined ? {} : { class: n.class as "viz-card" }),
      ...(n.ariaLabel === undefined ? {} : { ariaLabel: n.ariaLabel as string }),
      ...(n.scope === undefined ? {} : { scope: n.scope as "row" }),
      ...(n.children === undefined
        ? {}
        : { children: (n.children as unknown[]).map((child) => node(child, depth + 1)) }),
    };
  };
  return { ...base, kind: "document", nodes: v.nodes.map((child) => node(child, 1)) };
}
export function readVisualizationRecord(value: unknown): VisualizationRecord {
  if (encodedBytes(value) > VISUALIZATION_LIMITS.recordBytes)
    throw new VisualizationError("invalid_visualization");
  const v = object(value, [
    "id",
    "version",
    "repositoryId",
    "threadId",
    "creatorActor",
    "turnId",
    "invocationId",
    "createdAt",
    "revision",
    "digest",
    "content",
  ]);
  if (
    !scopeId(v.id) ||
    !scopeId(v.repositoryId) ||
    !scopeId(v.threadId) ||
    !text(v.creatorActor, 256, true) ||
    !scopeId(v.turnId) ||
    !text(v.invocationId, 200, true) ||
    v.version !== 1 ||
    v.revision !== 1 ||
    !Number.isSafeInteger(v.createdAt) ||
    (v.createdAt as number) < 0 ||
    typeof v.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.digest)
  )
    throw new VisualizationError("invalid_visualization");
  const content = readVisualizationContent(v.content);
  if (content.kind === "document") documentFragment(content);
  return {
    id: v.id,
    version: 1,
    repositoryId: v.repositoryId,
    threadId: v.threadId,
    creatorActor: v.creatorActor,
    turnId: v.turnId,
    invocationId: v.invocationId,
    createdAt: v.createdAt as number,
    revision: 1,
    digest: v.digest,
    content,
  };
}
export function readVisualizationEnvelope(value: unknown): VisualizationEnvelope {
  if (encodedBytes(value) > VISUALIZATION_LIMITS.threadBytes + 4096)
    throw new VisualizationError("invalid_visualization");
  const v = object(value, [
    "accountId",
    "repositoryId",
    "threadId",
    "accessEpoch",
    "leaseMs",
    "artifacts",
  ]);
  if (
    !text(v.accountId, 256, true) ||
    !scopeId(v.repositoryId) ||
    !scopeId(v.threadId) ||
    !text(v.accessEpoch, 200, true) ||
    !Number.isInteger(v.leaseMs) ||
    (v.leaseMs as number) <= 0 ||
    (v.leaseMs as number) > VISUALIZATION_LIMITS.leaseMs ||
    !Array.isArray(v.artifacts) ||
    v.artifacts.length > VISUALIZATION_LIMITS.threadCount
  )
    throw new VisualizationError("invalid_visualization");
  const artifacts = v.artifacts.map(readVisualizationRecord);
  if (
    new Set(artifacts.map((a) => a.id)).size !== artifacts.length ||
    artifacts.some((a) => a.repositoryId !== v.repositoryId || a.threadId !== v.threadId) ||
    artifacts.reduce((sum, a) => sum + encodedBytes(a), 0) > VISUALIZATION_LIMITS.threadBytes
  )
    throw new VisualizationError("invalid_visualization");
  return {
    accountId: v.accountId,
    repositoryId: v.repositoryId,
    threadId: v.threadId,
    accessEpoch: v.accessEpoch,
    leaseMs: v.leaseMs as number,
    artifacts,
  };
}
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export function documentFragment(content: VisualizationContent): string {
  const checked = readVisualizationContent(content);
  if (checked.kind !== "document") throw new VisualizationError("invalid_visualization");
  const render = (n: DocumentNode): string =>
    "text" in n
      ? escape(n.text)
      : `<${n.tag}${n.class ? ` class="${n.class}"` : ""}${n.ariaLabel ? ` aria-label="${escape(n.ariaLabel)}"` : ""}${n.scope ? ` scope="${n.scope}"` : ""}${["br", "hr"].includes(n.tag) ? "/>" : `>${(n.children ?? []).map(render).join("")}</${n.tag}>`}`;
  const fragment = checked.nodes.map(render).join("");
  if (new TextEncoder().encode(fragment).byteLength > VISUALIZATION_LIMITS.contentBytes)
    throw new VisualizationError("visualization_too_large", 413);
  return fragment;
}
