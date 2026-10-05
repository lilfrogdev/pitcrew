import type { Miniflare } from "miniflare";
export async function localHeaders(mf: Miniflare, origin = "http://localhost") {
  const response = await mf.dispatchFetch(`${origin}/api/local-session`);
  const { nonce } = (await response.json()) as { nonce: string };
  return {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: response.headers.get("set-cookie")!.split(";", 1)[0],
    "X-Pitcrew-Local-Nonce": nonce,
  };
}
