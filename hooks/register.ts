import type { EngineInterface, Register } from 'claude-code'
import { resolveSettings, THRESHOLDS, tierOf, type Settings } from '../src/config.ts'
import { decide, detectOverride, isUserOrigin, type Verdict } from '../src/policy.ts'
import { askSystemOne, buildRequest, type Reply } from '../src/systemone.ts'
import { addDecision, addStep, emptyTotals, mergeTotals, savings, type DecisionRecord, type Totals, type Usage } from '../src/stats.ts'
import { bandLine, explainText, statsLines, type BandState } from '../src/view.ts'

type Api = EngineInterface
type Saved = { updatedAt: number; totals: Totals; recent: DecisionRecord[] }

const PANE = 'switchyard-stats'
/** ponytail: "all-time" is the newest 100 sessions, which keeps $.store far under its 4 MiB cap. */
const KEEP_SESSIONS = 100

/**
 * SWITCHYARD_DEBUG: `1` logs each routing event as a dim transcript line; any other value is also a
 * file the lines are appended to. For development, to see where requests go.
 */
let debug: string | null = null
let debugFile = Promise.resolve()

function dbg($: Api, line: string) {
  if (!debug) return
  void $.ui.log(line)
  if (debug === '1') return
  const path = debug
  // ponytail: $.fs.write replaces the file, so append is read-then-write, queued to keep lines in order
  debugFile = debugFile
    .then(async () => {
      const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
      await $.fs.write(path, `${old}${new Date(await $.clock.now()).toISOString()} ${line}\n`)
    })
    .catch(() => {})
}

let settings: Settings | null = null
let sessionId = 'unknown'
let probe = 'pending'
/** Whether the backend took `keep_alive` at startup; only Ollama documents it. */
let keepAlive = false
let paused: string | null = null
/** The prompt typed while idle, waiting for the turn it starts. */
let pendingPrompt: string | null = null
/** What the main thread runs on now; null until the first routed turn, or after /switchyard on. */
let mainModel: string | null = null
/** The session's own model, before any rewrite: the "usual" baseline. */
let sessionModel: string | null = null
let pin: { turnId: string; model: string } | null = null
let lastStepModel: string | null = null
let contextTokens = 0
/** Usual-baseline model per routed sub-agent. */
const agentBaselines = new Map<string, string>()
let totals: Totals = emptyTotals()
let recent: DecisionRecord[] = []
let lastSessions: Totals = emptyTotals()
let last: BandState['last'] = null

const status = (): BandState => ({
  off: settings?.backend ? undefined : settings?.offReason,
  paused,
  probe,
  last,
  sessionNet: savings(totals).net,
})

async function readEnv($: Api) {
  return {
    SWITCHYARD_SYSTEMONE_URL: await $.env.get('SWITCHYARD_SYSTEMONE_URL'),
    SWITCHYARD_SYSTEMONE_MODEL: await $.env.get('SWITCHYARD_SYSTEMONE_MODEL'),
    SWITCHYARD_SYSTEMONE_KEY: await $.env.get('SWITCHYARD_SYSTEMONE_KEY'),
    SWITCHYARD_TIMEOUT_MS: await $.env.get('SWITCHYARD_TIMEOUT_MS'),
    SWITCHYARD_BASELINE: await $.env.get('SWITCHYARD_BASELINE'),
    SWITCHYARD_ALLOW_FABLE: await $.env.get('SWITCHYARD_ALLOW_FABLE'),
    JEV_API_KEY: await $.env.get('JEV_API_KEY'),
    TYPESAFE_API_KEY: await $.env.get('TYPESAFE_API_KEY'),
  }
}

async function ask($: Api, prompt: string, current: string, context: number, timeoutMs?: number, withKeepAlive = keepAlive): Promise<Reply> {
  const s = settings!
  const backend = s.backend!
  const request = buildRequest({ model: backend.model, prompt, current, contextTokens: context, models: s.models, tiers: s.tiers })
  const reply = await askSystemOne($, backend, withKeepAlive ? { ...request, keep_alive: '30m' } : request, timeoutMs ?? backend.timeoutMs)
  const result = reply.outcome === 'ok' ? `choice=${reply.answer.model} confidence=${reply.answer.confidence.toFixed(2)}` : reply.detail
  dbg($, `systemone ${backend.url}/v1/systemone model=${backend.model} keep_alive=${withKeepAlive} → ${reply.outcome} ${reply.ms}ms ${result}`)
  return reply
}

/** One call at startup: proves the server speaks SystemOne and loads a cold local model. */
async function runProbe($: Api) {
  const s = settings!
  const probeAsk = (withKeepAlive: boolean) => ask($, 'rename a variable', s.models.opus, 0, THRESHOLDS.probeTimeoutMs, withKeepAlive)
  const custom = s.backend!.kind === 'custom'
  let reply = await probeAsk(custom)
  if (reply.outcome === 'incompatible' && custom) {
    // ponytail: a server that rejects keep_alive gets one retry without it
    reply = await probeAsk(false)
  } else {
    // Turns send keep_alive only once the server has accepted it.
    keepAlive = custom && reply.outcome === 'ok'
  }
  probe = reply.outcome === 'ok' ? 'ready' : `${reply.outcome}: ${reply.detail}`
  $.ui.invalidate('ui.render')
}

/** Ask, apply policy, and record the decision. */
async function route($: Api, prompt: string, current: string, context: number, agent: boolean): Promise<Verdict> {
  const s = settings!
  const from = tierOf(current) ?? 'opus'
  const reply = detectOverride(prompt) ? null : await ask($, prompt, current, context)
  const answer = reply?.outcome === 'ok' ? reply.answer : null
  const chosen = answer ? tierOf(answer.model) : null
  const verdict = decide({
    prompt,
    answer: answer && chosen ? { tier: chosen, confidence: answer.confidence } : null,
    current: from,
    available: s.tiers,
    contextTokens: context,
  })
  const outcome = reply === null ? 'override' : reply.outcome !== 'ok' ? reply.outcome : verdict.changed ? 'routed' : 'keep'
  const ms = reply?.ms ?? 0
  totals = addDecision(totals, outcome, ms)
  recent = [
    ...recent,
    { at: await $.clock.now(), agent, prompt: prompt.slice(0, 200), outcome, ms, from, to: verdict.tier, reason: verdict.reason, answer: answer ?? undefined },
  ].slice(-20)
  last = { tier: verdict.tier, ms, outcome }
  return verdict
}

/** First request of a main-thread turn: decide once and pin the result for the whole turn. */
async function startTurn($: Api, turnId: string, model: string) {
  const prompt = pendingPrompt
  pendingPrompt = null
  if (!settings?.backend || paused) {
    pin = null
    return
  }
  const current = mainModel ?? model
  if (prompt !== null) {
    const verdict = await route($, prompt, current, contextTokens, false)
    mainModel = verdict.changed ? settings.models[verdict.tier] : current
  } else {
    mainModel = current
  }
  pin = { turnId, model: mainModel }
}

async function save($: Api) {
  await $.store.set(`session:${sessionId}`, { updatedAt: await $.clock.now(), totals, recent } satisfies Saved)
}

async function record($: Api, agentId: string | undefined, usage: Usage) {
  const s = settings!
  const usual = agentId === undefined ? sessionModel ?? usage.model : agentBaselines.get(agentId) ?? usage.model
  const baseline = s.baseline === 'usual' ? usual : s.baseline === 'opus' ? s.models.opus : s.baseline
  const switched = agentId === undefined && lastStepModel !== null && lastStepModel !== usage.model
  if (agentId === undefined) {
    lastStepModel = usage.model
    contextTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
  }
  totals = addStep(totals, { usage, baseline, switched, prices: s.prices })
  await save($)
  $.ui.invalidate('ui.render')
}

/** Per-session state back to its start, so nothing carries over if a module outlives a session. */
function resetSession() {
  probe = 'pending'
  keepAlive = false
  paused = null
  pendingPrompt = null
  mainModel = null
  sessionModel = null
  pin = null
  lastStepModel = null
  contextTokens = 0
  agentBaselines.clear()
  totals = emptyTotals()
  recent = []
  last = null
}

async function loadSessions($: Api): Promise<{ key: string; saved: Saved }[]> {
  const keys = (await $.store.keys()).filter((key) => key.startsWith('session:'))
  const all = await Promise.all(keys.map(async (key) => ({ key, saved: (await $.store.get(key)) as Saved })))
  return all.filter((x) => x.saved).sort((a, b) => b.saved.updatedAt - a.saved.updatedAt)
}

async function pruneSessions($: Api) {
  for (const { key } of (await loadSessions($)).slice(KEEP_SESSIONS)) await $.store.delete(key)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    settings = resolveSettings(await readEnv($), options)
    sessionId = await $.session.id()
    resetSession()
    debug = (await $.env.get('SWITCHYARD_DEBUG')) || null
    const saved = (await $.store.get(`session:${sessionId}`)) as Saved | undefined
    if (saved) {
      // A reload of the module mid-session keeps the session's figures.
      totals = saved.totals
      recent = saved.recent
    }
    await pruneSessions($)
    // Not awaited: a cold local model must not hold up the first prompt.
    if (settings.backend) void runProbe($)
    // Last, because it throws when the name is taken.
    await $.command.register({ name: 'switchyard', description: 'Model routing: on, off, stats, explain', argumentHint: '[on|off|stats|explain]', immediate: true })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A prompt typed mid-turn joins the running turn; only an idle one starts a turn of its own.
    // Injected messages (hand-backs, notifications, peers) start turns too but are not the user's words.
    const routes = e.turnId === undefined && isUserOrigin(e.origin.kind)
    if (routes) pendingPrompt = e.text
    dbg($, `prompt.submit origin=${e.origin.kind} ${e.turnId === undefined ? 'idle' : 'mid-turn'} ${routes ? 'will route' : 'not routed'}: ${e.text.slice(0, 60).replace(/\s+/g, ' ')}`)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!settings) return yield* next(e)
    let request = e
    if (e.agentId === undefined) {
      sessionModel = e.model
      if (e.index === 0) await startTurn($, e.turnId, e.model)
      if (pin?.turnId === e.turnId && pin.model !== e.model) request = { ...e, model: pin.model }
    }
    const result = yield* next(request)
    const who = e.agentId === undefined ? 'main' : `agent ${e.agentId}`
    dbg($, `turn.step ${who} #${e.index}: asked ${e.model}, sent ${request.model}, answered by ${result.usage?.model ?? 'unknown'}`)
    if (result.usage) await record($, e.agentId, result.usage)
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const skip = !settings?.backend ? 'routing off' : paused ? 'paused' : e.fork ? 'fork' : e.model !== undefined ? `asked for ${e.model}` : null
    if (skip) {
      const result = await next(e)
      dbg($, `agent.spawn ${e.subagentType}: left alone (${skip}), runs on ${result.deny === undefined ? result.model : 'nothing: refused'}`)
      return result
    }
    const s = settings!
    // ponytail: an agent definition's own model is invisible here, so the parent's stands in for "current"
    const verdict = await route($, e.prompt, e.parentModel, 0, true)
    const result = await next(verdict.changed ? { ...e, model: s.models[verdict.tier] } : e)
    if (result.deny === undefined && result.agentId) agentBaselines.set(result.agentId, verdict.changed ? e.parentModel : result.model)
    dbg($, `agent.spawn ${e.subagentType}: ${verdict.changed ? `routed to ${verdict.tier}` : 'unchanged'} (${verdict.reason}), runs on ${result.deny === undefined ? result.model : 'nothing: refused'}`)
    return result
  })

  on('classic.PreModelSwitch', async ($, e, next) => {
    paused = `you picked ${e.requested_model ?? e.to_model}`
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'switchyard' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      paused = 'turned off'
      $.ui.invalidate('ui.render')
      return { text: 'switchyard paused. /switchyard on resumes routing.' }
    }
    if (arg === 'on') {
      paused = null
      mainModel = null
      $.ui.invalidate('ui.render')
      return { text: settings?.backend ? 'switchyard is routing.' : `switchyard can't route: ${settings?.offReason}` }
    }
    if (arg === 'stats') {
      lastSessions = mergeTotals((await loadSessions($)).slice(0, KEEP_SESSIONS).map((x) => x.saved.totals))
      await $.ui.open({ id: PANE, title: 'switchyard', closeOnEscape: true })
      return {}
    }
    if (arg === 'explain') return { text: explainText(recent.at(-1)) }
    return { text: bandLine(status()) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!settings) return next(e)
    const { Text } = $.ui.resolve(e)
    // ponytail: draws the whole band, so another mod's band line is hidden; nest `await next(e)` in a Box if that matters
    return Text({ dimColor: true, children: [bandLine(status())] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: statsLines(totals, lastSessions).map((line) => Text({ children: [line] })) })
  })
}
