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
  const scope = {
    accountId: envelope.accountId,
    repositoryId: envelope.repositoryId,
    threadId: envelope.threadId,
    accessEpoch: envelope.accessEpoch,
  };
  return (
    <section aria-label="Conversation visualizations">
      {envelope.artifacts.slice(0, VISUALIZATION_LIMITS.frames).map((record) => (
        <RecordFrame
          key={`${scope.accessEpoch}:${record.id}`}
          record={record}
          accountId={scope.accountId}
          accessEpoch={scope.accessEpoch}
        />
      ))}
      {envelope.artifacts.length > VISUALIZATION_LIMITS.frames && (
        <p>
          {envelope.artifacts.length - VISUALIZATION_LIMITS.frames} additional visualizations are
          available. Only two previews are mounted at once.
        </p>
      )}
    </section>
  );
}
