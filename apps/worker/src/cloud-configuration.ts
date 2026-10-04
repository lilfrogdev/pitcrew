import { initialState } from "./coordinator";
export function cloudInitialState(env: {
  PROJECT_BASE_SHA?: string;
  CONFIGURATION_REVISION?: string;
}) {
  if (
    !/^[a-f0-9]{40}$/.test(env.PROJECT_BASE_SHA ?? "") ||
    !env.CONFIGURATION_REVISION ||
    env.CONFIGURATION_REVISION.length > 128
  )
    throw Error("project_not_configured");
  return initialState({
    baseSha: env.PROJECT_BASE_SHA!,
    configurationRevision: env.CONFIGURATION_REVISION,
  });
}
export function sandboxImage(name: string | undefined, images: Record<string, string>) {
  if (!name || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw Error("image_not_configured");
  const image = images[name];
  if (!image || !/^registry\.cloudflare\.com\/[a-zA-Z0-9_./-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw Error("image_not_configured");
  return image;
}
