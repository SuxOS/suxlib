import { describe, expect, it } from 'vitest'
import { b64ToBytes, bytesToB64, MAX_B64_INPUT_BYTES } from '../../src/adapters/base64.js'

describe('base64 adapter', () => {
  it('round-trips a small payload', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111])
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes)
  })

  it('round-trips empty input', () => {
    const bytes = new Uint8Array(0)
    const b64 = bytesToB64(bytes)
    expect(b64).toBe('')
    expect(b64ToBytes(b64)).toEqual(bytes)
  })

  it('round-trips a payload exactly at the bytesToB64 CHUNK boundary (0x8000 bytes)', () => {
    const bytes = new Uint8Array(0x8000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes)
  })

  it('round-trips a payload one byte over the CHUNK boundary (0x8000 + 1 bytes)', () => {
    const bytes = new Uint8Array(0x8000 + 1)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes)
  })

  it('b64ToBytes throws on malformed base64', () => {
    expect(() => b64ToBytes('not valid base64!!!')).toThrow()
  })

  it('b64ToBytes rejects input longer than MAX_B64_INPUT_BYTES (bomb guard)', () => {
    const huge = 'A'.repeat(MAX_B64_INPUT_BYTES + 1)
    expect(() => b64ToBytes(huge)).toThrow(/bomb guard/)
  })

  it('b64ToBytes accepts input right at MAX_B64_INPUT_BYTES', () => {
    const atLimit = 'A'.repeat(MAX_B64_INPUT_BYTES)
    expect(() => b64ToBytes(atLimit)).not.toThrow(/bomb guard/)
  })
})
