import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RunEvidence } from "@pitcrew/protocol";
import type { Authorization } from "./api";
import { createFixtureApi } from "./fixtures";
import { LandingControl, type LandingState } from "./LandingControl";
afterEach(cleanup);
async function fixture() {
  const api = createFixtureApi();
  const snapshot = await api.snapshot("welcome");
  return { api, run: snapshot.runs[0], evidence: snapshot.evidence[0], reviews: snapshot.reviews };
}
function Harness(
  props: Awaited<ReturnType<typeof fixture>> & { enabled?: boolean; initial?: LandingState },
) {
  const [state, setState] = useState(props.initial);
  return (
    <LandingControl
      {...props}
      enabled={props.enabled ?? true}
      state={state}
      onStateChange={setState}
    />
  );
}
function authorization(run: Awaited<ReturnType<typeof fixture>>["run"]): Authorization {
  return {
    authorizationId: "auth1",
    runId: run.id,
    expectedTargetSha: run.baseSha,
    candidateSha: run.candidateSha!,
    configurationRevision: run.configurationRevision,
    expiresAt: Date.now() + 300000,
    state: "authorized",
    backend: "fixture",
  };
}
describe("exact candidate landing simulation", () => {
  it("requires two actions and sends exact approval hashes, then only authorization id", async () => {
    const f = await fixture();
    f.api.approve = vi.fn(f.api.approve);
    f.api.land = vi.fn(f.api.land);
    render(<Harness {...f} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve exact candidate" }));
    const land = await screen.findByRole("button", { name: "Land fixture simulation" });
    expect(f.api.approve).toHaveBeenCalledWith(f.run.id, {
      expectedTargetSha: f.run.baseSha,
      candidateSha: f.run.candidateSha,
      configurationRevision: f.run.configurationRevision,
      idempotencyKey: expect.any(String),
    });
    expect(f.api.land).not.toHaveBeenCalled();
    fireEvent.click(land);
    await screen.findByText(/Fixture simulation landed/);
    expect(f.api.land).toHaveBeenCalledWith(f.run.id, expect.stringMatching(/^fixture-/));
    expect(
      screen.getByRole("button", { name: "Land fixture simulation" }).hasAttribute("disabled"),
    ).toBe(true);
  });
  it.each(["missing", "failed", "stale", "review", "disabled"] as const)(
    "fails closed with %s evidence or capability",
    async (kind) => {
      const f = await fixture();
      const evidence = structuredClone(f.evidence) as RunEvidence;
      if (kind === "missing") evidence.tests = undefined;
      if (kind === "failed") evidence.tests!.status = "failed";
      if (kind === "stale") evidence.tests!.candidateSha = "different";
      render(
        <Harness
          {...f}
          evidence={evidence}
          reviews={kind === "review" ? [] : f.reviews}
          enabled={kind !== "disabled"}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Approve exact candidate" }).hasAttribute("disabled"),
      ).toBe(true);
    },
  );
  it("blocks expired and stale authorizations", async () => {
    const f = await fixture();
    const auth = authorization(f.run);
    auth.expiresAt = Date.now() - 1;
    auth.candidateSha = "stale";
    render(<Harness {...f} initial={{ authorization: auth }} />);
    expect(
      screen.getByRole("button", { name: "Land fixture simulation" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText(/Approval expired/)).toBeTruthy();
    expect(screen.getByText(/Approval is stale/)).toBeTruthy();
  });
  it("reuses approval idempotency key after a lost response", async () => {
    const f = await fixture();
    f.api.approve = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValue(authorization(f.run));
    render(<Harness {...f} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve exact candidate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry approval receipt" }));
    await screen.findByRole("button", { name: "Land fixture simulation" });
    const calls = vi.mocked(f.api.approve).mock.calls;
    expect(calls[0][1].idempotencyKey).toBe(calls[1][1].idempotencyKey);
  });
  it("never repeats uncertain landing, and checks its receipt separately", async () => {
    const f = await fixture();
    f.api.land = vi.fn().mockRejectedValue(new Error("lost"));
    f.api.reconcile = vi
      .fn()
      .mockResolvedValue({ authorizationId: "auth1", status: "rejected", backend: "fixture" });
    render(<Harness {...f} initial={{ authorization: authorization(f.run) }} />);
    const button = screen.getByRole("button", { name: "Land fixture simulation" });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(/Fixture landing uncertain/);
    expect(f.api.land).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check landing receipt" }));
    await screen.findByText(/Fixture landing rejected/);
    expect(f.api.reconcile).toHaveBeenCalledWith(f.run.id, "auth1");
    expect(f.api.land).toHaveBeenCalledTimes(1);
  });
  it("refuses a mismatched or malformed authorization response", async () => {
    const f = await fixture();
    f.api.approve = vi.fn().mockResolvedValue({ ...authorization(f.run), expiresAt: NaN });
    render(<Harness {...f} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve exact candidate" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Approval receipt unavailable"),
    );
    expect(screen.queryByRole("button", { name: "Land fixture simulation" })).toBeNull();
  });
  it("renders persisted fixture landing after reload and disables new approval", async () => {
    const f = await fixture();
    f.run.landing = {
      authorizationId: "persisted",
      status: "landed",
      landedSha: f.run.candidateSha,
      backend: "fixture",
    };
    render(<Harness {...f} />);
    expect(screen.getByText(/Fixture simulation landed/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approve exact candidate" }).hasAttribute("disabled"),
    ).toBe(true);
  });
  it("reconciles a persisted uncertain receipt without another landing", async () => {
    const f = await fixture();
    f.run.landing = { authorizationId: "persisted", status: "uncertain", backend: "fixture" };
    f.api.land = vi.fn();
    f.api.reconcile = vi
      .fn()
      .mockResolvedValue({
        authorizationId: "persisted",
        status: "landed",
        landedSha: f.run.candidateSha,
        backend: "fixture",
      });
    render(<Harness {...f} />);
    fireEvent.click(screen.getByRole("button", { name: "Check landing receipt" }));
    await screen.findByText(/Fixture simulation landed/);
    expect(f.api.land).not.toHaveBeenCalled();
    expect(f.api.reconcile).toHaveBeenCalledWith(f.run.id, "persisted");
  });
});
