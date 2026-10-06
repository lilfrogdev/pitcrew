import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  expect(screen.queryByRole("button", { name: /Forgot password/ })).toBeNull();
});

it("sends enrollment through the Access-restricted backend with no public recovery form", async () => {
  const api = auth();
  const user = userEvent.setup();
  render(<AuthGate api={api}><div>Private work</div></AuthGate>);
  await screen.findByRole("button", { name: "Set up account" });
  await user.click(screen.getByRole("button", { name: "Set up account" }));
  await user.type(screen.getByLabelText("Name"), "Lilfrog");
  await user.type(screen.getByLabelText("Email"), "owner@example.com");
  await user.type(screen.getByLabelText("Password"), "password7890");
  await user.click(screen.getByRole("button", { name: "Set password" }));
  await waitFor(() => expect(api.enroll).toHaveBeenCalledWith("Lilfrog", "owner@example.com", "password7890"));
  expect(await screen.findByText("Account ready. Sign in.")).toBeTruthy();
});
