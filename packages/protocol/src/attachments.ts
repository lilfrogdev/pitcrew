interface AttachmentIdentity {
  id: string;
  name: string;
}
export interface TextAttachment extends AttachmentIdentity {
  mediaType: "text/plain";
  text: string;
}
export interface ImageAttachment extends AttachmentIdentity {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}
export interface StoredImageAttachment extends AttachmentIdentity {
  mediaType: ImageAttachment["mediaType"];
  attachmentId: string;
}
export type SubmittedAttachment = TextAttachment | ImageAttachment;
export type MessageAttachment =
  | TextAttachment
  | StoredImageAttachment
  | import("./uploads").StoredFileAttachment;
export interface AttachmentCapabilities {
  images: boolean;
  maxImages: number;
  // Conservative admitted text bytes; runtime reserves context for tools/output.
  textTotalBytes: number;
  imageFileBytes: number;
  imageTotalBytes: number;
  reason?: string;
}
export const ATTACHMENT_LIMITS = {
  count: 4,
  fileBytes: 65536,
  totalBytes: 131072,
  imageFileBytes: 1048576,
  imageTotalBytes: 1048576,
  imageDimension: 4096,
  imagePixels: 16777216,
  requestBytes: 2097152,
  nativeInputBytes: 1835008,
  nameLength: 128,
  extensions: [
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".log",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".css",
    ".html",
    ".py",
    ".yaml",
    ".yml",
    ".toml",
    ".sql",
  ],
} as const;
export const TEXT_ATTACHMENT_CAPABILITIES: AttachmentCapabilities = {
  images: false,
  maxImages: 0,
  textTotalBytes: ATTACHMENT_LIMITS.totalBytes,
  imageFileBytes: ATTACHMENT_LIMITS.imageFileBytes,
  imageTotalBytes: ATTACHMENT_LIMITS.imageTotalBytes,
  reason: "Configured execution model does not support images.",
};
export class AttachmentValidationError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function validAttachmentText(text: string): boolean {
  return (
    // eslint-disable-next-line no-control-regex -- reject unsafe text control bytes
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
  );
}
function invalidImage(): never {
  throw new AttachmentValidationError("invalid_attachment_image");
}
function pngCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Header/structure validation bounds decoded pixel allocations before any provider decoder.
// It does not guarantee every compressed pixel stream is decodable; provider decode errors remain errors.
export function imageDimensions(
  data: string,
  mediaType: ImageAttachment["mediaType"],
): { width: number; height: number } {
  if (
    !data ||
    data.length > Math.ceil(ATTACHMENT_LIMITS.imageFileBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  )
    invalidImage();
  let raw: string;
  try {
    raw = atob(data);
  } catch {
    return invalidImage();
  }
  if (btoa(raw) !== data) invalidImage();
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, length: number) => raw.slice(offset, offset + length);
  let width = 0,
    height = 0;
  if (mediaType === "image/png") {
    if (
      raw.slice(0, 8) !== "\x89PNG\r\n\x1a\n" ||
      bytes.length < 45 ||
      view.getUint32(8) !== 13 ||
      ascii(12, 4) !== "IHDR"
    )
      invalidImage();
    width = view.getUint32(16);
    height = view.getUint32(20);
    const depths: Record<number, number[]> = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16],
    };
    if (
      !depths[bytes[25]]?.includes(bytes[24]) ||
      bytes[26] !== 0 ||
      bytes[27] !== 0 ||
      bytes[28] > 1
    )
      invalidImage();
    let offset = 8,
      hasData = false,
      ended = false;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset),
        type = ascii(offset + 4, 4);
      if (size > bytes.length - offset - 12 || type === "acTL") invalidImage();
      if (pngCrc(bytes, offset + 4, offset + 8 + size) !== view.getUint32(offset + 8 + size))
        invalidImage();
      if (type === "IHDR" && offset !== 8) invalidImage();
      if (type === "IDAT") hasData = true;
      offset += size + 12;
      if (type === "IEND") {
        if (size !== 0 || offset !== bytes.length) invalidImage();
        ended = true;
        break;
      }
    }
    if (!ended || !hasData) invalidImage();
  } else if (mediaType === "image/jpeg") {
    if (
      bytes.length < 12 ||
      bytes[0] !== 255 ||
      bytes[1] !== 216 ||
      bytes.at(-2) !== 255 ||
      bytes.at(-1) !== 217
    )
      invalidImage();
    let offset = 2,
      hasScan = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) invalidImage();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217) break;
      if (offset + 2 > bytes.length) invalidImage();
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) invalidImage();
      if ([192, 193, 194].includes(marker)) {
        if (
          size < 8 ||
          width ||
          height ||
          ![1, 3, 4].includes(bytes[offset + 7]) ||
          size !== 8 + 3 * bytes[offset + 7]
        )
          invalidImage();
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
      }
      if (marker === 218) {
        hasScan = true;
        break;
      }
      offset += size;
    }
    if (!hasScan) invalidImage();
  } else {
    if (
      bytes.length < 30 ||
      ascii(0, 4) !== "RIFF" ||
      ascii(8, 4) !== "WEBP" ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      invalidImage();
    let offset = 12,
      hasFrame = false;
    while (offset + 8 <= bytes.length) {
      const type = ascii(offset, 4),
        size = view.getUint32(offset + 4, true),
        payload = offset + 8;
      if (size > bytes.length - payload || type === "ANIM" || type === "ANMF") invalidImage();
      let frameWidth = 0,
        frameHeight = 0;
      if (type === "VP8X") {
        if (offset !== 12 || size !== 10 || bytes[payload] & 2) invalidImage();
        width = 1 + bytes[payload + 4] + (bytes[payload + 5] << 8) + (bytes[payload + 6] << 16);
        height = 1 + bytes[payload + 7] + (bytes[payload + 8] << 8) + (bytes[payload + 9] << 16);
      } else if (type === "VP8L") {
        if (size < 5 || bytes[payload] !== 47) invalidImage();
        frameWidth = 1 + bytes[payload + 1] + ((bytes[payload + 2] & 63) << 8);
        frameHeight =
          1 +
          (bytes[payload + 2] >> 6) +
          (bytes[payload + 3] << 2) +
          ((bytes[payload + 4] & 15) << 10);
      } else if (type === "VP8 ") {
        if (size < 10 || ascii(payload + 3, 3) !== "\x9d\x01\x2a") invalidImage();
        frameWidth = view.getUint16(payload + 6, true) & 16383;
        frameHeight = view.getUint16(payload + 8, true) & 16383;
      }
      if (frameWidth || frameHeight) {
        if (hasFrame || (width && (frameWidth !== width || frameHeight !== height))) invalidImage();
        width = frameWidth;
        height = frameHeight;
        hasFrame = true;
      }
      offset = payload + size + (size % 2);
    }
    if (offset !== bytes.length || !hasFrame) invalidImage();
  }
  if (
    !width ||
    !height ||
    width > ATTACHMENT_LIMITS.imageDimension ||
    height > ATTACHMENT_LIMITS.imageDimension ||
    width * height > ATTACHMENT_LIMITS.imagePixels
  )
    invalidImage();
  return { width, height };
}
export function validateMessageAttachments(
  value: unknown,
  capabilities?: AttachmentCapabilities,
): SubmittedAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.count)
    throw new AttachmentValidationError("invalid_attachments");
  let textTotal = 0,
    imageTotal = 0,
    images = 0;
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new AttachmentValidationError("invalid_attachment");
    const attachment = item as Record<string, unknown>;
    const { id, name, mediaType, text, data } = attachment;
    const fields =
      mediaType === "text/plain"
        ? ["id", "name", "mediaType", "text"]
        : ["id", "name", "mediaType", "data"];
    if (Object.keys(attachment).some((key) => !fields.includes(key)))
      throw new AttachmentValidationError("invalid_attachment");
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || ids.has(id))
      throw new AttachmentValidationError("invalid_attachment_id");
    ids.add(id);
    if (
      typeof name !== "string" ||
      !name ||
      name.length > ATTACHMENT_LIMITS.nameLength ||
      name !== name.trim() ||
      // eslint-disable-next-line no-control-regex -- reject unsafe filename controls
      /[/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name) ||
      name === "." ||
      name === ".." ||
      !validAttachmentText(name)
    )
      throw new AttachmentValidationError("invalid_attachment_name");
    if (mediaType === "text/plain") {
      if (!ATTACHMENT_LIMITS.extensions.some((extension) => name.toLowerCase().endsWith(extension)))
        throw new AttachmentValidationError("unsupported_attachment_type");
      if (typeof text !== "string" || !validAttachmentText(text))
        throw new AttachmentValidationError("invalid_attachment_text");
      const bytes = new TextEncoder().encode(text).byteLength;
      textTotal += bytes;
      if (
        bytes > ATTACHMENT_LIMITS.fileBytes ||
        textTotal > Math.min(ATTACHMENT_LIMITS.totalBytes, capabilities?.textTotalBytes ?? Infinity)
      )
        throw new AttachmentValidationError("attachments_too_large");
      return { id, name, mediaType, text };
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType as string))
      throw new AttachmentValidationError("unsupported_attachment_type");
    const type = mediaType as ImageAttachment["mediaType"];
    const extensions =
      type === "image/png" ? [".png"] : type === "image/jpeg" ? [".jpg", ".jpeg"] : [".webp"];
    if (!extensions.some((extension) => name.toLowerCase().endsWith(extension)))
      throw new AttachmentValidationError("unsupported_attachment_type");
    if (capabilities && (!capabilities.images || ++images > capabilities.maxImages))
      throw new AttachmentValidationError("attachment_images_unsupported");
    if (typeof data !== "string") invalidImage();
    imageDimensions(data, type);
    const bytes = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    imageTotal += bytes;
    if (
      bytes >
        Math.min(ATTACHMENT_LIMITS.imageFileBytes, capabilities?.imageFileBytes ?? Infinity) ||
      imageTotal >
        Math.min(ATTACHMENT_LIMITS.imageTotalBytes, capabilities?.imageTotalBytes ?? Infinity)
    )
      throw new AttachmentValidationError("attachments_too_large");
    return { id, name, mediaType: type, data };
  });
}
