import { expect, test } from 'claude-code/testing'
import { bandLine, explainText, statsLines, usd } from '../src/view.ts'
import { addDecision, addStep, emptyTotals } from '../src/stats.ts'
import { PRICES } from '../src/config.ts'

const ready = { paused: null, probe: 'ready', last: null, sessionNet: 0 }

test('the band says why routing is off', () => {
  expect(bandLine({ ...ready, off: 'no backend: set JEV_API_KEY or SWITCHYARD_SYSTEMONE_URL' })).toBe(
    'switchyard off · no backend: set JEV_API_KEY or SWITCHYARD_SYSTEMONE_URL',
  )
})

test('the band shows a pause and how to resume', () => {
  expect(bandLine({ ...ready, paused: 'you picked sonnet' })).toBe('⏸ switchyard paused (you picked sonnet) · /switchyard on')
})

test('the band shows a failed probe', () => {
  expect(bandLine({ ...ready, probe: 'incompatible: HTTP 400' })).toBe('⚠ switchyard incompatible: HTTP 400')
})

test('the band shows the last decision and session savings', () => {
  expect(bandLine({ ...ready, sessionNet: 1.416, last: { tier: 'haiku', ms: 280, outcome: 'routed' } })).toBe('⚡ haiku · 280ms · saved $1.42 this session')
  expect(bandLine({ ...ready, last: { tier: 'opus', ms: 3000, outcome: 'timeout' } })).toBe('⚠ timeout, kept opus · 3000ms · saved $0.00 this session')
  expect(bandLine(ready)).toBe('⚡ switchyard ready · saved $0.00 this session')
})

test('usd keeps the sign', () => {
  expect(usd(-0.5)).toBe('-$0.50')
})

test('stats lines cover the session and recent sessions', () => {
  const t = addStep(addDecision(emptyTotals(), 'routed', 280), {
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' },
    baseline: 'claude-opus-5-5',
    switched: false,
    prices: PRICES,
  })
  const lines = statsLines(t, t)
  expect(lines[0]).toBe('This session: saved $0.01 net ($0.01 gross, $0.00 switch cost)')
  expect(lines[1]).toBe('Decisions: 1 · p50 280ms · p95 280ms')
  expect(lines[2]).toBe('Outcomes: routed 1')
  expect(lines[3]).toBe('  claude-haiku-5-5: in 1.0k · out 100 · cache read 0 · write 0')
  expect(lines).toContain('Last 100 sessions: saved $0.01 net ($0.01 gross, $0.00 switch cost)')
})

test('explain describes the last decision', () => {
  expect(explainText(undefined)).toBe('switchyard has made no decision yet this session.')
  const text = explainText({
    at: 0,
    agent: false,
    prompt: 'rename x',
    outcome: 'routed',
    ms: 280,
    from: 'opus',
    to: 'haiku',
    reason: 'answer',
    answer: { model: 'claude-haiku-5-5', confidence: 0.95, scores: { taskComplexity: 0.11, reasoningRequired: 0.2, toolComplexity: null } },
  })
  expect(text).toBe(
    [
      'Last decision (main thread): opus → haiku',
      'Prompt: rename x',
      'Outcome: routed · 280ms · policy: answer',
      'Answer: claude-haiku-5-5 at 95% confidence',
      'Scores: task 0.11 · reasoning 0.20 · tools -',
    ].join('\n'),
  )
})
