import { describe, expect, it } from "vite-plus/test";
import {
  documentFragment,
  readVisualizationContent,
  readVisualizationEnvelope,
  VISUALIZATION_LIMITS,
} from "./visualizations";
const base = { title: "Revenue", summary: "Compare two categories.", height: 320 };
describe("visualization protocol", () => {
  it("accepts structured documents and escapes hostile text at serialization", () => {
    const content = readVisualizationContent({
      ...base,
      kind: "document",
      nodes: [
        {
          tag: "details",
          children: [
            { tag: "summary", children: [{ text: '<script src="/sentinel">bad</script>' }] },
            { tag: "p", class: "viz-muted", children: [{ text: "Explanation" }] },
          ],
        },
      ],
    });
    expect(documentFragment(content)).toContain("&lt;script");
    expect(documentFragment(content)).not.toContain("<script");
  });
  it.each([
    { tag: "script", children: [{ text: "location.href='/sentinel'" }] },
    { tag: "iframe" },
    { tag: "img", src: "/sentinel" },
    { tag: "a", href: "/sentinel" },
    { tag: "div", style: "background:url(/sentinel)" },
    { tag: "p", onclick: "alert(1)" },
    { tag: "svg" },
    { tag: "form" },
    { tag: "p", id: "app" },
    { tag: "p", class: "other" },
    { tag: "th", scope: "bad" },
    { tag: "p", scope: "row" },
    { tag: "br", children: [] },
    { text: "\u0000" },
    { text: "\ud800" },
    { text: "hello", tag: "p" },
  ])("rejects active content or unknown document fields: %j", (node) => {
    expect(() => readVisualizationContent({ ...base, kind: "document", nodes: [node] })).toThrow();
  });
  it("rejects caller ownership, raw HTML, unsafe numbers, point count and byte overflow", () => {
    const bars = { ...base, kind: "bars", points: [{ label: "safe", value: 1 }] };
    for (const value of [
      { ...bars, accountId: "other" },
      { ...bars, script: "bad" },
      { ...bars, height: 999 },
      { ...bars, kind: "html", fragment: "<p>bad</p>" },
      { ...bars, points: [{ label: "a", value: Infinity }] },
      { ...bars, points: Array.from({ length: 33 }, () => ({ label: "a", value: 1 })) },
    ])
      expect(() => readVisualizationContent(value)).toThrow();
    expect(() =>
      readVisualizationContent({
        ...base,
        kind: "document",
        nodes: [{ text: "😀".repeat(20000) }],
      }),
    ).toThrow("visualization_too_large");
  });
  it("bounds depth, nodes, and escaped expansion", () => {
    let node: unknown = { text: "deep" };
    for (let i = 0; i < 13; i++) node = { tag: "div", children: [node] };
    expect(() => readVisualizationContent({ ...base, kind: "document", nodes: [node] })).toThrow(
      "visualization_complexity",
    );
    expect(() =>
      readVisualizationContent({
        ...base,
        kind: "document",
        nodes: Array.from({ length: VISUALIZATION_LIMITS.nodes + 1 }, () => ({ text: "x" })),
      }),
    ).toThrow("visualization_complexity");
    const content = readVisualizationContent({
      ...base,
      kind: "document",
      nodes: [{ text: "&".repeat(14000) }],
    });
    expect(() => documentFragment(content)).toThrow("visualization_too_large");
  });
  it("rejects unknown envelope fields and unbounded authorization leases", () => {
    const envelope = {
      accountId: "account:viewer",
      repositoryId: "repo",
      threadId: "thread",
      accessEpoch: "epoch",
      leaseMs: 5000,
      artifacts: [],
    };
    expect(readVisualizationEnvelope(envelope)).toEqual(envelope);
    expect(() => readVisualizationEnvelope({ ...envelope, leaseMs: 5001 })).toThrow();
    expect(() => readVisualizationEnvelope({ ...envelope, token: "never" })).toThrow();
  });
});
