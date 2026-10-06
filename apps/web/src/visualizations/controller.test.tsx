import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render } from "@testing-library/react";
import { VisualizationController, type VisualizationSource } from "./controller";
import { VisualizationWorkspace } from "./VisualizationWorkspace";

const source: VisualizationSource = {
  accountId: "account:viewer",
  repositoryId: "repo",
  threadId: "thread",
  load: async () => envelope,
};
const artifact = {
  id: "chart",
  version: 1,
  repositoryId: "repo",
  threadId: "thread",
  creatorActor: "account:creator",
  turnId: "turn",
  invocationId: "call",
  createdAt: 1,
  revision: 1,
  digest: "a".repeat(64),
  content: {
    kind: "bars",
    title: "Private chart",
    summary: "Private fallback",
    height: 320,
    points: [{ label: "One", value: 1 }],
  },
};
const envelope = {
  accountId: source.accountId,
  repositoryId: source.repositoryId,
  threadId: source.threadId,
  accessEpoch: "epoch",
  leaseMs: 5000,
  artifacts: [artifact],
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("visualization access lifetime", () => {
  it.each(["account", "repository", "thread", "transport", "revocation"])(
    "discards a late response after %s changes",
    async (change) => {
      const controller = new VisualizationController();
      let release!: (value: unknown) => void;
      const pendingSource = {
        ...source,
        load: () =>
          new Promise<unknown>((resolve) => {
            release = resolve;
          }),
      };
      controller.configure(pendingSource);
      const pending = controller.revalidate();
      if (change === "revocation") controller.invalidate();
      else
        controller.configure({
          ...source,
          ...(change === "account"
            ? { accountId: "account:other" }
            : change === "repository"
              ? { repositoryId: "other" }
              : change === "thread"
                ? { threadId: "other" }
                : { load: async () => envelope }),
        });
      release(envelope);
      await pending;
      expect(controller.getSnapshot()).toBeNull();
      controller.dispose();
    },
  );
  it("expires an outstanding lease even if revalidation hangs", async () => {
    vi.useFakeTimers();
    let clock = 0,
      calls = 0;
    const controller = new VisualizationController(() => clock);
    controller.configure({
      ...source,
      load: async () => {
        if (++calls > 1) return new Promise(() => {});
        return envelope;
      },
    });
    await controller.revalidate();
    expect(controller.getSnapshot()).not.toBeNull();
    clock = 2500;
    await vi.advanceTimersByTimeAsync(2500);
    clock = 5000;
    await vi.advanceTimersByTimeAsync(2500);
    expect(controller.getSnapshot()).toBeNull();
    controller.dispose();
  });
  it("rejects mismatched responses, invalid leases and responses arriving past their lease", async () => {
    const controller = new VisualizationController(() => 10000);
    for (const value of [
      { ...envelope, accountId: "wrong" },
      { ...envelope, threadId: "wrong" },
      { ...envelope, leaseMs: 10000 },
    ]) {
      controller.configure({ ...source, load: async () => value });
      await controller.revalidate();
      expect(controller.getSnapshot()).toBeNull();
    }
    let clock = 0;
    const delayed = new VisualizationController(() => clock);
    delayed.configure({
      ...source,
      load: async () => {
        clock = 5001;
        return envelope;
      },
    });
    await delayed.revalidate();
    expect(delayed.getSnapshot()).toBeNull();
    delayed.dispose();
    controller.dispose();
  });
  it.each(["pitcrew-auth-required", "pitcrew-access-lost", "offline"])(
    "removes running frames AND private fallback on %s",
    async (event) => {
      const view = render(<VisualizationWorkspace source={source} authorized />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(view.container.querySelectorAll("iframe")).toHaveLength(1);
      expect(view.container.textContent).toContain("Private fallback");
      act(() => window.dispatchEvent(new Event(event)));
      expect(view.container.querySelectorAll("iframe")).toHaveLength(0);
      expect(view.container.textContent).not.toContain("Private fallback");
      expect(view.container.textContent).not.toContain("Private chart");
    },
  );
  it("clears on hidden document, prop authorization loss, context replacement and unmount", async () => {
    const view = render(<VisualizationWorkspace source={source} authorized />);
    await act(async () => {
      await Promise.resolve();
    });
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(view.container.querySelector("iframe")).toBeNull();
    vi.restoreAllMocks();
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.querySelector("iframe")).not.toBeNull();
    view.rerender(<VisualizationWorkspace source={source} authorized={false} />);
    expect(view.container.textContent).not.toContain("Private chart");
    view.rerender(<VisualizationWorkspace source={{ ...source, threadId: "other" }} authorized />);
    expect(view.container.querySelector("iframe")).toBeNull();
    view.unmount();
  });
  it("mounts at most two frames and uses passive native disclosure for documents", async () => {
    const docs = {
      ...artifact,
      id: "doc",
      content: {
        kind: "document",
        title: "Notes",
        summary: "Explanation",
        height: 320,
        nodes: [
          {
            tag: "details",
            children: [{ tag: "summary", children: [{ text: "Expand" }] }, { text: "Safe body" }],
          },
        ],
      },
    };
    const many = {
      ...source,
      load: async () => ({
        ...envelope,
        artifacts: [artifact, docs, { ...artifact, id: "third" }],
      }),
    };
    const view = render(<VisualizationWorkspace source={many} authorized />);
    await act(async () => {
      await Promise.resolve();
    });
    const frames = view.container.querySelectorAll("iframe");
    expect(frames).toHaveLength(2);
    expect(frames[1].getAttribute("sandbox")).toBe("");
    expect(frames[1].getAttribute("srcdoc")).toContain("<details>");
    expect(frames[1].getAttribute("srcdoc")).not.toContain("<script");
    expect(view.container.textContent).toContain("1 additional");
  });
});
