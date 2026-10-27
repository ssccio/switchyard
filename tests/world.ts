import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

/** A SystemOne response choosing `model`. */
export const answer = (model: string, confidence = 0.95) =>
  JSON.stringify({
    model: 'jev-latest',
    answers: {
      model: { type: 'choice', choice: model, confidence, probabilities: { [model]: confidence } },
      task_complexity: { type: 'score', score: 2, confidence: 0.9 },
      reasoning_required: { type: 'score', score: 3, confidence: 0.9 },
      tool_complexity: { type: 'score', score: 1, confidence: 0.9 },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  })

type Reply = { status: number; text: string } | 'hang'

/**
 * Everything beneath the plugin. Each `/v1/systemone` call takes the next reply; once they run out,
 * every call chooses Haiku. Each model request reports 1000 input and 100 output tokens.
 */
export function world(on: On, opts: { env?: Record<string, string>; replies?: Reply[] } = {}) {
  const clock = mock.clock(on)
  mock.env(on, opts.env ?? { JEV_API_KEY: 'test-key' })

  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))

  const requests: { url: string; headers: Record<string, string>; body: any }[] = []
  const replies = [...(opts.replies ?? [])]
  on('http.fetch', async ($, e) => {
    requests.push({ url: e.url, headers: e.init?.headers ?? {}, body: JSON.parse(e.init?.body ?? 'null') })
    const reply = replies.shift() ?? { status: 200, text: answer('claude-haiku-5-5') }
    if (reply === 'hang') {
      await clock.sleep(60_000)
      return { value: { status: 200, ok: true, headers: {}, text: answer('claude-haiku-5-5') } }
    }
    return { value: { status: reply.status, ok: reply.status < 300, headers: {}, text: reply.text } }
  })

  const models: string[] = []
  on('turn.step', async function* ($, e) {
    models.push(e.model)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model },
    }
  })

  const spawns: (string | undefined)[] = []
  on('agent.spawn', ($, e) => {
    spawns.push(e.model)
    return { model: e.model ?? e.parentModel, agentId: 'agent-1' }
  })

  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('command.register', () => ({ value: { command: 'switchyard' } }))
  on('classic.PreModelSwitch', () => ({}))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })

  return { clock, store, requests, models, spawns, logs }
}

export async function start($: Engine, clock: MockClock) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // The startup probe runs unawaited; let it finish.
  await clock.settle()
}

/** Fires one model request through the plugin and reads its stream to the end. */
export async function step($: Engine, e: { turnId: string; index: number; model: string; agentId?: string }) {
  const stream = $.turn.step({ messageCount: 1, ...e })
  let next = await stream.next()
  while (next.done !== true) next = await stream.next()
  return next.value
}

export const prompt = ($: Engine, text: string, kind: 'composer' | 'peer' | 'task-notification' | 'sdk' = 'composer') =>
  $.prompt.submit({ text, wait: false, origin: { kind } })

export const run = async ($: Engine, args: string) =>
  (await $.command.run({ command: 'switchyard', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

export const spawn = ($: Engine, extra: { model?: string; fork?: boolean } = {}) =>
  $.agent.spawn({
    tool_use_id: 'tool-1',
    prompt: 'find every caller of parse() and list them',
    description: 'find callers',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...extra,
  })

export const pickModel = ($: Engine, requested: string) =>
  $.classic.PreModelSwitch({
    session_id: 'session-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/work',
    from_model: 'claude-opus-5-5',
    to_model: 'claude-sonnet-5-5',
    requested_model: requested,
    source: 'picker',
    context_tokens: 0,
    prompt_cache_warm: false,
    cache_ttl: '5m',
    estimated_cache_write_usd: 0,
    pricing: 'catalog',
  })
