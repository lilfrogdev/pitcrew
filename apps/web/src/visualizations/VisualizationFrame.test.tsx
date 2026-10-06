import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import { VisualizationFrame } from "./VisualizationFrame";
import {
  buildDocument,
  MAX_FRAGMENT_BYTES,
  readTheme,
  sanitizeFragment,
  THEME_DEFAULTS,
  validateArtifact,
  type Scope,
  type Visualization,
} from "./document";

const scope: Scope = {
  accountId: "account",
  repositoryId: "repo",
  threadId: "thread",
  accessEpoch: "1",
};
const artifact: Visualization = {
  ...scope,
  id: "test",
  version: 1,
  kind: "bars",
  title: "Chart",
  summary: "A useful text description",
  height: 360,
  points: [{ label: "One", value: 1 }],
};
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
});

describe("the generated content boundary", () => {
  it.each([
    "<script>parent.alert(1)</script>",
    '<img src="https://example.invalid/"/>',
    '<a href="https://example.invalid/">Open</a>',
    '<form action="/api/logout"><button>Go</button></form>',
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    '<meta http-equiv="refresh" content="0;url=https://example.invalid"/>',
    '<div onclick="alert(1)">Hi</div>',
    '<div style="background:url(https://example.invalid)">Hi</div>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"></a></svg>',
    '<math xmlns="http://www.w3.org/1998/Math/MathML"></math>',
    '<div xmlns="http://www.w3.org/1999/xhtml">Hi</div>',
    '<div id="minimum">Clobber</div>',
    '<div is="custom-element">Hi</div>',
    '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><p>&leak;</p>',
    '<?xml-stylesheet href="https://example.invalid/"?><p>Hi</p>',
  ])("rejects active, resource-loading, or ambiguous markup: %s", (fragment) => {
    expect(() => sanitizeFragment(fragment)).toThrow();
  });
  it("canonicalizes text without turning encoded tags into elements", () => {
    const safe = sanitizeFragment(
      '<section class="viz-card"><p aria-label="&quot;&gt;&lt;img src=x&gt;">&lt;script&gt;alert(1)&lt;/script&gt; &amp; hello</p></section>',
    );
    const parsed = new DOMParser().parseFromString(safe, "text/html");
    expect(parsed.querySelector("script, img")).toBeNull();
    expect(parsed.querySelector("p")!.textContent).toContain("<script>alert(1)</script>");
  });
  it("rejects oversized, deeply nested, and too many nodes", () => {
    expect(() => sanitizeFragment("x".repeat(MAX_FRAGMENT_BYTES + 1))).toThrow();
    expect(() => sanitizeFragment("<div>".repeat(14) + "x" + "</div>".repeat(14))).toThrow();
    expect(() => sanitizeFragment("<p>x</p>".repeat(300))).toThrow();
  });
  it.each([NaN, Infinity, -1, 1000001])("rejects invalid chart values %s", (value) => {
    expect(() =>
      validateArtifact({ ...artifact, kind: "bars", points: [{ label: "Bad", value }] }),
    ).toThrow();
  });
  it("escapes hostile labels and clamps layout at the schema boundary", () => {
    const page = buildDocument(
      {
        ...artifact,
        kind: "bars",
        points: [{ label: '</script><img src="x" onerror="alert(1)">', value: 10 }],
      },
      readTheme(),
      "00000000-0000-0000-0000-000000000000",
    );
    const doc = new DOMParser().parseFromString(page, "text/html");
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelectorAll("script")).toHaveLength(1);
    expect(doc.querySelector("th[scope=row]")!.textContent).toContain("<img");
    expect(() => validateArtifact({ ...artifact, height: 641 })).toThrow();
    expect(() =>
      validateArtifact({
        ...artifact,
        kind: "bars",
        points: Array.from({ length: 33 }, () => ({ label: "x", value: 1 })),
      }),
    ).toThrow();
  });
  it("exports only explicit, validated theme colors", () => {
    document.documentElement.style.setProperty("--accent", "#123456");
    document.documentElement.style.setProperty("--canvas", "red;}</style><img src=x>");
    document.documentElement.style.setProperty("--private-account-id", "sensitive");
    const theme = readTheme();
    expect(theme.colors["--accent"]).toBe("#123456");
    expect(theme.colors["--canvas"]).toBe(THEME_DEFAULTS["--canvas"]);
    expect(Object.keys(theme.colors)).not.toContain("--private-account-id");
  });
});

describe("access transitions and accessible fallback", () => {
  it("unmounts both frame and private fallback on revocation", () => {
    const { rerender } = render(
      <VisualizationFrame artifact={artifact} scope={scope} authorized />,
    );
    expect(screen.getByTitle("Chart")).toBeTruthy();
    expect(screen.getByText(artifact.summary)).toBeTruthy();
    rerender(<VisualizationFrame artifact={artifact} scope={scope} authorized={false} />);
    expect(screen.queryByTitle("Chart")).toBeNull();
    expect(screen.queryByText(artifact.summary)).toBeNull();
  });
  it.each(["accountId", "repositoryId", "threadId", "accessEpoch"] as const)(
    "rejects old data after %s changes",
    (key) => {
      const { rerender } = render(
        <VisualizationFrame artifact={artifact} scope={scope} authorized />,
      );
      rerender(
        <VisualizationFrame
          artifact={artifact}
          scope={{ ...scope, [key]: "different" }}
          authorized
        />,
      );
      expect(screen.queryByTitle("Chart")).toBeNull();
      expect(screen.queryByText(artifact.summary)).toBeNull();
    },
  );
  it("shows description without executing rejected markup", () => {
    render(
      <VisualizationFrame
        artifact={{ ...artifact, kind: "html", fragment: "<script>parent.alert(1)</script>" }}
        scope={scope}
        authorized
      />,
    );
    expect(screen.queryByTitle("Chart")).toBeNull();
    expect(screen.getByText(artifact.summary)).toBeTruthy();
  });
  it.each([
    null,
    {},
    { ...artifact, points: [null] },
    { ...artifact, version: 2 },
    { ...artifact, height: Infinity },
  ])("hides malformed payloads without crashing: %s", (input) => {
    render(<VisualizationFrame artifact={input} scope={scope} authorized />);
    expect(screen.queryByTitle("Chart")).toBeNull();
    expect(screen.queryByText(artifact.summary)).toBeNull();
  });
  it("rejects unavailable scope", () => {
    render(
      <VisualizationFrame artifact={artifact} scope={{ ...scope, accountId: "" }} authorized />,
    );
    expect(screen.queryByTitle("Chart")).toBeNull();
  });
  it.each([null, undefined])("rejects missing host scope without crashing", (scope) => {
    render(<VisualizationFrame artifact={artifact} scope={scope} authorized />);
    expect(screen.queryByTitle("Chart")).toBeNull();
    expect(screen.queryByText(artifact.summary)).toBeNull();
  });
});
