import {
  isStoredFile,
  type AttachmentCapabilities,
  type MessageAttachment,
  type UploadSubmission,
} from "@pitcrew/protocol";
import type { AttachmentDraft } from "../Composer";
// Provider ingestion is separately bounded from file storage. The exact decision
// displayed before send is submitted explicitly, never silently changed by the server.
export function uploadInputs(
  drafts: AttachmentDraft[],
  history: MessageAttachment[],
  capabilities: AttachmentCapabilities,
  enabled: boolean,
) {
  let textBytes = 0,
    imageBytes = 0,
    images = 0;
  for (const item of history) {
    if (isStoredFile(item)) continue;
    if (item.mediaType === "text/plain") textBytes += new TextEncoder().encode(item.text).length;
    else {
      images++;
      imageBytes += capabilities.imageFileBytes;
    }
  }
  for (const item of drafts) {
    if (!item.attachment || "uploadId" in item.attachment) continue;
    if (item.attachment.mediaType === "text/plain")
      textBytes += new TextEncoder().encode(item.attachment.text).length;
    else {
      images++;
      imageBytes += atob(item.attachment.data).length;
    }
  }
  return drafts.map((item): AttachmentDraft => {
    if (!item.upload) return item;
    let modelInput: UploadSubmission["modelInput"] = "storage";
    if (
      enabled &&
      item.upload.input === "text" &&
      textBytes + item.upload.size <= capabilities.textTotalBytes
    ) {
      textBytes += item.upload.size;
      modelInput = "text";
    } else if (
      enabled &&
      item.upload.input === "image" &&
      capabilities.images &&
      item.upload.size <= capabilities.imageFileBytes &&
      imageBytes + item.upload.size <= capabilities.imageTotalBytes &&
      images < capabilities.maxImages
    ) {
      imageBytes += item.upload.size;
      images++;
      modelInput = "image";
    }
    return { ...item, modelInput, attachment: { uploadId: item.upload.uploadId, modelInput } };
  });
}
