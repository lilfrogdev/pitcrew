// ASCII usernames keep browser, Better Auth and SQLite lower() semantics equal.
// Whitespace and non-ASCII input are rejected rather than silently aliased.
export const normalizeUsername = (value: string) => value.toLowerCase();
export const validUsername = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_]{3,32}$/.test(value);
