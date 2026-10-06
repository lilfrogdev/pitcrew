import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AuthApi, AuthSession, AuthUser } from "./auth-api";
import styles from "./AuthGate.module.css";
import { useKeyboardFocus } from "./useKeyboardFocus";

type Mode = "sign-in" | "enroll" | "request-reset" | "reset" | "verify" | "resend";
function authLink(): { kind: "verify" | "reset" | undefined; token: string } {
  const kind =
    location.pathname === "/auth/verify"
      ? "verify"
      : location.pathname === "/auth/reset"
        ? "reset"
        : undefined;
  const token = kind ? (new URLSearchParams(location.hash.slice(1)).get("token") ?? "") : "";
  if (kind) history.replaceState(null, "", "/");
  return { kind, token };
}
const titles: Record<Mode, string> = {
  "sign-in": "Sign in",
  enroll: "Set up your account",
  "request-reset": "Reset your password",
  reset: "Choose a new password",
  verify: "Verify your email",
  resend: "Resend verification",
};

export function AuthGate({
  api,
  children,
}: {
  api: AuthApi;
  children: ReactNode | ((user: AuthUser) => ReactNode);
}) {
  const [link] = useState(authLink);
  const [mode, setMode] = useState<Mode>(link.kind ?? "sign-in");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const password = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const keyboardFocus = useKeyboardFocus();
  const generation = useRef(0);
  const verificationStarted = useRef(false);
  useEffect(() => {
    if (!checking) heading.current?.focus();
  }, [mode, checking]);
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
      } catch (cause) {
        if (current === generation.current) {
          setSession(null);
          setError(cause instanceof Error ? cause.message : "Could not check your session.");
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
    const required = () => void check();
    const updated = () => void check(false);
    window.addEventListener("online", online);
    window.addEventListener("pitcrew-auth-required", required);
    window.addEventListener("pitcrew-auth-updated", updated);
    return () => {
      generation.current++;
      window.removeEventListener("online", online);
      window.removeEventListener("pitcrew-auth-required", required);
      window.removeEventListener("pitcrew-auth-updated", updated);
    };
  }, [check]);
  useEffect(() => {
    if (link.kind !== "verify" || checking || verificationStarted.current) return;
    verificationStarted.current = true;
    let active = true;
    if (!link.token || link.token.length > 4096) {
      setError("This verification link is unavailable. Request another email.");
      return;
    }
    setBusy(true);
    api
      .verifyEmail(link.token)
      .then(() => {
        if (active) {
          setMode("sign-in");
          setNotice("Email verified. Sign in.");
        }
      })
      .catch(() => {
        if (active) setError("This verification link is unavailable. Request another email.");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, link, checking]);
  if (checking)
    return (
      <main className={styles.gate}>
        <p role="status">Checking session…</p>
      </main>
    );
  if (session && mode === "sign-in")
    return (
      <Fragment key={session.user.id}>
        {typeof children === "function" ? children(session.user) : children}
      </Fragment>
    );
  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    setNotice("");
    if (password.current) password.current.value = "";
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const secret = password.current?.value ?? "";
    if (password.current) password.current.value = "";
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "enroll") {
        await api.enroll(name.trim(), username.trim(), email.trim(), secret);
        setMode("sign-in");
        setNotice("Check your email to verify your account, then sign in.");
      } else if (mode === "request-reset") {
        await api.requestPasswordReset(email.trim());
        setNotice("If this account can reset its password, an email is on its way.");
      } else if (mode === "resend") {
        await api.resendVerification(email.trim());
        setNotice("If this account needs verification, an email is on its way.");
      } else if (mode === "reset") {
        if (!link.token || link.token.length > 256) throw Error();
        await api.resetPassword(link.token, secret);
        setSession(null);
        setMode("sign-in");
        setNotice("Password reset. Sign in.");
      } else {
        await api.signIn(email.trim(), secret);
        await check();
      }
    } catch {
      setError(
        mode === "sign-in"
          ? "Could not sign in. Check your email, verification and password."
          : mode === "enroll"
            ? "Could not set up this account. Check your details and try again."
            : mode === "reset"
              ? "This reset link is unavailable. Request another email."
              : "Could not send this email. Try again later.",
      );
    } finally {
      setBusy(false);
    }
  };
  const needsPassword = ["enroll", "sign-in", "reset"].includes(mode);
  return (
    <main className={styles.gate} data-keyboard-focus={keyboardFocus}>
      <section className={styles.card} aria-label="Pitcrew account">
        <strong className={styles.brand}>Pitcrew</strong>
        <h1 ref={heading} tabIndex={-1}>
          {titles[mode]}
        </h1>
        {mode === "enroll" && <p>Use your approved Cloudflare email.</p>}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {mode === "verify" ? (
          <p role="status">
            {busy ? "Verifying email…" : "Request another verification email to continue."}
          </p>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            {mode === "enroll" && (
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
            )}
            {mode !== "reset" && (
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
            {needsPassword && (
              <label>
                {mode === "reset" ? "New password" : "Password"}
                <input
                  ref={password}
                  type="password"
                  required
                  minLength={mode === "sign-in" ? undefined : 12}
                  maxLength={128}
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                  disabled={busy}
                />
              </label>
            )}
            <button type="submit" disabled={busy}>
              {busy
                ? "Working…"
                : mode === "enroll"
                  ? "Set password"
                  : mode === "reset"
                    ? "Reset password"
                    : mode === "request-reset" || mode === "resend"
                      ? "Send email"
                      : "Sign in"}
            </button>
          </form>
        )}
        <nav aria-label="Account actions" className={styles.actions}>
          {mode !== "sign-in" ? (
            <button type="button" disabled={busy} onClick={() => switchMode("sign-in")}>
              Back to sign in
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => switchMode("enroll")}>
              Set up account
            </button>
          )}
          {mode !== "request-reset" && (
            <button type="button" disabled={busy} onClick={() => switchMode("request-reset")}>
              Forgot password
            </button>
          )}
          {mode !== "resend" && (
            <button type="button" disabled={busy} onClick={() => switchMode("resend")}>
              Resend verification
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
