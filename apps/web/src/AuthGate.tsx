import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AuthApi, AuthSession, AuthUser } from "./auth-api";
import styles from "./AuthGate.module.css";

export function AuthGate({ api, children }: {
  api: AuthApi;
  children: ReactNode | ((user: AuthUser) => ReactNode);
}) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const password = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const check = useCallback(async () => {
    const current = ++generation.current;
    setChecking(true);
    try {
      const result = await api.session();
      if (current === generation.current) { setSession(result); setError(""); }
    } catch (cause) {
      if (current === generation.current) {
        setSession(null);
        setError(cause instanceof Error ? cause.message : "Could not check your session.");
      }
    } finally { if (current === generation.current) setChecking(false); }
  }, [api]);
  useEffect(() => {
    void check();
    const online = () => void check();
    const required = () => void check();
    window.addEventListener("online", online);
    window.addEventListener("pitcrew-auth-required", required);
    return () => {
      generation.current++;
      window.removeEventListener("online", online);
      window.removeEventListener("pitcrew-auth-required", required);
    };
  }, [check]);
  if (checking) return <main className={styles.gate}><p role="status">Checking session…</p></main>;
  if (session)
    return <>{typeof children === "function" ? children(session.user) : children}</>;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const secret = password.current?.value ?? "";
    if (password.current) password.current.value = "";
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (enrolling) {
        await api.enroll(name.trim(), email.trim(), secret);
        setEnrolling(false);
        setNotice("Account ready. Sign in.");
      } else {
        await api.signIn(email.trim(), secret);
        await check();
      }
    } catch {
      setError(enrolling ? "Could not set up this account. Try again." :
        "Could not sign in. Check your email and password.");
    } finally { setBusy(false); }
  };
  return <main className={styles.gate}>
    <section className={styles.card} aria-label="Pitcrew account">
      <strong className={styles.brand}>Pitcrew</strong>
      <h1>{enrolling ? "Set up your account" : "Sign in"}</h1>
      {enrolling && <p>Use your approved Cloudflare email.</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <form onSubmit={(event) => void submit(event)}>
        {enrolling && <label>Name
          <input value={name} onChange={(event) => setName(event.target.value)} required
            maxLength={120} autoComplete="name" />
        </label>}
        <label>Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required
            autoComplete="email" maxLength={254} />
        </label>
        <label>Password
          <input ref={password} type="password" required minLength={enrolling ? 12 : undefined} maxLength={128}
            autoComplete={enrolling ? "new-password" : "current-password"} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : enrolling ? "Set password" : "Sign in"}
        </button>
      </form>
      <nav aria-label="Account actions" className={styles.actions}>
        {enrolling ? <button type="button" onClick={() => { setEnrolling(false); setError(""); }}>Sign in instead</button> :
          <button type="button" onClick={() => {
            setEnrolling(true); setError(""); setNotice("");
          }}>Set up account</button>}
        <button type="button" onClick={() => void check()}>Retry session</button>
      </nav>
    </section>
  </main>;
}
