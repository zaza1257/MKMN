/** A wait that ends the moment `signal` aborts (rejecting with an AbortError), whatever
 *  the awaited work does. The work itself is not cancelled here: the caller stops it
 *  (a model start is put down by stopping the server). A rejection of the work after
 *  the abort is swallowed, so it never surfaces as an unhandled error. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { work.catch(() => undefined); return Promise.reject(abortError()); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { work.catch(() => undefined); reject(abortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

function abortError(): Error {
  const e = new Error("Stopped.");
  e.name = "AbortError";
  return e;
}
