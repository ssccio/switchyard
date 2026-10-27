import { expect, test } from 'claude-code/testing'
import { buildRequest, parseAnswer } from '../src/systemone.ts'
import { DEFAULT_MODELS } from '../src/config.ts'

const req = () =>
  buildRequest({ model: 'clef-flash', prompt: 'fix the flaky test', current: 'claude-opus-5-5', contextTokens: 1200, models: DEFAULT_MODELS, tiers: ['haiku', 'sonnet', 'opus'] })

test('the request names the decision model and the exact available models', () => {
  const r = req()
  expect(r.model).toBe('clef-flash')
  expect(r.state).toEqual({
    request: 'fix the flaky test',
    session: { current_model: 'claude-opus-5-5', context_tokens: 1200 },
    environment: { available_models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] },
  })
  expect(Object.keys(r.questions.model.criteria)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
  expect(r.questions.model.type).toBe('choice')
  expect(r.questions.task_complexity.type).toBe('score')
})

test('score rubrics stay within the API limit of 10 levels', () => {
  for (const q of Object.values(req().questions)) {
    if (q.type === 'score') expect(q.criteria.length <= 10).toBe(true)
  }
})

test('parses a SystemOne answer and normalises the scores', () => {
  const body = JSON.stringify({
    model: 'jev-latest',
    answers: {
      model: { type: 'choice', choice: 'claude-haiku-5-5', confidence: 0.9, probabilities: {} },
      task_complexity: { type: 'score', score: 4.5, confidence: 0.8 },
      reasoning_required: { type: 'score', score: 9, confidence: 0.8 },
      tool_complexity: { type: 'score', score: 0, confidence: 0.8 },
    },
  })
  expect(parseAnswer(body)).toEqual({
    model: 'claude-haiku-5-5',
    confidence: 0.9,
    scores: { taskComplexity: 0.5, reasoningRequired: 1, toolComplexity: 0 },
  })
})

test('missing scores come back as null, not NaN', () => {
  const body = JSON.stringify({ answers: { model: { choice: 'claude-opus-5-5', confidence: 0.5 } } })
  expect(parseAnswer(body)?.scores).toEqual({ taskComplexity: null, reasoningRequired: null, toolComplexity: null })
})

test('anything without a choice and a confidence is not an answer', () => {
  expect(parseAnswer('not json')).toBe(null)
  expect(parseAnswer('{"error":"format no longer supported"}')).toBe(null)
  expect(parseAnswer(JSON.stringify({ answers: { model: { choice: 'x' } } }))).toBe(null)
})
