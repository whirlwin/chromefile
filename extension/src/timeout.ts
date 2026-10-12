import { BridgeError } from "./protocol";

// Rejects with `internal` "timed out" if `promise` has not settled in `ms`.
// Used for CDP calls, which can hang (e.g. screenshots of background tabs),
// so the caller gets an answer before the host gives up on the request.
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BridgeError("internal", `${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
