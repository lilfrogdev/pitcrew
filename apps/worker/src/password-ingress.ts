/** The public password surface is deliberately narrower than the Access API. */
export function passwordApiRoute(path: string, method: string) {
  const id = "[A-Za-z0-9:_-]{1,128}";
  const upload = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  const routes: Record<string, string[]> = {
    GET: [
      "auth/get-session",
      "account",
      "projects",
      "project-adoptions",
      "repositories",
      "capabilities",
      "provider-connection/openrouter(?:/models)?",
      `projects/${id}/(?:context|threads|members|events|intake|verification-metrics)`,
      `projects/${id}/threads/${id}/visualizations(?:/${id})?`,
      `threads/${id}/source/(?:tree|file|diff)`,
      `threads/${id}/(?:members|messages|changes|runs|turns|presence|attachments/${id})`,
      `changes/${id}(?:/runs)?`,
      `runs/${id}/(?:evidence|reviews)`,
      `threads/${id}/uploads/${upload}`,
      "invitations/[a-f0-9]{64}",
    ],
    POST: [
      "auth/(?:enroll|sign-in/username|sign-out|revoke-sessions|update-user|change-password)",
      "provider-connection/openrouter",
      "projects",
      `projects/${id}/(?:threads|invitations|knowledge|verification-profile|reports|intake/move|threads/${id}/archive)`,
      `threads/${id}/(?:messages|invitations|presence)`,
      "invitations/[a-f0-9]{64}/(?:accept|revoke)",
    ],
    PUT: [`threads/${id}/uploads/${upload}`],
    DELETE: [
      `threads/${id}/uploads/${upload}`,
      `(?:projects|threads)/${id}/members/[A-Za-z0-9:@._+-]{1,256}`,
    ],
  };
  return (routes[method] ?? []).some((route) => new RegExp(`^/api/${route}$`).test(path));
}

export function isPasswordIngress(request: Request) {
  const path = new URL(request.url).pathname;
  return path === "/app/api" || path.startsWith("/app/api/");
}

function denied(error: string, status: number) {
  return Response.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    },
  );
}

/** Validate the scoped URL again inside the DO; no header selects auth mode. */
export function passwordIngressRequest(
  request: Request,
  env: { AUTH_MODE?: string; BETTER_AUTH_URL?: string },
): Request | Response {
  if (env.AUTH_MODE !== "password-only") return denied("not_found", 404);
  const url = new URL(request.url);
  let base: URL;
  try {
    base = new URL(env.BETTER_AUTH_URL ?? "");
  } catch {
    return denied("auth_unavailable", 503);
  }
  if (
    base.protocol !== "https:" ||
    base.origin !== env.BETTER_AUTH_URL ||
    url.origin !== base.origin
  )
    return denied("ingress_forbidden", 403);
  // Disallow encoded separators/dot segments and double decoding ambiguity.
  if (!isPasswordIngress(request) || /%(?:2f|5c|2e|25)|\\|\/\//i.test(url.pathname))
    return denied("not_found", 404);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.slice(4));
  } catch {
    return denied("not_found", 404);
  }
  if (!passwordApiRoute(path, request.method)) return denied("not_found", 404);
  if (
    (request.headers.has("origin") && request.headers.get("origin") !== url.origin) ||
    ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "") ||
    (request.method !== "GET" && request.headers.get("origin") !== url.origin)
  )
    return denied("ingress_forbidden", 403);
  if (
    request.headers.has("content-encoding") ||
    (request.method === "POST" &&
      request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json")
  )
    return denied("unsupported_media_type", 415);
  const keys = /\/source\/(tree|file|diff)$/.test(path)
    ? ["path", "version", "cursor", "runId"]
    : path === "/api/capabilities"
      ? ["projectId"]
      : path.endsWith("/events")
        ? ["after"]
        : path === "/api/repositories"
          ? ["cursor"]
          : [];
  if (
    (request.method !== "GET" && url.search) ||
    [...url.searchParams.keys()].some(
      (key) =>
        !keys.includes(key) ||
        url.searchParams.getAll(key).length !== 1 ||
        (url.searchParams.get(key)?.length ?? 0) > (key === "projectId" ? 128 : 1024),
    ) ||
    (url.searchParams.has("after") && !/^\d{1,15}$/.test(url.searchParams.get("after")!))
  )
    return denied("invalid_cursor", 400);
  const headers = new Headers(request.headers);
  for (const name of Array.from(headers.keys())) {
    if (
      (/^(?:cf-access-|x-pitcrew-)/i.test(name) &&
        !(
          request.method === "PUT" &&
          path.includes("/uploads/") &&
          name === "x-pitcrew-filename"
        )) ||
      ["authorization", "x-auth-mode", "x-user-id", "x-user-email", "x-forwarded-user"].includes(
        name,
      )
    )
      headers.delete(name);
  }
  url.pathname = path;
  return new Request(new Request(url, request), { headers });
}

export function privateIngressResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}
