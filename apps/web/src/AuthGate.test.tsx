import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AuthGate } from "./AuthGate";
import type { AuthApi, AuthSession } from "./auth-api";

const signedIn: AuthSession = { user: {
  id: "actor-1", name: "Lilfrog", email: "owner@example.com", emailVerified: true,
  image: "https://example.com/avatar.png",
} };
function auth(session: AuthSession | null = null): AuthApi {
  return {
    session: vi.fn(async () => session),
    signIn: vi.fn(async () => {}),
    enroll: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    verifyEmail: vi.fn(async () => {}),
    resendVerification: vi.fn(async () => {}),
    requestPasswordReset: vi.fn(async () => {}),
    resetPassword: vi.fn(async () => {}),
    updateUser: vi.fn(async () => {}),
  };
}
afterEach(() => { cleanup(); history.replaceState(null, "", "/"); });

it("shows work only after a verified session is returned", async () => {
  const api = auth();
  const view = render(<AuthGate api={api}><div>Private work</div></AuthGate>);
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByText("Private work")).toBeNull();
  vi.mocked(api.session).mockResolvedValue(signedIn);
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry session" }));
  await screen.findByText("Private work");
  view.unmount();
});

it("signs in without retaining the entered password or exposing private work", async () => {
  const api = auth();
  const user = userEvent.setup();
  render(<AuthGate api={api}><div>Private work</div></AuthGate>);
  await screen.findByRole("heading", { name: "Sign in" });
  await user.type(screen.getByLabelText("Email"), "owner@example.com");
  await user.type(screen.getByLabelText("Password"), "password1234");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(api.signIn).toHaveBeenCalledWith("owner@example.com", "password1234"));
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  expect(screen.queryByText("Private work")).toBeNull();
  expect(screen.getByRole("button", { name: "Forgot password" })).toBeTruthy();
});

it("enrolls a username through the Access-restricted backend", async () => {
  const api = auth();
  const user = userEvent.setup();
  render(<AuthGate api={api}><div>Private work</div></AuthGate>);
  await screen.findByRole("button", { name: "Set up account" });
  await user.click(screen.getByRole("button", { name: "Set up account" }));
  await user.type(screen.getByLabelText("Name"), "Lilfrog");
  await user.type(screen.getByLabelText("Username"), "lilfrog");
  await user.type(screen.getByLabelText("Email"), "owner@example.com");
  await user.type(screen.getByLabelText("Password"), "password7890");
  await user.click(screen.getByRole("button", { name: "Set password" }));
  await waitFor(() => expect(api.enroll).toHaveBeenCalledWith("Lilfrog", "lilfrog", "owner@example.com", "password7890"));
  expect(await screen.findByText("Check your email to verify your account, then sign in.")).toBeTruthy();
});

it("strips a verification fragment before checking or redeeming it", async () => {
  history.replaceState(null, "", "/auth/verify#token=synthetic-verification-token");
  const api = auth();
  vi.mocked(api.verifyEmail).mockImplementation(async (token) => {
    expect(location.hash).toBe("");
    expect(token).toBe("synthetic-verification-token");
  });
  render(<AuthGate api={api}><div>Private work</div></AuthGate>);
  expect(location.href).not.toContain("synthetic-verification-token");
  expect(await screen.findByText("Email verified. Sign in.")).toBeTruthy();
  expect(api.verifyEmail).toHaveBeenCalledOnce();
});

it("clears reset secrets and recovers from an expired reset link", async () => {
  history.replaceState(null, "", "/auth/reset#token=synthetic-reset-token");
  const api = auth();
  vi.mocked(api.resetPassword).mockRejectedValue(Error("expired"));
  const user = userEvent.setup();
  render(<AuthGate api={api}><div>Private work</div></AuthGate>);
  await screen.findByRole("heading", { name: "Choose a new password" });
  await user.type(screen.getByLabelText("New password"), "synthetic-new-password");
  await user.click(screen.getByRole("button", { name: "Reset password" }));
  expect(await screen.findByText("This reset link is unavailable. Request another email.")).toBeTruthy();
  expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
  expect(location.hash).toBe("");
  await user.click(screen.getByRole("button", { name: "Forgot password" }));
  await user.type(screen.getByLabelText("Email"), "owner@example.com");
  await user.click(screen.getByRole("button", { name: "Send email" }));
  expect(api.requestPasswordReset).toHaveBeenCalledWith("owner@example.com");
});

it("remounts private state for a different account while preserving same-account profile updates", async () => {
  const api = auth(signedIn);
  function PrivateState({ name }: { name: string }) {
    const [draft, setDraft] = useState("");
    return <label>{name}<input aria-label="Private draft" value={draft} onChange={(event) => setDraft(event.target.value)} /></label>;
  }
  const user = userEvent.setup();
  render(<AuthGate api={api}>{(account) => <PrivateState name={account.name} />}</AuthGate>);
  await screen.findByLabelText("Private draft");
  await user.type(screen.getByLabelText("Private draft"), "Owner’s private draft");
  vi.mocked(api.session).mockResolvedValue({ user: { ...signedIn.user, name: "Updated owner" } });
  fireEvent(window, new Event("pitcrew-auth-updated"));
  await screen.findByText("Updated owner");
  expect(screen.getByLabelText("Private draft")).toHaveProperty("value", "Owner’s private draft");
  vi.mocked(api.session).mockResolvedValue({ user: { ...signedIn.user, id: "bryan", name: "Bryan" } });
  fireEvent(window, new Event("online"));
  await screen.findByText("Bryan");
  expect(screen.getByLabelText("Private draft")).toHaveProperty("value", "");
});
