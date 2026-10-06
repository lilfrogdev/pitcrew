import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import type { Api, Snapshot } from "./api";
import { saveLandingState } from "./landing-storage";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
async function mount(api: Api = createFixtureApi()) {
  render(<App api={api} demo />);
  await screen.findByRole("heading", { name: "Make agent work visible" });
  await screen.findByText("Show the work behind a change, from delegation to review.");
  return api;
}
describe("project conversations", () => {
  it("recovers an unconsumed approval after a crash before sending, then requires an explicit landing", async () => {
    const api = createFixtureApi();
    const capabilities = api.capabilities;
    api.capabilities = async () => ({ ...await capabilities(), landing: { enabled: true, backend: "artifacts" } });
    const run = (await api.snapshot("welcome")).runs[0];
    const auth = { authorizationId: "unconsumed", runId: run.id, expectedTargetSha: run.baseSha,
      candidateSha: run.candidateSha!, configurationRevision: run.configurationRevision,
      expiresAt: Date.now() + 300000, backend: "artifacts" as const, state: "authorized" as const };
    const fingerprint = JSON.stringify([run.id, run.baseSha, run.candidateSha, run.configurationRevision, "artifacts"]);
    saveLandingState("fixture-local", "pitcrew", run.id, { key: "original-key", fingerprint, authorization: auth, busy: true });
    api.reconcile = vi.fn().mockRejectedValue(Error("LANDING_NOT_STARTED"));
    api.approve = vi.fn().mockResolvedValue(auth);
    api.land = vi.fn().mockResolvedValue({ authorizationId: auth.authorizationId, backend: "artifacts",
      status: "landed", landedSha: run.candidateSha });
    await mount(api);
    fireEvent.click(screen.getByRole("tab", { name: "Review / PR" }));
    fireEvent.click(screen.getByRole("button", { name: "Check landing receipt" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Land approved candidate" }).hasAttribute("disabled")).toBe(false));
    expect(api.approve).toHaveBeenCalledExactlyOnceWith(run.id, { expectedTargetSha: run.baseSha,
      candidateSha: run.candidateSha, configurationRevision: run.configurationRevision, idempotencyKey: "original-key" });
    expect(api.land).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Land approved candidate" }));
    await screen.findByText(/Source repository landed/);
    expect(api.land).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost source receipt on reload for its account without replaying landing", async () => {
    const api = createFixtureApi();
    const capabilities = api.capabilities;
    api.capabilities = async () => ({ ...await capabilities(), landing: { enabled: true, backend: "artifacts" } });
    const proposal = await api.snapshot("welcome");
    const run = proposal.runs[0];
    const owner = { id: "owner", name: "Owner", email: "owner@fixture.example", emailVerified: true, image: null };
    api.approve = vi.fn().mockResolvedValue({ authorizationId: "pending-source", runId: run.id,
      expectedTargetSha: run.baseSha, candidateSha: run.candidateSha, configurationRevision: run.configurationRevision,
      expiresAt: Date.now() + 300000, backend: "artifacts", state: "authorized" });
    api.land = vi.fn().mockRejectedValue(Error("Response lost"));
    api.reconcile = vi.fn().mockResolvedValue({ authorizationId: "pending-source", backend: "artifacts",
      status: "landed", landedSha: run.candidateSha });
    const openReview = async () => { await screen.findByRole("heading", { name: "Make agent work visible" });
      fireEvent.click(screen.getByRole("tab", { name: "Review / PR" })); };
    render(<App api={api} demo viewer={owner} />);
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Approve exact candidate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Land approved candidate" }));
    await screen.findByText(/Landing uncertain/);
    cleanup();
    // The actual backend snapshot has no run.landing for an uncertain operation.
    expect((await api.snapshot("welcome")).runs[0].landing).toBeUndefined();
    render(<App api={api} demo viewer={{ ...owner, id: "bryan" }} />);
    await openReview();
    expect(screen.queryByRole("button", { name: "Check landing receipt" })).toBeNull();
    cleanup();
    render(<App api={api} demo viewer={owner} />);
    await openReview();
    expect(screen.getByRole("button", { name: "Land approved candidate" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Completed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check landing receipt" }));
    await screen.findByText(/Source repository landed/);
    expect(api.land).toHaveBeenCalledTimes(1);
    expect(api.approve).toHaveBeenCalledTimes(1);
    expect(api.reconcile).toHaveBeenCalledExactlyOnceWith(run.id, "pending-source");
  });
  it("blocks a source write when its recovery receipt cannot be saved", async () => {
    const api = createFixtureApi();
    const capabilities = api.capabilities;
    api.capabilities = async () => ({ ...await capabilities(), landing: { enabled: true, backend: "artifacts" } });
    api.approve = vi.fn(); api.land = vi.fn();
    await mount(api);
    fireEvent.click(screen.getByRole("tab", { name: "Review / PR" }));
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("quota"); });
    fireEvent.click(screen.getByRole("button", { name: "Approve exact candidate" }));
    await screen.findByText(/Could not save the landing receipt/);
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.land).not.toHaveBeenCalled();
    storage.mockRestore();
  });
  it("enables reviewed Artifacts landing and updates completion only after its exact receipt", async () => {
    const api = createFixtureApi();
    const capabilities = api.capabilities;
    api.capabilities = async () => ({ ...await capabilities(), landing: { enabled: true, backend: "artifacts" } });
    const proposal = await api.snapshot("welcome");
    const run = proposal.runs[0];
    api.approve = vi.fn().mockResolvedValue({ authorizationId: "source-approval", runId: run.id,
      expectedTargetSha: run.baseSha, candidateSha: run.candidateSha,
      configurationRevision: run.configurationRevision, expiresAt: Date.now() + 300000,
      backend: "artifacts", state: "authorized" });
    api.land = vi.fn().mockResolvedValue({ authorizationId: "source-approval", backend: "artifacts",
      status: "landed", landedSha: run.candidateSha });
    await mount(api);
    fireEvent.click(screen.getByRole("tab", { name: "Review / PR" }));
    expect(screen.queryByText("Completed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve exact candidate" }));
    const land = await screen.findByRole("button", { name: "Land approved candidate" });
    expect(screen.queryByText("Completed")).toBeNull();
    fireEvent.click(land);
    await screen.findByText(/Source repository landed/);
    expect(within(screen.getByLabelText("Change evidence")).getByText("Completed")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Completed" })).toBeTruthy();
    expect(api.land).toHaveBeenCalledExactlyOnceWith(run.id, "source-approval");
  });
  it("never labels a completed proposal without a landed receipt as completed", async () => {
    const api = createFixtureApi();
    const snapshot = api.snapshot;
    api.snapshot = async (id) => { const value = await snapshot(id);
      value.runs = value.runs.map((run) => ({ ...run, status: "completed" })); return value; };
    await mount(api);
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.queryByRole("img", { name: "Completed" })).toBeNull();
    expect(screen.getByRole("img", { name: "Awaiting review" })).toBeTruthy();
  });
  it("shows visible roles, exact hashes, tests, review, and gated fixture approval", async () => {
    await mount();
    expect(screen.getByText("Repository agent")).toBeTruthy();
    expect(screen.getByText("Change worker")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Review / PR" }));
    fireEvent.click(screen.getByText("Tests and tool output"));
    expect(screen.getByText(/8 synthetic checks passed/)).toBeTruthy();
    expect(screen.getByText(/Matches current candidate/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approve exact candidate" }).hasAttribute("disabled"),
    ).toBe(false);
  });
  it("switches projects and threads, preserves drafts, and creates an empty thread", async () => {
    const user = userEvent.setup();
    await mount();
    await user.type(screen.getByLabelText("Message your crew"), "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Recover interrupted work" }));
    await screen.findByText(/Worker execution stopped/);
    expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "Make agent work visible" }));
    expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(
      "Keep this draft",
    );
    await user.click(screen.getByRole("button", { name: "Playground · synthetic/example" }));
    await screen.findByRole("heading", { name: "Explore an isolated change" });
    await user.click(screen.getByRole("button", { name: "New conversation in Playground" }));
    await user.type(screen.getByLabelText("Conversation title"), "New change");
    await user.click(screen.getByRole("button", { name: /^Create$/ }));
    await screen.findByRole("heading", { name: "New change" });
    await screen.findByText("Start with the outcome");
  });
  it("submits once and retains the idempotency key after an uncertain write", async () => {
    const api = createFixtureApi();
    const original = api.send;
    const send = vi
      .fn()
      .mockImplementationOnce(async (id: string, content: string, key: string) => {
        await original(id, content, key);
        throw new Error("Uncertain response");
      })
      .mockImplementation(original);
    api.send = send;
    const user = userEvent.setup();
    await mount(api);
    await user.type(screen.getByLabelText("Message your crew"), "Add a useful change");
    await user.click(screen.getByRole("button", { name: /Send message/ }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(
      "Add a useful change",
    );
    await user.click(screen.getByRole("button", { name: /Send message/ }));
    await waitFor(() =>
      expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(""),
    );
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
    expect(screen.getAllByText("Add a useful change")).toHaveLength(1);
    expect(within(screen.getByLabelText("Change evidence")).getByText("Queued")).toBeTruthy();
  });
  it("reconnects without replaying a message and keeps the selected thread", async () => {
    const api = createFixtureApi();
    const snapshot = api.snapshot;
    api.send = vi.fn(api.send);
    const user = userEvent.setup();
    await mount(api);
    await user.click(screen.getByRole("button", { name: "Recover interrupted work" }));
    await screen.findByText(/Worker execution stopped/);
    api.snapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline test"))
      .mockImplementation(snapshot);
    fireEvent(window, new Event("online"));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("heading", { name: "Recover interrupted work" })).toBeTruthy();
    expect(api.send).not.toHaveBeenCalled();
  });
  it("ignores old conversation responses after navigation", async () => {
    const api = createFixtureApi();
    const original = api.snapshot;
    let resolveOld: (value: Snapshot) => void = () => {};
    api.snapshot = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Snapshot>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementation(original);
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Make agent work visible" });
    fireEvent.click(screen.getByRole("button", { name: "Recover interrupted work" }));
    await screen.findByText(/Worker execution stopped/);
    resolveOld(await original("welcome"));
    await waitFor(() =>
      expect(
        screen.queryByText("Show the work behind a change, from delegation to review."),
      ).toBeNull(),
    );
  });
  it("recovers a denied initial connection without presenting fixture access", async () => {
    const api = createFixtureApi();
    api.projects = vi
      .fn()
      .mockRejectedValueOnce(new Error("Access denied"))
      .mockImplementation(api.projects);
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("alert");
    expect(screen.queryByText("Synthetic preview")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    await screen.findByRole("heading", { name: "Make agent work visible" });
  });
});
