import { expect, test } from 'claude-code/testing'
import { addDecision, addStep, costOf, emptyTotals, mergeTotals, percentile, savings, type Usage } from '../src/stats.ts'
import { PRICES } from '../src/config.ts'

const usage = (model: string, extra: Partial<Usage> = {}): Usage => ({
  input_tokens: 1000,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model,
  ...extra,
})
const micro = (usd: number) => Math.round(usd * 1e6)

test('prices a request by its model family', () => {
  expect(micro(costOf(usage('claude-haiku-5-5'), 'claude-haiku-5-5', PRICES))).toBe(150)
  expect(micro(costOf(usage('claude-haiku-5-5'), 'claude-opus-5-5', PRICES))).toBe(6000)
})

test('savings compare the same tokens at the baseline price', () => {
  const t = addStep(emptyTotals(), { usage: usage('claude-haiku-5-5'), baseline: 'claude-opus-5-5', switched: false, prices: PRICES })
  expect(micro(t.actualUsd)).toBe(150)
  expect(micro(t.baselineUsd)).toBe(6000)
  expect(micro(savings(t).gross)).toBe(5850)
  expect(t.tokens['claude-haiku-5-5']).toEqual({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 })
})

test('a switch charges its cache rebuild against net savings', () => {
  const t = addStep(emptyTotals(), {
    usage: usage('claude-haiku-5-5', { cache_creation_input_tokens: 10000 }),
    baseline: 'claude-opus-5-5',
    switched: true,
    prices: PRICES,
  })
  expect(micro(t.switchPenaltyUsd)).toBe(48000)
  expect(micro(savings(t).net)).toBe(micro(savings(t).gross) - 48000)
})

test('decisions count outcomes and keep the newest 200 latencies', () => {
  let t = emptyTotals()
  for (let i = 0; i < 250; i++) t = addDecision(t, i % 2 ? 'routed' : 'keep', i)
  expect(t.outcomes).toEqual({ keep: 125, routed: 125 })
  expect(t.latencies.length).toBe(200)
  expect(t.latencies[0]).toBe(50)
})

test('percentile picks from the sorted latencies', () => {
  expect(percentile([400, 100, 300, 200], 50)).toBe(300)
  expect(percentile([400, 100, 300, 200], 95)).toBe(400)
  expect(percentile([], 50)).toBe(null)
})

test('mergeTotals adds sessions together', () => {
  const one = addStep(addDecision(emptyTotals(), 'routed', 10), { usage: usage('claude-haiku-5-5'), baseline: 'claude-opus-5-5', switched: false, prices: PRICES })
  const all = mergeTotals([one, one])
  expect(all.steps).toBe(2)
  expect(all.outcomes).toEqual({ routed: 2 })
  expect(all.latencies).toEqual([10, 10])
  expect(all.tokens['claude-haiku-5-5'].input).toBe(2000)
  expect(micro(all.actualUsd)).toBe(300)
})
