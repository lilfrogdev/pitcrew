import { useEffect, useId, useMemo, useState } from "react";
import {
  buildDocument,
  inScope,
  readArtifact,
  readTheme,
  validScope,
  type Scope,
} from "./document";
import "./visualizations.css";

export function VisualizationFrame({
  artifact: input,
  scope,
  authorized,
}: {
  artifact: unknown;
  scope: Scope | null | undefined;
  authorized: boolean;
}) {
  const artifact = useMemo(() => readArtifact(input), [input]);
  const [theme, setTheme] = useState(readTheme);
  const summaryId = useId();
  const nonce = useMemo(
    () => crypto.randomUUID(),
    [artifact, scope?.accountId, scope?.repositoryId, scope?.threadId, scope?.accessEpoch, theme],
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = readTheme();
      setTheme((current) =>
        current.mode === next.mode &&
        Object.entries(current.colors).every(
          ([token, value]) => next.colors[token as keyof typeof next.colors] === value,
        )
          ? current
          : next,
      );
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  const allowed =
    artifact !== undefined && validScope(scope) && inScope(artifact, scope, authorized);
  const prepared = useMemo(() => {
    if (!allowed || !artifact)
      return { document: "", error: "This visualization is no longer available." };
    try {
      return { document: buildDocument(artifact, theme, nonce), error: "" };
    } catch {
      return {
        document: "",
        error: "This visualization could not be displayed. Read the description below.",
      };
    }
  }, [artifact, allowed, theme, nonce]);
  if (!allowed || !artifact) return <p role="status">This visualization is no longer available.</p>;
  return (
    <figure className="pitcrew-visualization">
      <figcaption>
        {typeof artifact.title === "string" ? artifact.title.slice(0, 160) : "Visualization"}
      </figcaption>
      {prepared.document ? (
        <iframe
          key={nonce}
          title={artifact.title}
          aria-describedby={summaryId}
          srcDoc={prepared.document}
          sandbox={artifact.kind === "bars" ? "allow-scripts" : ""}
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
          style={{ height: artifact.height, colorScheme: theme.mode }}
        />
      ) : (
        <p role="status">{prepared.error}</p>
      )}
      <p id={summaryId} className="visualization-description">
        {typeof artifact.summary === "string"
          ? artifact.summary.slice(0, 4000)
          : "No description available."}
      </p>
      {artifact.kind === "bars" && prepared.document && (
        <details>
          <summary>Read chart data</summary>
          <table>
            <caption>{artifact.title}</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {artifact.points.map((point, index) => (
                <tr key={index}>
                  <th scope="row">{point.label}</th>
                  <td>{point.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}
