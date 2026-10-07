import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AuthApi, AuthSession, AuthUser } from "./auth-api";
import styles from "./AuthGate.module.css";
import { useKeyboardFocus } from "./useKeyboardFocus";

type Entry = { mode: "sign-in" | "enroll"; code: string };
function authLink(): Entry {
  if (location.pathname === "/auth/enroll") {
    // A 32-byte base64url code has 43 characters and two unused final bits.
    const match = /^#code=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/.exec(location.hash);
    history.replaceState(null, "", "/auth/enroll");
    return { mode: "enroll", code: match?.[1] ?? "" };
  }
  if (location.pathname.startsWith("/auth/")) history.replaceState(null, "", "/");
  return { mode: "sign-in", code: "" };
}

export function AuthGate({
  api,
  children,
}: {
  api: AuthApi;
  children: ReactNode | ((user: AuthUser) => ReactNode);
}) {
  const [entry, setEntry] = useState(authLink);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const password = useRef<HTMLInputElement>(null);
  const setPassword = useCallback((node: HTMLInputElement | null) => {
    if (!node && password.current) password.current.value = "";
    password.current = node;
  }, []);
  const heading = useRef<HTMLHeadingElement>(null);
  const keyboardFocus = useKeyboardFocus();
  const generation = useRef(0);
  const operation = useRef(0);
  useEffect(() => {
    if (!checking) heading.current?.focus();
  }, [entry.mode, checking]);
  const check = useCallback(
    async (foreground = true) => {
      const current = ++generation.current;
      if (foreground) setChecking(true);
      try {
        const result = await api.session();
        if (current === generation.current) {
          setSession(result);
          setError("");
        }
      } catch {
        if (current === generation.current) {
          setSession(null);
          setError("Could not check your session. Try again.");
        }
      } finally {
        if (current === generation.current) setChecking(false);
      }
    },
    [api],
  );
  useEffect(() => {
    void check();
    const online = () => void check(false);
    const required = () => {
      operation.current++;
      setSession(null);
      setBusy(false);
      setEntry({ mode: "sign-in", code: "" });
      setEmail("");
      setName("");
      setUsername("");
      setNotice("");
      if (password.current) password.current.value = "";
      void check();
    };
    const updated = () => void check(false);
    window.addEventListener("online", online);
    window.addEventListener("pitcrew-auth-required", required);
    window.addEventListener("pitcrew-auth-updated", updated);
    return () => {
      generation.current++;
      operation.current++;
      if (password.current) password.current.value = "";
      window.removeEventListener("online", online);
      window.removeEventListener("pitcrew-auth-required", required);
      window.removeEventListener("pitcrew-auth-updated", updated);
    };
  }, [check]);
  if (checking)
    return (
      <main className={styles.gate}>
        <p role="status">Checking session…</p>
      </main>
    );
  if (session && entry.mode === "sign-in")
    return (
      <Fragment key={session.user.id}>
        {typeof children === "function" ? children(session.user) : children}
      </Fragment>
    );
  const backToSignIn = () => {
    setEntry({ mode: "sign-in", code: "" });
    setName("");
    setUsername("");
    setError("");
    setNotice("");
    if (password.current) password.current.value = "";
    history.replaceState(null, "", "/");
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || (entry.mode === "enroll" && !entry.code)) return;
    const current = ++operation.current;
    const secret = password.current?.value ?? "";
    if (password.current) password.current.value = "";
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (entry.mode === "enroll") {
        await api.enroll(name.trim(), username.trim(), entry.code, secret);
        if (current !== operation.current) return;
        generation.current++;
        setSession(null);
        backToSignIn();
        setNotice("Account ready. Sign in with your email and password.");
      } else {
        await api.signIn(email.trim(), secret);
        if (current === operation.current) await check();
      }
    } catch {
      if (current === operation.current)
        setError(
          entry.mode === "sign-in"
            ? "Could not sign in. Check your email and password."
            : "Could not set up this account. Check your details and private setup link.",
        );
    } finally {
      if (current === operation.current) setBusy(false);
    }
  };
  const enrolling = entry.mode === "enroll";
  return (
    <main className={styles.gate} data-keyboard-focus={keyboardFocus}>
      <section className={styles.card} aria-label="Pitcrew account">
        <strong className={styles.brand}>Pitcrew</strong>
        <h1 ref={heading} tabIndex={-1}>
          {enrolling ? "Set up your account" : "Sign in"}
        </h1>
        {enrolling && (
          <p>
            {entry.code
              ? "Choose your profile and password for the account assigned to this private setup link."
              : "This account setup link is unavailable. Ask for a new private setup link."}
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {(!enrolling || entry.code) && (
          <form onSubmit={(event) => void submit(event)}>
            {enrolling ? (
              <>
                <label>
                  Name
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={80}
                    autoComplete="name"
                    disabled={busy}
                  />
                </label>
                <label>
                  Username
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    required
                    minLength={3}
                    maxLength={32}
                    pattern="[a-zA-Z0-9_]{3,32}"
                    autoComplete="username"
                    disabled={busy}
                  />
                </label>
              </>
            ) : (
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  maxLength={254}
                  disabled={busy}
                />
              </label>
            )}
            <label>
              Password
              <input
                ref={setPassword}
                type="password"
                required
                minLength={enrolling ? 12 : undefined}
                maxLength={128}
                autoComplete={enrolling ? "new-password" : "current-password"}
                disabled={busy}
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? "Working…" : enrolling ? "Set password" : "Sign in"}
            </button>
          </form>
        )}
        <nav aria-label="Account actions" className={styles.actions}>
          {enrolling && (
            <button type="button" disabled={busy} onClick={backToSignIn}>
              Back to sign in
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void check()}>
            Retry session
          </button>
        </nav>
      </section>
    </main>
  );
}
