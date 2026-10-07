// Original Pitcrew implementation. Upstream T3 source was studied, not copied.
export const MAX_FRAGMENT_BYTES = 64 * 1024;
export const MAX_POINTS = 32;
export const MIN_HEIGHT = 160;
export const MAX_HEIGHT = 640;
export const THEME_DEFAULTS = {
  "--canvas": "#f7f7f8",
  "--surface": "#ffffff",
  "--text": "#24262b",
  "--muted": "#626772",
  "--border": "#e3e5e8",
  "--accent": "#484d57",
  "--focus": "#737983",
  "--success": "#326448",
  "--warning": "#805519",
  "--error": "#a13737",
} as const;
export type Theme = { mode: "light" | "dark"; colors: Record<keyof typeof THEME_DEFAULTS, string> };
export type Scope = {
  accountId: string;
  repositoryId: string;
  threadId: string;
  accessEpoch: string;
};
export type Point = { label: string; value: number };
export type Visualization = Scope & {
  id: string;
  version: 1;
  title: string;
  summary: string;
  height: number;
} & ({ kind: "html"; fragment: string } | { kind: "bars"; points: Point[] });

export function validScope(value: unknown): value is Scope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["accountId", "repositoryId", "threadId", "accessEpoch"].every(
    (key) => typeof record[key] === "string" && !!record[key].trim() && record[key].length <= 200,
  );
}
/** Decode untrusted JSON before displaying even its text fallback. */
export function readArtifact(value: unknown): Visualization | undefined {
  if (!validScope(value)) return;
  const data = value as unknown as Record<string, unknown>;
  const { id, version, kind, title, summary, height } = data;
  if (
    version !== 1 ||
    typeof id !== "string" ||
    !/^[\w-]{1,100}$/.test(id) ||
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 160 ||
    typeof summary !== "string" ||
    !summary.trim() ||
    summary.length > 4000 ||
    typeof height !== "number" ||
    !Number.isInteger(height) ||
    height < MIN_HEIGHT ||
    height > MAX_HEIGHT
  )
    return;
  const base = {
    accountId: value.accountId,
    repositoryId: value.repositoryId,
    threadId: value.threadId,
    accessEpoch: value.accessEpoch,
    id,
    version: 1 as const,
    title,
    summary,
    height,
  };
  if (
    kind === "html" &&
    typeof data.fragment === "string" &&
    data.fragment.length <= MAX_FRAGMENT_BYTES &&
    new TextEncoder().encode(data.fragment).length <= MAX_FRAGMENT_BYTES
  )
    return { ...base, kind, fragment: data.fragment };
  if (
    kind !== "bars" ||
    !Array.isArray(data.points) ||
    !data.points.length ||
    data.points.length > MAX_POINTS
  )
    return;
  const points: Point[] = [];
  for (const point of data.points) {
    if (
      !point ||
      typeof point !== "object" ||
      typeof point.label !== "string" ||
      !point.label.trim() ||
      point.label.length > 100 ||
      typeof point.value !== "number" ||
      !Number.isFinite(point.value) ||
      point.value < 0 ||
      point.value > 1_000_000
    )
      return;
    points.push({ label: point.label, value: point.value });
  }
  return { ...base, kind, points };
}
export function inScope(artifact: Visualization, scope: Scope, authorized: boolean) {
  return (
    authorized &&
    validScope(artifact) &&
    validScope(scope) &&
    ["accountId", "repositoryId", "threadId", "accessEpoch"].every(
      (key) => artifact[key as keyof Scope] === scope[key as keyof Scope],
    )
  );
}
export function readTheme(root: HTMLElement = document.documentElement): Theme {
  const style = getComputedStyle(root);
  const colors = { ...THEME_DEFAULTS } as Theme["colors"];
  for (const token of Object.keys(THEME_DEFAULTS) as (keyof typeof THEME_DEFAULTS)[]) {
    const value = style.getPropertyValue(token).trim();
    // Never serialize arbitrary custom properties, URLs, font names, or CSS syntax.
    if (/^#[\da-f]{6}$/i.test(value)) colors[token] = value;
  }
  return { mode: style.colorScheme === "dark" ? "dark" : "light", colors };
}
export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
const tags = new Set(
  "article section div p span h2 h3 h4 strong em small code pre ul ol li table caption thead tbody tr th td details summary br hr".split(
    " ",
  ),
);
const classes = new Set(["viz-card", "viz-grid", "viz-muted", "viz-accent"]);

/** A deliberately small XHTML dialect. XML parsing has no HTML resource loading. */
export function sanitizeFragment(fragment: string): string {
  if (
    typeof fragment !== "string" ||
    fragment.length > MAX_FRAGMENT_BYTES ||
    new TextEncoder().encode(fragment).length > MAX_FRAGMENT_BYTES ||
    /<!|<\?/.test(fragment)
  )
    throw Error("Use a small, well-formed HTML fragment without declarations.");
  const parsed = new DOMParser().parseFromString(
    `<viz-root>${fragment}</viz-root>`,
    "application/xml",
  );
  if (parsed.querySelector("parsererror") || parsed.documentElement.tagName !== "viz-root")
    throw Error("The HTML fragment could not be read.");
  let count = 0;
  function serialize(node: Node, depth: number): string {
    if (++count > 512 || depth > 12) throw Error("The visualization is too complex.");
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE)
      return escapeHtml(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) throw Error("Unsupported HTML content.");
    const element = node as Element;
    const tag = element.tagName;
    if (element.namespaceURI || !tags.has(tag)) throw Error("This HTML element is not supported.");
    const attributes: string[] = [];
    for (const attr of Array.from(element.attributes)) {
      if (attr.namespaceURI) throw Error("Unsupported HTML attribute.");
      if (attr.name === "class" && attr.value.split(/\s+/).every((name) => classes.has(name)))
        attributes.push(`class="${escapeHtml(attr.value)}"`);
      else if (attr.name === "aria-label" && attr.value.length <= 200)
        attributes.push(`aria-label="${escapeHtml(attr.value)}"`);
      else if (tag === "th" && attr.name === "scope" && ["row", "col"].includes(attr.value))
        attributes.push(`scope="${attr.value}"`);
      else throw Error("This HTML attribute is not supported.");
    }
    const content = Array.from(node.childNodes)
      .map((child) => serialize(child, depth + 1))
      .join("");
    if (["br", "hr"].includes(tag) && content) throw Error("Unsupported HTML content.");
    return `<${tag}${attributes.length ? " " + attributes.join(" ") : ""}>${content}${["br", "hr"].includes(tag) ? "" : `</${tag}>`}`;
  }
  return Array.from(parsed.documentElement.childNodes)
    .map((node) => serialize(node, 0))
    .join("");
}

export function validateArtifact(artifact: Visualization) {
  if (
    artifact.version !== 1 ||
    typeof artifact.id !== "string" ||
    !/^[\w-]{1,100}$/.test(artifact.id) ||
    typeof artifact.title !== "string" ||
    !artifact.title.trim() ||
    artifact.title.length > 160 ||
    typeof artifact.summary !== "string" ||
    !artifact.summary.trim() ||
    artifact.summary.length > 4000 ||
    !Number.isInteger(artifact.height) ||
    artifact.height < MIN_HEIGHT ||
    artifact.height > MAX_HEIGHT ||
    ![artifact.accountId, artifact.repositoryId, artifact.threadId, artifact.accessEpoch].every(
      (id) => typeof id === "string" && !!id && id.length <= 200,
    )
  )
    throw Error("The visualization metadata is invalid.");
  if (artifact.kind === "html") return sanitizeFragment(artifact.fragment);
  if (
    artifact.kind !== "bars" ||
    !Array.isArray(artifact.points) ||
    !artifact.points.length ||
    artifact.points.length > MAX_POINTS ||
    artifact.points.some(
      (point) =>
        typeof point.label !== "string" ||
        !point.label.trim() ||
        point.label.length > 100 ||
        typeof point.value !== "number" ||
        !Number.isFinite(point.value) ||
        point.value < 0 ||
        point.value > 1_000_000,
    )
  )
    throw Error("The chart data is invalid.");
  const max = Math.max(1, ...artifact.points.map((point) => point.value));
  const rows = artifact.points
    .map(
      (point, index) =>
        `<tr data-value="${point.value}"><th scope="row">${escapeHtml(point.label)}</th><td>${point.value}</td><td><div class="bar bar-${index}" aria-hidden="true"></div></td></tr>`,
    )
    .join("");
  return `<label for="minimum">Minimum value <output id="current">0</output></label><input id="minimum" type="range" min="0" max="${max}" step="${Math.max(1, Math.round(max / 100))}" value="0"/><button type="button" id="sort">Sort by value</button><table><caption>${escapeHtml(artifact.title)}</caption><thead><tr><th scope="col">Category</th><th scope="col">Value</th><th scope="col">Share</th></tr></thead><tbody>${rows}</tbody></table>`;
}
const CHART_RUNTIME = `"use strict";const slider=document.getElementById("minimum"),output=document.getElementById("current"),body=document.querySelector("tbody");slider.addEventListener("input",()=>{output.textContent=slider.value;for(const row of body.rows)row.hidden=Number(row.dataset.value)<Number(slider.value)});let ascending=false;document.getElementById("sort").addEventListener("click",()=>{ascending=!ascending;for(const row of [...body.rows].sort((a,b)=>(Number(a.dataset.value)-Number(b.dataset.value))*(ascending?1:-1)))body.append(row)});`;
const BASE_STYLE = `*{box-sizing:border-box}html{color-scheme:var(--mode);font:14px/1.5 system-ui,sans-serif;background:var(--canvas);color:var(--text)}body{margin:0;padding:16px;overflow-wrap:anywhere}h2,h3,p{margin:0 0 12px}.viz-card{padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:8px}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr));gap:12px}.viz-muted{color:var(--muted)}.viz-accent{color:var(--accent)}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;padding:10px 6px;border-bottom:1px solid var(--border)}thead th:first-child{width:49%}thead th:nth-child(2){width:18%}thead th:last-child{width:33%}caption{text-align:left;font-weight:600;margin:12px 0}button{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin:8px}input{accent-color:var(--accent);max-width:100%}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}.bar{height:12px;background:var(--accent);border-radius:3px}pre{white-space:pre-wrap}[hidden]{display:none!important}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

export function buildDocument(artifact: Visualization, theme: Theme, nonce: string): string {
  if (!/^[a-f\d-]{36}$/.test(nonce)) throw Error("Invalid runtime nonce.");
  const body = validateArtifact(artifact);
  const colors = Object.entries(THEME_DEFAULTS)
    .map(([token, fallback]) => {
      const value = theme.colors[token as keyof typeof THEME_DEFAULTS];
      return `${token}:${/^#[\da-f]{6}$/i.test(value) ? value : fallback}`;
    })
    .join(";");
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; script-src-attr 'none'; style-src 'nonce-${nonce}'; style-src-attr 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
  const max =
    artifact.kind === "bars" ? Math.max(1, ...artifact.points.map((point) => point.value)) : 1;
  const widths =
    artifact.kind === "bars"
      ? artifact.points
          .map((point, index) => `.bar-${index}{width:${((point.value / max) * 100).toFixed(2)}%}`)
          .join("")
      : "";
  // Generated markup is never executed or inserted into the host DOM. Only our fixed chart runtime runs.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(artifact.title)}</title><style nonce="${nonce}">:root{--mode:${theme.mode === "dark" ? "dark" : "light"};${colors}}${BASE_STYLE}${widths}</style></head><body>${body}${artifact.kind === "bars" ? `<script nonce="${nonce}">${CHART_RUNTIME}</script>` : ""}</body></html>`;
}
