/** Remove a publisher prefix only when the model name already repeats it. */
export function modelLabel(label: string): string {
  const separator = label.indexOf(":");
  if (separator === -1) return label;
  const publisher = label.slice(0, separator).trim();
  const name = label.slice(separator + 1).trim();
  const next = name.slice(publisher.length, publisher.length + 1);
  return publisher &&
    name.slice(0, publisher.length).toLowerCase() === publisher.toLowerCase() &&
    (!next || /[\s\d._-]/.test(next))
    ? name
    : label;
}
