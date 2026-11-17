/** The models no load setting loaded on this PC (`loadFailures`): a record, kept per GenieX version. */
export type LoadFailures = Record<string, { reason: string; geniex: string | null; at: string }>;

export const withLoadFailure = (prev: LoadFailures | undefined, ref: string, reason: string, geniex: string | null, at: string): LoadFailures =>
  ({ ...(prev ?? {}), [ref]: { reason: reason.slice(0, 300), geniex, at } });

/** A model that loaded is no longer recorded as failing (the same object when it never was). */
export function clearLoadFailure<T extends LoadFailures | undefined>(prev: T, ref: string): T {
  if (!prev || !(ref in prev)) return prev;
  const { [ref]: _gone, ...rest } = prev;
  return rest as T;
}

/** Only the failures seen with this GenieX: a newer runtime may load the model, so it is tried again. */
export function failuresOfThisGeniex(prev: LoadFailures | undefined, geniex: string | null): LoadFailures {
  if (!prev || !geniex) return prev ?? {};
  return Object.fromEntries(Object.entries(prev).filter(([, f]) => f.geniex === geniex));
}


/** The registered machine modelVerdict read from the two records: a placement wins (a load that worked). */
export function verdictOf(ref: string, s: { placements?: Record<string, unknown>; loadFailures?: Record<string, unknown> }): "unknown" | "loads" | "fails" {
  if (s.placements?.[ref]) return "loads";
  if (s.loadFailures?.[ref]) return "fails";
  return "unknown";
}

/** How a check ends, as the machine's event: a load GenieX never attempted is "not_tried" and records nothing. */
export function checkOutcome(o: { placed: boolean; nameError: string | null }): "loaded" | "no_setting" | "not_tried" {
  if (o.placed) return "loaded";
  return o.nameError ? "not_tried" : "no_setting";
}
