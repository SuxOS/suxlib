import { test, expect } from 'vitest'
import { ask } from '../../src/op/combinators.js'
import { runInline, AskTimeoutError } from '../../src/runtime/inline.js'

test('runInline proceeds with the piped value when no Ask capability is supplied and onTimeout is proceed', async () => {
  const node = ask('continue?', { timeout: '30s', onTimeout: 'proceed' })
  const caps: any = { store: {}, llm: {}, clock: { now: () => 0 }, sinks: {} }
  const result = await runInline(node, 'input-value', caps)
  expect(result).toBe('input-value')
})

test('runInline throws AskTimeoutError when no Ask capability is supplied and onTimeout is fail', async () => {
  const node = ask('continue?', { timeout: '30s', onTimeout: 'fail' })
  const caps: any = { store: {}, llm: {}, clock: { now: () => 0 }, sinks: {} }
  await expect(runInline(node, 'input-value', caps)).rejects.toThrow(AskTimeoutError)
})

test('runInline calls caps.ask.request and returns the answer value when answered', async () => {
  const node = ask('continue?', { timeout: '30s', onTimeout: 'fail' })
  let requested: { prompt: string; timeout: string } | undefined
  const caps: any = {
    store: {}, llm: {}, clock: { now: () => 0 }, sinks: {},
    ask: { request: async (prompt: string, timeout: string) => { requested = { prompt, timeout }; return { answered: true, value: 'human-answer' } } },
  }
  const result = await runInline(node, 'input-value', caps)
  expect(result).toBe('human-answer')
  expect(requested).toEqual({ prompt: 'continue?', timeout: '30s' })
})

test('runInline proceeds with the piped value when caps.ask times out and onTimeout is proceed', async () => {
  const node = ask('continue?', { timeout: '30s', onTimeout: 'proceed' })
  const caps: any = {
    store: {}, llm: {}, clock: { now: () => 0 }, sinks: {},
    ask: { request: async () => ({ answered: false }) },
  }
  const result = await runInline(node, 'input-value', caps)
  expect(result).toBe('input-value')
})

test('runInline throws AskTimeoutError when caps.ask times out and onTimeout is fail', async () => {
  const node = ask('continue?', { timeout: '30s', onTimeout: 'fail' })
  const caps: any = {
    store: {}, llm: {}, clock: { now: () => 0 }, sinks: {},
    ask: { request: async () => ({ answered: false }) },
  }
  await expect(runInline(node, 'input-value', caps)).rejects.toThrow(AskTimeoutError)
})
