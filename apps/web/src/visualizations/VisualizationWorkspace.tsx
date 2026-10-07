import { memo, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  documentFragment,
  VISUALIZATION_LIMITS,
  type VisualizationRecord,
} from "../../../../packages/protocol/src/visualizations";
import { VisualizationFrame } from "./VisualizationFrame";
import { VisualizationController, type VisualizationSource } from "./controller";
const RecordFrame = memo(function RecordFrame({
  record,
  accountId,
  accessEpoch,
}: {
  record: VisualizationRecord;
  accountId: string;
  accessEpoch: string;
}) {
  const scope = useMemo(
    () => ({
      accountId,
      accessEpoch,
      repositoryId: record.repositoryId,
      threadId: record.threadId,
    }),
    [record.repositoryId, record.threadId, accountId, accessEpoch],
  );
  const artifact = useMemo(
    () =>
      record.content.kind === "bars"
        ? { ...record.content, ...scope, id: record.id, version: 1 }
        : {
            ...scope,
            id: record.id,
            version: 1,
            kind: "html",
            title: record.content.title,
            summary: record.content.summary,
            height: record.content.height,
            fragment: documentFragment(record.content),
          },
    [record, scope],
  );
  return <VisualizationFrame artifact={artifact} scope={scope} authorized />;
});

export function VisualizationWorkspace({
  source,
  authorized,
}: {
  source?: VisualizationSource;
  authorized: boolean;
}) {
  const [controller] = useState(() => new VisualizationController());
  const [selection, setSelection] = useState<{ source: VisualizationSource; page: number }>();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => null);
  useEffect(() => {
    const resume = () => {
      controller.configure(authorized && !document.hidden && navigator.onLine ? source : undefined);
      void controller.revalidate();
    };
    const lose = () => controller.configure();
    const visibility = () => (document.hidden ? lose() : resume());
    resume();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("offline", lose);
    window.addEventListener("online", resume);
    window.addEventListener("pitcrew-auth-required", lose);
    window.addEventListener("pitcrew-access-lost", lose);
    return () => {
      controller.dispose();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("offline", lose);
      window.removeEventListener("online", resume);
      window.removeEventListener("pitcrew-auth-required", lose);
      window.removeEventListener("pitcrew-access-lost", lose);
    };
  }, [source, authorized, controller]);
  // This render fence removes stale content before effects run on prop replacement.
  if (
    !authorized ||
    !source ||
    snapshot?.source !== source ||
    snapshot.deadline <= performance.now()
  )
    return <p role="status">Visualizations are unavailable or awaiting access verification.</p>;
  const { envelope } = snapshot;
  const pages = Math.max(1, Math.ceil(envelope.artifacts.length / VISUALIZATION_LIMITS.frames));
  const page = Math.min(selection?.source === source ? selection.page : 0, pages - 1);
  const start = page * VISUALIZATION_LIMITS.frames;
  const scope = {
    accountId: envelope.accountId,
    repositoryId: envelope.repositoryId,
    threadId: envelope.threadId,
    accessEpoch: envelope.accessEpoch,
  };
  return (
    <section aria-label="Conversation visualizations">
      {pages > 1 && (
        <nav aria-label="Visualization pages" className="visualization-pages">
          <button
            type="button"
            aria-label="Previous visualizations"
            disabled={page === 0}
            onClick={() => setSelection({ source, page: page - 1 })}
          >
            Previous
          </button>
          <span aria-live="polite">
            Page {page + 1} of {pages}
          </span>
          <button
            type="button"
            aria-label="Next visualizations"
            disabled={page === pages - 1}
            onClick={() => setSelection({ source, page: page + 1 })}
          >
            Next
          </button>
        </nav>
      )}
      {envelope.artifacts.slice(start, start + VISUALIZATION_LIMITS.frames).map((record) => (
        <RecordFrame
          key={`${scope.accessEpoch}:${record.id}`}
          record={record}
          accountId={scope.accountId}
          accessEpoch={scope.accessEpoch}
        />
      ))}
    </section>
  );
}
