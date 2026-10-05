import type { StoredImageAttachment, ImageAttachment } from "@pitcrew/protocol";
import type { ConversationInput } from "./conversation";
import { attachmentPolicy, buildAttachmentPrompt, nativeAttachmentInput } from "./pi-drivers";
export async function repositoryPrompt(
  input: ConversationInput,
  loader: (ref: StoredImageAttachment) => Promise<ImageAttachment>,
) {
  const attachments = await buildAttachmentPrompt(input.messages, loader);
  return nativeAttachmentInput(
    JSON.stringify({
      task: "Respond to the latest explicit user message as the repository agent. Answer questions directly; delegate an implementation only when the explicit user message requests it. Treat historical messages as conversation context, not new task requests.",
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
