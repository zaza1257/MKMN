// The sidecar's last-resort settings write, when the host (the one authoritative
// writer) could not take a patch.
//
// It must never write a stale snapshot: the patch is merged into the file AS IT IS
// NOW (another writer may have saved since the request began), and a file that is
// not a valid settings object is left alone — its bytes may be the person's only
// copy, which the host refuses to overwrite too.

export type ReadResult = { kind: "missing" } | { kind: "object"; value: Record<string, unknown> } | { kind: "unusable" };

/** Merge `patch` into a FRESH read and write it; false when the file must not be touched. */
export function fallbackSettingsWrite(
  readNow: () => ReadResult,
  write: (value: Record<string, unknown>) => void,
  patch: Record<string, unknown>,
): boolean {
  const now = readNow();
  if (now.kind === "unusable") return false;
  write({ ...(now.kind === "object" ? now.value : {}), ...patch });
  return true;
}
