import { expect, it } from "vite-plus/test";
import { attachmentStore } from "./attachment-store";
import type { ImageAttachment } from "@pitcrew/protocol";
it("owns immutable separately stored image bytes and compares exact idempotent data", () => {
  const rows = new Map<string, ImageAttachment>();
  let id = 0;
  const store = attachmentStore(
    (key) => rows.get(key),
    (key, value) => rows.set(key, value),
    () => String(++id),
  );
  const image: ImageAttachment = {
    id: "file-1",
    name: "fixture.png",
    mediaType: "image/png",
    data: "fixture bytes",
  };
  const ref = store.put(image);
  expect(ref).toEqual({
    id: image.id,
    name: image.name,
    mediaType: image.mediaType,
    attachmentId: "1",
  });
  expect(JSON.stringify(ref)).not.toContain(image.data);
  expect(store.matches(ref, image)).toBe(true);
  image.data = "caller mutation";
  expect(store.matches(ref, image)).toBe(false);
  const read = store.get(ref);
  expect(read.data).toBe("fixture bytes");
  read.data = "returned mutation";
  expect(store.get(ref).data).toBe("fixture bytes");
  expect(() => store.get({ ...ref, name: "wrong.png" })).toThrow("attachment_unavailable");
  rows.delete(ref.attachmentId);
  expect(() => store.get(ref)).toThrow("attachment_unavailable");
});
