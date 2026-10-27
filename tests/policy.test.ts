import { expect, test } from 'claude-code/testing'
import { decide, detectOverride } from '../src/policy.ts'
import { TIER_NAMES, type Tier } from '../src/config.ts'

const ALL = [...TIER_NAMES]
const sure = (tier: Tier) => ({ tier, confidence: 0.95 })
const unsure = (tier: Tier) => ({ tier, confidence: 0.2 })
const base = { prompt: 'refactor the parser', current: 'sonnet' as Tier, available: ALL, contextTokens: 0 }

test('follows a confident answer', () => {
  expect(decide({ ...base, answer: sure('opus') })).toEqual({ tier: 'opus', reason: 'answer', changed: true })
})

test('an explicit user override beats the answer', () => {
  const out = decide({ ...base, prompt: 'use haiku to fix this typo', answer: sure('opus') })
  expect(out.tier).toBe('haiku')
  expect(out.reason).toBe('override')
})

test('detectOverride only fires on a real instruction', () => {
  expect(detectOverride('switch to opus')).toBe('opus')
  expect(detectOverride('use strong')).toBe('opus')
  expect(detectOverride('use fast')).toBe('haiku')
  expect(detectOverride('the opus of his career')).toBe(null)
})

test('keeps the current model with no answer', () => {
  const out = decide({ ...base, answer: null })
  expect(out.tier).toBe('sonnet')
  expect(out.changed).toBe(false)
  expect(out.reason).toMatch(/no-answer/)
})

test('never downgrades on a low-confidence answer', () => {
  const out = decide({ ...base, answer: unsure('haiku') })
  expect(out.tier).toBe('sonnet')
  expect(out.reason).toMatch(/low-confidence-no-downgrade/)
})

test('caps a low-confidence upgrade at the safe ceiling', () => {
  const out = decide({ ...base, current: 'haiku', answer: unsure('fable') })
  expect(out.tier).toBe('sonnet')
  expect(out.reason).toBe('low-confidence-capped')
})

test('still allows a confident upgrade to fable', () => {
  expect(decide({ ...base, answer: sure('fable') }).tier).toBe('fable')
})

test('refuses a downgrade once the cache rebuild costs more than it saves', () => {
  const out = decide({ ...base, current: 'opus', answer: sure('haiku'), contextTokens: 80000 })
  expect(out.tier).toBe('opus')
  expect(out.reason).toMatch(/cache-rebuild/)
})

test('allows the same downgrade early in a conversation', () => {
  expect(decide({ ...base, current: 'opus', answer: sure('haiku') }).tier).toBe('haiku')
})

test('substitutes upward when the chosen tier is unavailable', () => {
  const out = decide({ ...base, current: 'haiku', available: ['haiku', 'opus'], answer: sure('sonnet') })
  expect(out.tier).toBe('opus')
  expect(out.reason).toMatch(/unavailable/)
})

test('never substitutes upward into fable', () => {
  const out = decide({ ...base, current: 'haiku', available: ['haiku', 'fable'], answer: sure('opus') })
  expect(out.tier).toBe('haiku')
})

test('a failed decision keeps a current tier the router may not pick', () => {
  const out = decide({ ...base, current: 'fable', available: ['haiku', 'sonnet', 'opus'], answer: null })
  expect(out).toEqual({ tier: 'fable', reason: 'no-answer/no-change', changed: false })
})
