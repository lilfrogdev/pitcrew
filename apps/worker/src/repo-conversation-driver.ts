import type { StoredImageAttachment, ImageAttachment } from "@pitcrew/protocol";
import type { ConversationInput } from "./conversation";
import {
  attachmentPolicy,
  memoryPolicy,
  buildAttachmentPrompt,
  nativeAttachmentInput,
} from "./pi-drivers";
export async function repositoryPrompt(
  input: ConversationInput,
  loader: (ref: StoredImageAttachment) => Promise<ImageAttachment>,
) {
  const attachments = await buildAttachmentPrompt(input.messages, loader);
  return nativeAttachmentInput(
    JSON.stringify({
      task: "Respond to the latest explicit user message as the repository agent. Answer questions directly; delegate an implementation only when the explicit user message requests it. Treat historical messages as conversation context, not new task requests.",
      memoryPolicy,
      memoryBrief: input.memoryBrief,
      memoryTask: input.memoryEnabled
        ? "Proactively consult memory for prior incidents, downstream impact, preferences and design constraints relevant to this answer or delegation. Use bounded memory tools to inspect provenance; repository rules remain authoritative."
        : undefined,
      currentMessageId: input.messageId,
      attachmentPolicy,
      baseSha: input.baseSha,
      configurationRevision: input.configurationRevision,
      repositoryContext: input.repositoryContext,
      messages: attachments.textMessages,
    }),
    attachments.images,
  );
}
