import type { EngineInterface, HttpResponse } from 'claude-code'
import type { Backend, Tier } from './config.ts'

const COMPLEXITY_SCALE = ['None', 'Very low', 'Low', 'Some', 'Moderate', 'Moderate to high', 'High', 'Very high', 'Severe', 'Extreme']
const COMPLEXITY_MAX = COMPLEXITY_SCALE.length - 1

const score = (instructions: string) => ({ type: 'score' as const, instructions, criteria: COMPLEXITY_SCALE })

const QUESTIONS = {
  task_complexity: score('How complex is the coding task overall, including ambiguity, scope, and blast radius?'),
  reasoning_required: score('How much reasoning is required to complete the request correctly in one pass?'),
  tool_complexity: score('How complex is the tool use required, from no tools to many coordinated or stateful operations?'),
}

const GUIDANCE: Record<Tier, { what: string; signals: string[]; not_for: string }> = {
  haiku: {
    what: 'Trivial, mechanical, or purely factual work.',
    signals: ['Rename, reformat, comment, or run one obvious command'],
    not_for: 'Design judgement or multi-file reasoning.',
  },
  sonnet: {
    what: 'Ordinary day-to-day engineering with a clear, bounded shape.',
    signals: ['Implement a specified function, test existing behaviour, or fix an understood local bug'],
    not_for: 'Open-ended architecture, subtle concurrency, or unknown-cause debugging.',
  },
  opus: {
    what: 'Hard reasoning, ambiguity, or high blast radius.',
    signals: ['Unknown-cause debugging, cross-module design, security, auth, concurrency, or migrations'],
    not_for: 'Routine work with a clear implementation.',
  },
  fable: {
    what: 'Very large or long-running work beyond a normal focused session.',
    signals: ['Whole-repo migration, unusually large context, or multi-hour autonomous execution'],
    not_for: 'Anything a strong model can finish in one focused session.',
  },
}

/** The `/v1/systemone` body jev-router sends, plus the `model` field the endpoint requires. */
export function buildRequest(r: {
  model: string
  prompt: string
  current: string
  contextTokens: number
  models: Record<Tier, string>
  tiers: readonly Tier[]
}) {
  return {
    model: r.model,
    state: {
      request: r.prompt,
      session: { current_model: r.current, context_tokens: r.contextTokens },
      environment: { available_models: r.tiers.map((tier) => r.models[tier]) },
    },
    questions: {
      ...QUESTIONS,
      model: {
        type: 'choice' as const,
        instructions: [
          'Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.',
          'Judge required reasoning, not requested reply length.',
        ],
        criteria: Object.fromEntries(r.tiers.map((tier) => [r.models[tier], { model: r.models[tier], ...GUIDANCE[tier] }])),
      },
    },
  }
}

export type Answer = {
  /** The exact model id the decision model chose. */
  model: string
  confidence: number
  /** Each score scaled to 0..1; null when the server left that question out. */
  scores: { taskComplexity: number | null; reasoningRequired: number | null; toolComplexity: number | null }
}

/** The answer in a SystemOne response body, or null when the body is not one. */
export function parseAnswer(body: string): Answer | null {
  let answers: any
  try {
    answers = JSON.parse(body)?.answers
  } catch {
    return null
  }
  const pick = answers?.model
  if (typeof pick?.choice !== 'string' || typeof pick?.confidence !== 'number') return null
  const level = (q: any) => (typeof q?.score === 'number' ? q.score / COMPLEXITY_MAX : null)
  return {
    model: pick.choice,
    confidence: pick.confidence,
    scores: {
      taskComplexity: level(answers.task_complexity),
      reasoningRequired: level(answers.reasoning_required),
      toolComplexity: level(answers.tool_complexity),
    },
  }
}

export type Reply =
  | { outcome: 'ok'; ms: number; answer: Answer }
  | { outcome: 'timeout' | 'incompatible' | 'unreachable'; ms: number; detail: string }

/** One POST to `/v1/systemone`. Never throws: routing is fail-open, so every failure is a Reply. */
export async function askSystemOne($: EngineInterface, backend: Backend, request: object, timeoutMs: number): Promise<Reply> {
  const started = await $.clock.now()
  const elapsed = async () => (await $.clock.now()) - started
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (backend.key) headers.authorization = `Bearer ${backend.key}`

  let timer: { cancel(): void } | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = $.clock.after(timeoutMs, () => resolve('timeout'))
  })
  try {
    const res: HttpResponse | 'timeout' = await Promise.race([
      $.http.fetch(`${backend.url}/v1/systemone`, { method: 'POST', headers, body: JSON.stringify(request) }),
      timeout,
    ])
    if (res === 'timeout') return { outcome: 'timeout', ms: await elapsed(), detail: `no answer in ${timeoutMs}ms` }
    if (!res.ok) return { outcome: 'incompatible', ms: await elapsed(), detail: `HTTP ${res.status} ${res.text.slice(0, 160)}` }
    const answer = parseAnswer(res.text)
    if (!answer) return { outcome: 'incompatible', ms: await elapsed(), detail: 'response has no model choice' }
    return { outcome: 'ok', ms: await elapsed(), answer }
  } catch (err) {
    return { outcome: 'unreachable', ms: await elapsed(), detail: String(err) }
  } finally {
    timer?.cancel()
  }
}
