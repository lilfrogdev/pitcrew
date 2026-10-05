/** Public identifiers only. Credential bindings remain in the server catalog. */
export type ModelEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ModelSelection {
  modelId: string;
  effort: ModelEffort;
}
export interface ModelChoice {
  id: string;
  label: string;
  provider: string;
  model: string;
  efforts: ModelEffort[];
  contextWindow: number;
  imageLimits?: {
    maxBytes: number;
    maxPerMessage: number;
    maxPerRequest: number;
    maxRequestBytes?: number;
  };
}
export interface ModelSettings {
  default: ModelSelection;
  roles?: { implementer?: ModelSelection; reviewer?: ModelSelection };
}
/** Copied at admission; no subsequent thread/repository preference changes affect it. */
export interface FrozenRunModels {
  /** Optional only for runs admitted before catalog fencing was introduced. */
  catalogRevision?: string;
  repoAgent: ModelSelection;
  implementer: ModelSelection;
  reviewer: ModelSelection;
}

/** Intersect every admitted role: attachments are never dropped on a model switch. */
export function selectionAttachmentCapabilities(
  models: ModelChoice[],
  selections: FrozenRunModels,
): import("./attachments.ts").AttachmentCapabilities {
  const choices = [selections.repoAgent, selections.implementer, selections.reviewer].map(
    (selection) => models.find((model) => model.id === selection.modelId),
  );
  const images = choices.every((choice) => !!choice?.imageLimits);
  // Budget <=25% of the smallest context even at a conservative one byte/token;
  // remaining context is reserved for conversation, instructions, tools, and output.
  const textTotalBytes = Math.max(
    0,
    Math.min(131072, ...choices.map((choice) => Math.floor((choice?.contextWindow ?? 0) / 4))),
  );
  const imageFileBytes = images
    ? Math.min(1048576, ...choices.map((choice) => choice!.imageLimits!.maxBytes))
    : 0;
  const requestBytes = Math.min(
    2097152,
    ...choices.map((choice) => choice?.imageLimits?.maxRequestBytes ?? 2097152),
  );
  const imageTotalBytes = images
    ? Math.max(0, Math.min(1048576, Math.floor(((requestBytes - textTotalBytes - 262144) * 3) / 4)))
    : 0;
  const maxImages = images
    ? Math.min(
        4,
        ...choices.map((choice) =>
          Math.min(choice!.imageLimits!.maxPerMessage, choice!.imageLimits!.maxPerRequest),
        ),
      )
    : 0;
  return {
    images: images && imageTotalBytes > 0 && maxImages > 0,
    maxImages,
    textTotalBytes,
    imageFileBytes,
    imageTotalBytes,
    reason: images ? undefined : "An admitted model does not support image attachments.",
  };
}
