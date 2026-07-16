import type { Clock } from '../../../src/effects/types.js'

export function createFakeClock(startMs = 0): Clock & { advance(ms: number): void; set(ms: number): void } {
  let t = startMs
  return { now: () => t, advance: (ms) => { t += ms }, set: (ms) => { t = ms } }
}
