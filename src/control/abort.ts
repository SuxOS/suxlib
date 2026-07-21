// Shared cooperative-cancellation primitives (#279) for the op engine: the
// dedicated error type a caller's AbortSignal surfaces as, and the helper
// that races a wait against it. Kept in their own dependency-free module,
// not defined in governor.ts where OpAbortError originated, so token-bucket.ts
// and aimd.ts (#297) can throw/race the same error governor.ts and runInline
// already use without an import cycle -- governor.ts imports tokenBucket()
// from token-bucket.ts and fixed()/aimd() from aimd.ts, so those two can't
// import OpAbortError back out of governor.ts. governor.ts re-exports
// OpAbortError from here so every existing `from '../control/governor.js'`
// import keeps working unchanged.

export class OpAbortError extends Error {
  constructor() {
    super('op run aborted')
    this.name = 'OpAbortError'
  }
}

// Races a wait against the abort signal so a caller that cancels mid-wait
// doesn't have to wait out the full delay before the abort takes effect.
export function sleepOrAbort(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.reject(new OpAbortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new OpAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    sleep(ms).then(
      () => { signal.removeEventListener('abort', onAbort); resolve() },
      err => { signal.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}
