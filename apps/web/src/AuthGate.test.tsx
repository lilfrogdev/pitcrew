import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AuthGate } from "./AuthGate";
import type { AuthApi, AuthSession } from "./auth-api";

const signedIn: AuthSession = {
  user: {
    id: "actor-1",
    name: "Lilfrog",
    username: "lilfrog",
    email: "owner@example.com",
    emailVerified: false,
    image: "/avatars/frog_green.svg",
  },
};
const setupCode = "a".repeat(42) + "A";
function auth(session: AuthSession | null = null): AuthApi {
  return {
    session: vi.fn(async () => session),
    signIn: vi.fn(async () => {}),
    enroll: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    updateUser: vi.fn(async () => {}),
  };
}
function PrivateState({ name }: { name: string }) {
  const [draft, setDraft] = useState("");
  return (
    <label>
      {name}
      <input
        aria-label="Private draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </label>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

it("shows work after a password session even when the email is unverified", async () => {
  const api = auth();
  render(
    <AuthGate api={api}>
      <div>Private work</div>
    </AuthGate>,
  );
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByText("Private work")).toBeNull();
  vi.mocked(api.session).mockResolvedValue(signedIn);
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry session" }));
  await screen.findByText("Private work");
});

it("offers only password sign-in without public signup, reset, verification, or OAuth actions", async () => {
  render(
    <AuthGate api={auth()}>
      <div>Private work</div>
    </AuthGate>,
  );
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
    "Sign in",
    "Retry session",
  ]);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByLabelText("Full name (optional)")).toBeNull();
  expect(screen.getByLabelText("Username")).toHaveProperty("autocomplete", "username");
  expect(screen.getByLabelText("Password")).toHaveProperty("autocomplete", "current-password");
  expect(screen.queryByLabelText("Email")).toBeNull();
});

it("clears a failed sign-in password without reflecting sensitive diagnostics", async () => {
  const api = auth();
  vi.mocked(api.signIn).mockRejectedValue(Error("synthetic-sensitive-diagnostic"));
  const user = userEvent.setup();
  render(
    <AuthGate api={api}>
      <div>Private work</div>
    </AuthGate>,
  );
  await screen.findByRole("heading", { name: "Sign in" });
  await user.type(screen.getByLabelText("Username"), "Owner_Handle");
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  await user.type(password, "wrong-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText("Could not sign in. Check your username and password.");
  expect(api.signIn).toHaveBeenCalledWith("owner_handle", "wrong-password");
  expect(password.value).toBe("");
  expect(screen.queryByText("Private work")).toBeNull();
  expect(document.body.textContent).not.toContain("synthetic-sensitive-diagnostic");
  expect(document.body.textContent).not.toContain("verification");
});

it("checks the session after personally entered credentials succeed", async () => {
  const api = auth();
  vi.mocked(api.signIn).mockImplementation(async () => {
    vi.mocked(api.session).mockResolvedValue(signedIn);
  });
  const user = userEvent.setup();
  render(
    <AuthGate api={api}>
      <div>Private work</div>
    </AuthGate>,
  );
  await screen.findByRole("heading", { name: "Sign in" });
  await user.type(screen.getByLabelText("Username"), "Owner_Handle");
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  await user.type(password, "synthetic-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText("Private work");
  expect(password.value).toBe("");
  expect(api.signIn).toHaveBeenCalledWith("owner_handle", "synthetic-password");
  expect(api.session).toHaveBeenCalledTimes(2);
});

it("ignores a session read started before sign-in and suppresses background checks until its final session read completes", async () => {
  const api = auth();
  let completeStale!: (value: AuthSession | null) => void;
  let completeSignIn!: () => void;
  let completeSession!: (value: AuthSession | null) => void;
  const user = userEvent.setup();
  render(
    <AuthGate api={api}>
      <div>Private work</div>
    </AuthGate>,
  );
  await screen.findByRole("heading", { name: "Sign in" });
  await user.type(screen.getByLabelText("Username"), "Owner_Handle");
  await user.type(screen.getByLabelText("Password"), "synthetic-password");
  vi.mocked(api.session).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeStale = resolve;
      }),
  );
  fireEvent(window, new Event("online"));
  vi.mocked(api.signIn).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeSignIn = resolve;
      }),
  );
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent(window, new Event("online"));
  fireEvent(window, new Event("pitcrew-auth-updated"));
  expect(api.session).toHaveBeenCalledTimes(2);
  await act(async () => completeStale(signedIn));
  expect(screen.queryByText("Private work")).toBeNull();
  expect(screen.getByRole("button", { name: "Working…" })).toHaveProperty("disabled", true);
  vi.mocked(api.session).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeSession = resolve;
      }),
  );
  await act(async () => completeSignIn());
  expect(api.session).toHaveBeenCalledTimes(3);
  fireEvent(window, new Event("online"));
  fireEvent(window, new Event("pitcrew-auth-updated"));
  expect(api.session).toHaveBeenCalledTimes(3);
  await act(async () => completeSession(signedIn));
  expect(await screen.findByText("Private work")).toBeTruthy();
});

it("strips the private setup fragment before any API request and submits the recipient-bound code under StrictMode", async () => {
  history.replaceState(null, "", `/auth/enroll#code=${setupCode}`);
  const api = auth();
  vi.mocked(api.session).mockImplementation(async () => {
    expect(location.hash).toBe("");
    expect(location.search).toBe("");
    return null;
  });
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const user = userEvent.setup();
  render(
    <StrictMode>
      <AuthGate api={api}>
        <div>Private work</div>
      </AuthGate>
    </StrictMode>,
  );
  expect(location.href).not.toContain(setupCode);
  await screen.findByRole("heading", { name: "Set up your account" });
  expect(screen.queryByLabelText("Email")).toBeNull();
  expect(screen.queryByLabelText("Code")).toBeNull();
  expect(document.body.innerHTML).not.toContain(setupCode);
  await user.type(screen.getByLabelText("Full name (optional)"), "Lilfrog");
  await user.type(screen.getByLabelText("Username"), "lilfrog");
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  await user.type(password, "synthetic-password");
  await user.click(screen.getByRole("button", { name: "Set password" }));
  await screen.findByText("Account ready. Sign in with your username and password.");
  expect(api.enroll).toHaveBeenCalledOnce();
  expect(api.enroll).toHaveBeenCalledWith("Lilfrog", "lilfrog", setupCode, "synthetic-password");
  expect(api.signIn).not.toHaveBeenCalled();
  expect(password.value).toBe("");
  expect(location.pathname).toBe("/");
  expect(storage).not.toHaveBeenCalled();
});

it.each([
  "/auth/enroll",
  `/auth/enroll?code=${setupCode}`,
  "/auth/enroll#code=invalid",
  `/auth/enroll#code=${"a".repeat(43)}`,
  `/auth/enroll#code=${setupCode}&code=${setupCode}`,
])("does not offer enrollment for an unavailable setup link: %s", async (path) => {
  history.replaceState(null, "", path);
  const api = auth();
  render(
    <AuthGate api={api}>
      <div>Private work</div>
    </AuthGate>,
  );
  await screen.findByText(
    "This account setup link is unavailable. Ask for a new private setup link.",
  );
  expect(location.hash).toBe("");
  expect(location.search).toBe("");
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(screen.queryByRole("button", { name: "Set password" })).toBeNull();
  expect(api.enroll).not.toHaveBeenCalled();
});

it("allows an enrollment retry without retaining passwords or leaking the setup code", async () => {
  history.replaceState(null, "", `/auth/enroll#code=${setupCode}`);
  const api = auth();
  vi.mocked(api.enroll).mockRejectedValueOnce(Error(`private ${setupCode}`));
  const user = userEvent.setup();
  render(
    <AuthGate api={api}>
      <div>Private work</div>
    </AuthGate>,
  );
  await screen.findByLabelText("Full name (optional)");
  await user.type(screen.getByLabelText("Full name (optional)"), "Lilfrog");
  await user.type(screen.getByLabelText("Username"), "lilfrog");
  await user.type(screen.getByLabelText("Password"), "synthetic-password");
  await user.click(screen.getByRole("button", { name: "Set password" }));
  await screen.findByText(
    "Could not set up this account. Check your details and private setup link.",
  );
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
  expect(document.body.textContent).not.toContain(setupCode);
  await user.type(screen.getByLabelText("Password"), "another-synthetic-password");
  await user.click(screen.getByRole("button", { name: "Set password" }));
  await screen.findByRole("heading", { name: "Sign in" });
  expect(api.enroll).toHaveBeenLastCalledWith(
    "Lilfrog",
    "lilfrog",
    setupCode,
    "another-synthetic-password",
  );
});

it("removes legacy auth links without offering unavailable email flows", async () => {
  history.replaceState(null, "", "/auth/reset#token=synthetic-reset-token");
  render(
    <AuthGate api={auth()}>
      <div>Private work</div>
    </AuthGate>,
  );
  await screen.findByRole("heading", { name: "Sign in" });
  expect(location.pathname).toBe("/");
  expect(location.hash).toBe("");
  expect(document.body.textContent).not.toContain("synthetic-reset-token");
  expect(screen.queryByRole("button", { name: /reset|resend|verify/i })).toBeNull();
});

it("clears passwords when the form unmounts", async () => {
  const view = render(
    <AuthGate api={auth()}>
      <div>Private work</div>
    </AuthGate>,
  );
  const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
  await userEvent.setup().type(password, "synthetic-password");
  view.unmount();
  expect(password.value).toBe("");
});

it("remounts private state for a different account while preserving same-account profile updates", async () => {
  const api = auth(signedIn);
  const user = userEvent.setup();
  render(<AuthGate api={api}>{(account) => <PrivateState name={account.name} />}</AuthGate>);
  await screen.findByLabelText("Private draft");
  await user.type(screen.getByLabelText("Private draft"), "Owner’s private draft");
  vi.mocked(api.session).mockResolvedValue({ user: { ...signedIn.user, name: "Updated owner" } });
  fireEvent(window, new Event("pitcrew-auth-updated"));
  await screen.findByText("Updated owner");
  expect(screen.getByLabelText("Private draft")).toHaveProperty("value", "Owner’s private draft");
  vi.mocked(api.session).mockResolvedValue({
    user: { ...signedIn.user, id: "bryan", name: "Bryan" },
  });
  fireEvent(window, new Event("online"));
  await screen.findByText("Bryan");
  expect(screen.getByLabelText("Private draft")).toHaveProperty("value", "");
});

it("drops private work immediately on logout or revocation and resets it even for the same account", async () => {
  const api = auth(signedIn);
  const user = userEvent.setup();
  render(<AuthGate api={api}>{(account) => <PrivateState name={account.name} />}</AuthGate>);
  await screen.findByLabelText("Private draft");
  await user.type(screen.getByLabelText("Private draft"), "Owner’s private draft");
  let complete: (value: AuthSession | null) => void = () => {};
  vi.mocked(api.session).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  fireEvent(window, new Event("pitcrew-auth-required"));
  expect(screen.queryByLabelText("Private draft")).toBeNull();
  expect(screen.getByText("Checking session…")).toBeTruthy();
  await act(async () => complete(null));
  await screen.findByRole("heading", { name: "Sign in" });
  vi.mocked(api.session).mockResolvedValue(signedIn);
  await user.click(screen.getByRole("button", { name: "Retry session" }));
  await screen.findByLabelText("Private draft");
  expect(screen.getByLabelText("Private draft")).toHaveProperty("value", "");
});

it("ignores a stale session response after revocation", async () => {
  const api = auth(signedIn);
  render(
    <AuthGate api={api}>
      <div>Private work</div>
    </AuthGate>,
  );
  await screen.findByText("Private work");
  let complete: (value: AuthSession | null) => void = () => {};
  vi.mocked(api.session).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  fireEvent(window, new Event("online"));
  vi.mocked(api.session).mockResolvedValue(null);
  fireEvent(window, new Event("pitcrew-auth-required"));
  await screen.findByRole("heading", { name: "Sign in" });
  await act(async () => complete(signedIn));
  expect(screen.queryByText("Private work")).toBeNull();
});

it("does not revive work when a pending sign-in finishes after auth is required", async () => {
  const api = auth();
  let complete: () => void = () => {};
  vi.mocked(api.signIn).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const user = userEvent.setup();
  render(
    <AuthGate api={api}>
      <div>Private work</div>
    </AuthGate>,
  );
  await screen.findByRole("heading", { name: "Sign in" });
  await user.type(screen.getByLabelText("Username"), "Owner_Handle");
  await user.type(screen.getByLabelText("Password"), "synthetic-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent(window, new Event("pitcrew-auth-required"));
  await screen.findByRole("heading", { name: "Sign in" });
  vi.mocked(api.session).mockResolvedValue(signedIn);
  await act(async () => complete());
  expect(api.session).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Private work")).toBeNull();
  expect(screen.getByLabelText("Username")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
});

it.each(["ab", "two-words", "élise"])(
  "rejects invalid username %s before sign-in",
  async (username) => {
    const api = auth();
    const user = userEvent.setup();
    render(
      <AuthGate api={api}>
        <div>Private work</div>
      </AuthGate>,
    );
    const input = await screen.findByLabelText("Username");
    expect(input).toHaveProperty("minLength", 3);
    expect(input).toHaveProperty("maxLength", 32);
    expect(input).toHaveProperty("pattern", "[a-zA-Z0-9_]{3,32}");
    await user.type(input, username);
    await user.type(screen.getByLabelText("Password"), "synthetic-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(api.signIn).not.toHaveBeenCalled();
  },
);

it("enrolls with a canonical username and an optional full name", async () => {
  history.replaceState(null, "", `/auth/enroll#code=${setupCode}`);
  const api = auth();
  const user = userEvent.setup();
  render(
    <AuthGate api={api}>
      <div>Private work</div>
    </AuthGate>,
  );
  const name = await screen.findByLabelText("Full name (optional)");
  expect(name).toHaveProperty("required", false);
  expect(screen.getByLabelText("Password")).toHaveProperty("autocomplete", "new-password");
  await user.type(screen.getByLabelText("Username"), "Crew_Mate");
  await user.type(screen.getByLabelText("Password"), "synthetic-password");
  await user.click(screen.getByRole("button", { name: "Set password" }));
  await screen.findByRole("heading", { name: "Sign in" });
  expect(api.enroll).toHaveBeenCalledExactlyOnceWith(
    "",
    "crew_mate",
    setupCode,
    "synthetic-password",
  );
});
