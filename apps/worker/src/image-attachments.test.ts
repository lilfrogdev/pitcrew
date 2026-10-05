import { expect, it } from "vite-plus/test";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import {
  imageDimensions,
  validateMessageAttachments,
  ATTACHMENT_LIMITS,
  TEXT_ATTACHMENT_CAPABILITIES,
} from "@pitcrew/protocol";
import { buildAttachmentPrompt, nativeAttachmentInput, attachmentPolicy } from "./pi-drivers";
import { configureModels } from "./pi-models";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const jpeg =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z";
const webp =
  "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=";
const image = { id: "image-1", name: "fixture.png", mediaType: "image/png" as const, data: png };
it("validates canonical image formats and rejects model incompatibility, forged MIME and oversized dimensions", () => {
  expect(imageDimensions(png, "image/png")).toEqual({ width: 1, height: 1 });
  expect(imageDimensions(jpeg, "image/jpeg")).toEqual({ width: 1, height: 1 });
  expect(imageDimensions(webp, "image/webp")).toEqual({ width: 1, height: 1 });
  expect(validateMessageAttachments([image])).toEqual([image]);
  expect(() => validateMessageAttachments([image], TEXT_ATTACHMENT_CAPABILITIES)).toThrow(
    "attachment_images_unsupported",
  );
  for (const malformed of [
    { ...image, data: "not base64" },
    { ...image, data: "" },
    { ...image, data: png.slice(0, -4) },
    { ...image, name: "fixture.webp", mediaType: "image/webp" },
    { ...image, data: btoa("<svg onload='attack'>") },
  ])
    expect(() => validateMessageAttachments([malformed])).toThrow();
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  new DataView(bytes.buffer).setUint32(16, 100000);
  expect(() => imageDimensions(btoa(String.fromCharCode(...bytes)), "image/png")).toThrow(
    "invalid_attachment_image",
  );
});
it("requires authorized immutable image lookup and bounds actual native serialized records", async () => {
  const ref = {
    id: image.id,
    name: image.name,
    mediaType: image.mediaType,
    attachmentId: "blob-1",
  };
  const messages = [
    {
      id: "m1",
      role: "user" as const,
      threadId: "t1",
      content: "Inspect this fixture",
      createdAt: "now",
      attachments: [ref],
    },
  ];
  await expect(buildAttachmentPrompt(messages)).rejects.toThrow("attachment_unavailable");
  await expect(
    buildAttachmentPrompt(messages, async () => ({ ...image, id: "wrong" })),
  ).rejects.toThrow("attachment_unavailable");
  const built = await buildAttachmentPrompt(messages, async () => image);
  expect(built.textMessages).toEqual(messages);
  expect(built.images).toEqual([{ type: "image", data: png, mimeType: "image/png" }]);
  expect(() =>
    nativeAttachmentInput("x".repeat(ATTACHMENT_LIMITS.nativeInputBytes), built.images),
  ).toThrow("attachment_context_too_large");
});
it("delivers a synthetic screenshot through the actual durable Pi native image channel without network", async () => {
  let observed: UserInput | undefined;
  const faux = fauxProvider({
    provider: "fixture-vision",
    models: [{ id: "fixture-vision", input: ["text", "image"] }],
  });
  faux.setResponses([
    (context) => {
      observed = context.messages.find((message) => message.role === "user")?.content;
      return fauxAssistantMessage("Synthetic screenshot inspected");
    },
  ]);
  const { models, model } = configureModels({ provider: "fake" }, {}, faux.provider);
  const context = {
    abortSignal: AbortSignal.timeout(5000),
    value: () => undefined,
    toString: () => "[Synthetic vision QA]",
  };
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    context,
  );
  try {
    const conversation = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const input = nativeAttachmentInput(
      JSON.stringify({ task: "Inspect synthetic fixture", attachmentPolicy }),
      [{ type: "image", data: png, mimeType: "image/png" }],
    );
    const receipt = await conversation.submit(
      { type: "input", requestId: "synthetic-image", content: input },
      context,
    );
    await receipt.wait(context);
    await conversation.waitForIdle(context);
    expect(observed).toEqual(input);
    expect(faux.state.callCount).toBe(1);
    const replay = await conversation.submit(
      { type: "input", requestId: "synthetic-image", content: input },
      context,
    );
    expect(replay.id).toBe(receipt.id);
    expect(faux.state.callCount).toBe(1);
  } finally {
    await harness.close(context);
  }
});
