import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "../src/AuthGate";
import { httpAuthApi, type AuthUser } from "../src/auth-api";
import { httpApi } from "../src/api";
import { AccountRepositories } from "../src/AccountRepositories";
import { AccountSummary, Collaborators, InvitationGate } from "../src/Collaboration";
import "../src/styles.css";

// QA-only composition of production components and HTTP adapters. Authentication,
// invitations and grants run through the production relays and temporary Worker/D1.
function SignedIn({ viewer, observedAcceptance }: { viewer: AuthUser; observedAcceptance: () => void }) {
  const api = useMemo(() => ({ ...httpApi.collaboration! }), [viewer.id]);
  const [meta, setMeta] = useState<{ projectId: string; threads: string[] }>();
  const [thread, setThread] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [invitationMounted, setInvitationMounted] = useState(true);
  const [accepted, setAccepted] = useState<string[]>([]);
  const accessLost = useCallback(() => {}, []);
  useEffect(() => { void fetch("/fixture/meta").then(r => r.json()).then(setMeta); }, []);
  return <>
    <aside aria-label="Synthetic QA controls" style={{ padding: 12 }}>
      <strong>Temporary synthetic accounts · local Worker and D1</strong>{" "}
      <button onClick={() => setThread(n => (n + 1) % 2)}>Switch fixture resource</button>{" "}
      <button onClick={() => setMounted(n => !n)}>{mounted ? "Unmount sharing" : "Mount sharing"}</button>
      <button onClick={() => setInvitationMounted(n => !n)}>{invitationMounted ? "Unmount invitation" : "Mount invitation"}</button>
      <output aria-label="Accepted invitations">{accepted.join(",")}</output>
    </aside>
    <AccountSummary api={api} auth={httpAuthApi} viewer={viewer} onSignOut={async () => {
      await httpAuthApi.signOut(); window.dispatchEvent(new Event("pitcrew-auth-required"));
    }} />
    {invitationMounted && <InvitationGate api={api} manual onAccepted={invite => { observedAcceptance(); setAccepted(a => [...a, invite.scope]); }} />}
    <AccountRepositories key={accepted.length} api={api} />
    <div style={{ position: "relative", display: "flex", justifyContent: "flex-end", margin: 20, minHeight: 500 }}>
      {meta && mounted && <Collaborators api={api} projectId={meta.projectId}
        threadId={meta.threads[thread]} onAccessLost={accessLost} />}
    </div>
  </>;
}
function Fixture() {
  const [callbacks, setCallbacks] = useState(0);
  const observedAcceptance = useCallback(() => setCallbacks(n => n + 1), []);
  return <><output aria-label="Global acceptance callbacks">{callbacks}</output>
    <AuthGate api={httpAuthApi}>{viewer => <SignedIn key={viewer.id} viewer={viewer} observedAcceptance={observedAcceptance} />}</AuthGate>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
