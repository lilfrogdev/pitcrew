import { apiFetch } from "./api";
import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import type { VerificationProfile } from "../../../packages/verification/src/index";
import type { intakeGroups } from "../../worker/src/intake";
type Group = ReturnType<typeof intakeGroups>[number];
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(path, body);
  if (!response.ok)
    throw Error(
      response.status === 409
        ? "This group or plan changed. Refresh and try again."
        : "Could not update intake.",
    );
  return response.json();
}
export function Intake({ projectId, onDispatch }: { projectId: string; onDispatch: () => void }) {
  const [groups, setGroups] = useState<Group[]>([]),
    [profile, setProfile] = useState<VerificationProfile>();
  const [content, setContent] = useState(""),
    [criterion, setCriterion] = useState("");
  const [selected, setSelected] = useState<string[]>([]),
    [target, setTarget] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const reportKey = useRef<{ content: string; id: string; occurredAt: string } | null>(null);
  const dispatchKey = useRef<{ body: string; id: string } | null>(null);
  const path = `/projects/${encodeURIComponent(projectId)}`;
  async function load() {
    const next = await call<{ groups: Group[]; profile: VerificationProfile }>(`${path}/intake`);
    setGroups(next.groups);
    setProfile(next.profile);
  }
  useEffect(() => {
    let current = true;
    call<{ groups: Group[]; profile: VerificationProfile }>(`${path}/intake`)
      .then((next) => {
        if (current) {
          setGroups(next.groups);
          setProfile(next.profile);
        }
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [path]);
  async function mutate(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Problem intake">
      <h2>Problem intake</h2>
      <p>Collect reports, group related sources, then dispatch one change explicitly.</p>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutate(async () => {
            if (!reportKey.current || reportKey.current.content !== content)
              reportKey.current = {
                content,
                id: crypto.randomUUID(),
                occurredAt: new Date().toISOString(),
              };
            await call(`${path}/reports`, {
              source: { system: "web", id: reportKey.current.id },
              content,
              occurredAt: reportKey.current.occurredAt,
            });
            reportKey.current = null;
            setContent("");
          });
        }}
      >
        <label>
          Original report
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={8000}
            required
          />
        </label>
        <button disabled={busy || !content.trim()}>Collect report</button>
      </form>
      <label>
        Acceptance criterion
        <input value={criterion} onChange={(e) => setCriterion(e.target.value)} maxLength={2000} />
      </label>
      <label>
        Move selected reports to
        <Select
          label="Move selected reports to"
          value={target}
          onChange={setTarget}
          options={[
            { value: "", label: "New problem (split)" },
            ...groups
              .filter((group) => group.reports.length)
              .map((group) => ({ value: group.id, label: group.title })),
          ]}
        />
      </label>
      <button
        disabled={busy || !selected.length}
        onClick={() =>
          void mutate(async () => {
            await call(`${path}/intake/move`, {
              idempotencyKey: crypto.randomUUID(),
              reportIds: selected,
              revisions: Object.fromEntries(groups.map((g) => [g.id, g.revision])),
              ...(target ? { targetGroupId: target } : { title: "Split problem" }),
            });
            setSelected([]);
          })
        }
      >
        Move reports
      </button>
      <button disabled={busy} onClick={() => void mutate(load)}>
        Refresh intake
      </button>
      {groups
        .filter((g) => g.reports.length)
        .map((group) => (
          <article key={group.id}>
            <h3>{group.title}</h3>
            <p>
              {group.status} · revision {group.revision}
            </p>
            {group.reports.map((report) => (
              <div key={report.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(report.id)}
                    onChange={(e) =>
                      setSelected((ids) =>
                        e.target.checked
                          ? [...ids, report.id]
                          : ids.filter((id) => id !== report.id),
                      )
                    }
                  />
                  {report.content}
                </label>
                <small>
                  {report.source.system}:{report.source.id} · {report.occurredAt} · Received{" "}
                  {report.receivedAt} · {report.actor}
                </small>
                {report.dispatch && (
                  <p>
                    Change {report.dispatch.changeId} · Run {report.dispatch.runId}
                  </p>
                )}
              </div>
            ))}
            <button
              disabled={busy || !criterion.trim() || !profile}
              onClick={() =>
                void mutate(async () => {
                  const input = {
                    groupId: group.id,
                    revision: group.revision,
                    profileRevision: profile!.revision,
                    acceptance: {
                      revision: "criteria-v1",
                      criteria: [
                        {
                          id: "requested-behavior",
                          text: criterion,
                          checkIds: profile!.checks.map((c) => c.id),
                        },
                      ],
                    },
                  };
                  const body = JSON.stringify(input);
                  if (!dispatchKey.current || dispatchKey.current.body !== body)
                    dispatchKey.current = { body, id: crypto.randomUUID() };
                  await call(`${path}/intake/dispatch`, {
                    ...input,
                    idempotencyKey: dispatchKey.current.id,
                  });
                  onDispatch();
                })
              }
            >
              Dispatch problem
            </button>
          </article>
        ))}
    </section>
  );
}
