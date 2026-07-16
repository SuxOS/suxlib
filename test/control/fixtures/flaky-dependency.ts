function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface FlakyDependency {
  call(concurrentInFlight: number, nowMs: number): { ok: boolean; costTokens: number }
}

export function createFlakyDependency(opts: {
  seed: number
  concurrencyRejectThreshold: number
  outageStartMs: number
  outageEndMs: number
  costTokensPerCall: number
  baseFailureRate?: number
}): FlakyDependency {
  const rand = mulberry32(opts.seed)
  return {
    call(concurrentInFlight, nowMs) {
      if (nowMs >= opts.outageStartMs && nowMs < opts.outageEndMs) return { ok: false, costTokens: 0 }
      if (concurrentInFlight > opts.concurrencyRejectThreshold) return { ok: false, costTokens: 0 }
      if (rand() < (opts.baseFailureRate ?? 0)) return { ok: false, costTokens: 0 }
      return { ok: true, costTokens: opts.costTokensPerCall }
    },
  }
}
