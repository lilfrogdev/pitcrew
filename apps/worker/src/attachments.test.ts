import { describe, expect, it } from "vite-plus/test";
import {
  validateMessageAttachments,
  ATTACHMENT_LIMITS,
  type TextAttachment,
} from "@pitcrew/protocol";
import { Coordinator, initialState } from "./coordinator";
import { api } from "./api";
const attachment = {
  id: "file-1",
  name: "notes.md",
  mediaType: "text/plain" as const,
  text: "fixture reference\n",
};
function fixture() {
  let id = 0;
  const core = new Coordinator(
    initialState(),
    () => {},
    () => "now",
    () => String(++id),
  );
  const thread = core.createThread("fixture", "thread");
  return { core, thread };
}
describe("bounded text attachment admission", () => {
  it("accepts exact byte limits without truncation and rejects aggregate/multibyte overflow", () => {
    const exact = [attachment, { ...attachment, id: "file-2" }].map((file) => ({
      ...file,
      text: "x".repeat(ATTACHMENT_LIMITS.fileBytes),
    }));
    expect(validateMessageAttachments(exact)).toEqual(exact);
    for (const files of [
      [{ ...attachment, text: "x".repeat(ATTACHMENT_LIMITS.fileBytes + 1) }],
      [{ ...attachment, text: "é".repeat(ATTACHMENT_LIMITS.fileBytes / 2 + 1) }],
      [...exact, { ...attachment, id: "file-3", text: "x" }],
    ])
      expect(() => validateMessageAttachments(files)).toThrow("attachments_too_large");
  });
  it("rejects unsupported content, binary controls, malformed Unicode, traversal and duplicate IDs", () => {
    for (const file of [
      { ...attachment, name: "../notes.md" },
      { ...attachment, name: "folder\\notes.md" },
      { ...attachment, name: "note\u0000.md" },
      { ...attachment, name: " notes.md" },
      { ...attachment, name: "file.pdf" },
      { ...attachment, mediaType: "image/png" },
      { ...attachment, text: "binary\u0000" },
      { ...attachment, text: "\ud800" },
      { ...attachment, text: "\u0081" },
      { ...attachment, url: "https://example.invalid" },
    ])
      expect(() => validateMessageAttachments([file])).toThrow();
    expect(() => validateMessageAttachments([attachment, attachment])).toThrow(
      "invalid_attachment_id",
    );
    expect(() => validateMessageAttachments(Array(5).fill(attachment))).toThrow(
      "invalid_attachments",
    );
    expect(
      (validateMessageAttachments([{ ...attachment, text: "valid\t\r\n😀" }])[0] as TextAttachment)
        .text,
    ).toBe("valid\t\r\n😀");
  });
  it("pins owned attachment bytes through submit, idempotency, begin replay and change retry", () => {
    const { core, thread } = fixture();
    const files = [{ ...attachment }];
    const first = core.submit(thread.id, "fix", "message", "fixture", files);
    files[0].text = "changed caller";
    (first.message.attachments![0] as TextAttachment).text = "changed returned message";
    const accepted = core.submit(thread.id, "fix", "message", "fixture", [{ ...attachment }]);
    expect(accepted.message.attachments).toEqual([attachment]);
    expect(() => core.submit(thread.id, "fix", "message", "fixture", files)).toThrow(
      "idempotency_conflict",
    );
    const input = core.begin(first.run.id)!;
    expect(input.messages[0].attachments).toEqual([attachment]);
    (input.messages[0].attachments![0] as TextAttachment).text = "changed worker input";
    expect(core.begin(first.run.id)!.messages[0].attachments).toEqual([attachment]);
    core.fail(first.run.id);
    const retry = core.retryChange(first.change!.id, "retry");
    expect(core.begin(retry.id)!.messages[0].attachments).toEqual([attachment]);
  });
  it("validates before persisting or dispatching, enforces bounded JSON and rejects invalid UTF8", async () => {
    const { core, thread } = fixture();
    let dispatched = 0;
    const app = api(core, () => {
      dispatched++;
    });
    const post = (body: string | ArrayBuffer) =>
      app.request(`http://localhost/api/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    const invalid = await post(
      JSON.stringify({
        destination: "team",
        content: "fix",
        idempotencyKey: "bad",
        attachments: [{ ...attachment, name: "file.pdf" }],
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "unsupported_attachment_type" });
    expect(core.state.messages).toHaveLength(0);
    expect(dispatched).toBe(0);
    expect((await post(" ".repeat(ATTACHMENT_LIMITS.requestBytes + 1))).status).toBe(413);
    expect((await post(new Uint8Array([0xff]).buffer)).status).toBe(400);
    const valid = await post(
      JSON.stringify({
        destination: "team",
        content: "fix",
        idempotencyKey: "valid",
        attachments: [
          { ...attachment, text: "x".repeat(ATTACHMENT_LIMITS.fileBytes) },
          { ...attachment, id: "file-2", text: "x".repeat(ATTACHMENT_LIMITS.fileBytes) },
        ],
      }),
    );
    expect(valid.status).toBe(201);
    expect(dispatched).toBe(0);
    expect(core.state.runs).toEqual([]);
    expect(core.state.conversationTurns ?? []).toEqual([]);
    expect((core.state.messages[0].attachments![0] as TextAttachment).text).toHaveLength(
      ATTACHMENT_LIMITS.fileBytes,
    );
  });
});
