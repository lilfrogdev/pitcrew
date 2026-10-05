import type { ImageAttachment, StoredImageAttachment } from "@pitcrew/protocol";
export interface AttachmentStore {
  put(attachment: ImageAttachment): StoredImageAttachment;
  get(attachment: StoredImageAttachment): ImageAttachment;
  matches(reference: StoredImageAttachment, attachment: ImageAttachment): boolean;
}
// The adapter's insert must participate in the coordinator persistence transaction.
// Each image is kept in its own row; repository_state contains immutable references only.
export function attachmentStore(
  read: (id: string) => ImageAttachment | undefined,
  insert: (id: string, value: ImageAttachment) => void,
  id: () => string = () => crypto.randomUUID(),
): AttachmentStore {
  return {
    put(attachment) {
      const attachmentId = id();
      if (read(attachmentId)) throw Error("attachment_id_conflict");
      insert(attachmentId, structuredClone(attachment));
      const { data: _data, ...metadata } = attachment;
      return { ...metadata, attachmentId };
    },
    get(reference) {
      const image = read(reference.attachmentId);
      if (
        !image ||
        image.id !== reference.id ||
        image.name !== reference.name ||
        image.mediaType !== reference.mediaType
      )
        throw Error("attachment_unavailable");
      return structuredClone(image);
    },
    matches(reference, attachment) {
      const existing = read(reference.attachmentId);
      return (
        !!existing &&
        existing.id === reference.id &&
        existing.name === reference.name &&
        existing.mediaType === reference.mediaType &&
        existing.id === attachment.id &&
        existing.name === attachment.name &&
        existing.mediaType === attachment.mediaType &&
        existing.data === attachment.data
      );
    },
  };
}
