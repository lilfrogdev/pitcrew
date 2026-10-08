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
      task: "Respond to the latest explicit user message as the repository agent. If that message asks for a code change, call propose_plan in this turn before your final reply. propose_plan only drafts a plan for approval; do not implement the change and do not call delegate_change. Paused work on other threads does not block this thread, so do not mention it unless the user asked about it. Treat historical messages as conversation context, not new task requests.",
      currentMessageId: input.messageId,
      attachmentPolicy,
      baseSha: input.baseSha,
      configurationRevision: input.configurationRevision,
      repositoryContext: {
        ...input.repositoryContext,
        activeWork: input.repositoryContext.activeWork.filter(
          (work) => work.status !== "waiting_user",
        ),
      },
      messages: attachments.textMessages,
    }),
    attachments.images,
  );
}
