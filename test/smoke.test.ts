import { test, expect } from 'vitest'
import { VERSION } from '../src/index.js'
test('package loads', () => { expect(VERSION).toBe('0.0.0') })
