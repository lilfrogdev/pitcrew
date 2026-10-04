/// <reference types="node" />
import { afterEach, expect, it, vi } from "vite-plus/test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { webcrypto } from "node:crypto";
import { Intake } from "./Intake";
import { Coordinator, initialState, fakeExecution } from "../../worker/src/coordinator";
import { api } from "../../worker/src/api";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("collects two sources, explicitly groups and dispatches with criteria through the HTTP API", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const core = new Coordinator(initialState(), () => {});
  const app = api(core, (id) => core.dispatch(id, fakeExecution));
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) =>
    path === "/api/local-session"
      ? Promise.resolve(Response.json({ nonce: null }))
      : app.request(`http://localhost${path}`, init),
  );
  const onDispatch = vi.fn(),
    user = userEvent.setup();
  render(<Intake projectId="pitcrew" onDispatch={onDispatch} />);
  const collect = async (text: string) => {
    await user.type(screen.getByLabelText("Original report"), text);
    await user.click(screen.getByRole("button", { name: "Collect report" }));
    await screen.findByRole("checkbox", { name: text });
  };
  await collect("Save failure one");
  await collect("Save failure two");
  expect(core.state.runs).toHaveLength(0);
  await user.click(screen.getByRole("checkbox", { name: "Save failure two" }));
  await user.selectOptions(screen.getByLabelText("Move selected reports to"), core.groups()[0].id);
  await user.click(screen.getByRole("button", { name: "Move reports" }));
  await waitFor(() => expect(core.groups()[0].reports).toHaveLength(2));
  await user.type(screen.getByLabelText("Acceptance criterion"), "Both originals remain traceable");
  await user.click(screen.getByRole("button", { name: "Dispatch problem" }));
  await waitFor(() => expect(onDispatch).toHaveBeenCalledOnce());
  expect(core.state.runs).toHaveLength(1);
  expect(core.evidence(core.state.runs[0].id).verification!.plan.acceptance.criteria[0].text).toBe(
    "Both originals remain traceable",
  );
  await user.click(screen.getByRole("button", { name: "Dispatch problem" }));
  await waitFor(() => expect(onDispatch).toHaveBeenCalledTimes(2));
  expect(core.state.runs).toHaveLength(1);
});
it("retries an uncertain report delivery with the same source identity and timestamp", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const core = new Coordinator(initialState(), () => {}),
    app = api(core, () => {});
  let uncertain = true;
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (path === "/api/local-session") return Response.json({ nonce: null });
    const response = await app.request(`http://localhost${path}`, init);
    if (path.endsWith("/reports") && uncertain) {
      uncertain = false;
      throw Error("lost response");
    }
    return response;
  });
  const user = userEvent.setup();
  render(<Intake projectId="pitcrew" onDispatch={() => {}} />);
  await user.type(screen.getByLabelText("Original report"), "Original");
  await user.click(screen.getByRole("button", { name: "Collect report" }));
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "Collect report" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(core.state.intake!.reports).toHaveLength(1);
});
