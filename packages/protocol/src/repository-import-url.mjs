// Validate the raw spelling before URL parsers can normalize traversal, escapes,
// backslashes or whitespace. Browser, relay and Worker share this admission rule.
const publicRepositoryPattern =
  /^https:\/\/github\.com(?::443)?\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/?$/i;

export function normalizePublicRepositoryImportUrl(value) {
  if (typeof value !== "string" || value.length > 512) throw Error("invalid_public_url");
  const match = publicRepositoryPattern.exec(value);
  // JavaScript's $ also matches before a final newline; require the whole input.
  if (!match || match[0] !== value || match[2] === "." || match[2] === "..")
    throw Error("invalid_public_url");
  return `https://github.com/${match[1]}/${match[2]}`;
}
