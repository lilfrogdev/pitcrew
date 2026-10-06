import { useCallback, useEffect, useRef, useState } from "react";
import type { CollaborationApi, SharedRepository } from "./api";
import styles from "./Repositories.module.css";

export function AccountRepositories({ api }: { api: CollaborationApi }) {
  const [items, setItems] = useState<SharedRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await api.repositories();
      if (current === generation.current) { setItems(next); setError(""); }
    } catch (cause) {
      if (current === generation.current) {
        setItems([]);
        setError(cause instanceof Error ? cause.message : "Could not load repositories.");
      }
    } finally { if (current === generation.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    void load();
    const online = () => void load();
    window.addEventListener("online", online);
    return () => { generation.current++; window.removeEventListener("online", online); };
  }, [load]);
  return <main id="workspace-content" className={styles.accountRepositories} tabIndex={-1}>
      <header><h1>Repositories</h1></header>
      <div className={styles.body}>
        <button type="button" onClick={() => void load()} disabled={loading}>Refresh</button>
        {loading ? <p role="status">Loading repositories…</p> : error ?
          <p role="alert">{error}</p> : items.length ?
            <ul className={styles.list}>{items.map((item) => <li key={item.id}>
              <div><strong>{item.name}</strong><span>{item.role}</span></div>
            </li>)}</ul> : <p>No repositories belong to this account yet.</p>}
      </div>
  </main>;
}
