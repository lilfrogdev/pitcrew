export function piExecutionAllowed(
  mode: string,
  admissionEnabled: string | undefined,
  deadline: number | undefined,
  now: number,
) {
  const open = mode === "local" || (mode === "cloud" && admissionEnabled === "true");
  return open && typeof deadline === "number" && Number.isFinite(deadline) && deadline > now;
}
