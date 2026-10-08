import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountRepositories } from "../src/AccountRepositories";
import { httpApi } from "../src/api";
import "../src/styles.css";

// QA-only harness. Product components and the real HTTP adapter are unchanged.
function Fixture() {
  const [account, setAccount] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [changes, setChanges] = useState(0);
  const api = useMemo(() => ({ ...httpApi.collaboration! }), [account]);
  return (
    <>
      <aside
        aria-label="Synthetic QA controls"
        style={{ padding: 12, borderBottom: "1px solid #ccc" }}
      >
        <strong>Synthetic local fixture · no live account</strong>{" "}
        <button onClick={() => setAccount((value) => value + 1)}>Switch fixture account</button>{" "}
        <button onClick={() => setMounted((value) => !value)}>
          {mounted ? "Unmount directory" : "Mount directory"}
        </button>{" "}
        <output aria-label="Change callbacks">{changes}</output>
      </aside>
      {mounted && (
        <AccountRepositories
          key={account}
          api={api}
          onAdopted={() => setChanges((value) => value + 1)}
        />
      )}
    </>
  );
}
document.addEventListener(
  "keydown",
  () => (document.documentElement.dataset.keyboardFocus = "true"),
);
document.addEventListener(
  "pointerdown",
  () => delete document.documentElement.dataset.keyboardFocus,
);
createRoot(document.getElementById("root")!).render(<Fixture />);
