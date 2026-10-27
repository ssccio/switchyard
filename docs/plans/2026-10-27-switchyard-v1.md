# switchyard v1 — implementation plan

Spec: `docs/specs/2026-10-27-switchyard-design.md`. Porting reference: `/Users/ken/dev/AI/jev-router`
(`src/policy.mjs`, `src/config.mjs`, `src/router.mjs`, `test/policy.test.mjs`).

Repo root is the plugin directory. Run every command from `/Users/ken/dev/AI/switchyard`.

## Decisions made while planning (differences from the spec)

- **Decision timeout for a custom URL is 8000 ms, not 15000.** A hook's own time limit is 10 s, and
  waiting on our own timeout promise counts against it. The startup probe, which runs outside the
  per-turn path, gets 30 s (the `$.http.fetch` maximum) to load a cold local model.
- **No `effort` rewrite.** Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.1 all accept `effort`, so
  only `model` is rewritten.
- **The price table is built in; there is no config override.** The tier table can be overridden
  through the `models` option.
- **"All-time" stats cover the newest 100 sessions**, so `$.store` stays far under its 4 MiB limit.
- **Sub-agent baseline:** when switchyard changes a sub-agent's model, the "usual" baseline is the
  parent's model, because a mod can't see an agent definition's own `model`. When switchyard leaves
  the spawn alone, the baseline is the model Claude Code resolved for it, so the spawn records no savings.

## Facts the code relies on (from the mod type definitions, Claude Code 2.1.277 and later)

- `turn.step` input: `{ turnId, index, model, effort?, messageCount, agentId? }`. The hook is an
  async generator, rewrites with `yield* next({ ...e, model })`, and its result carries
  `usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model } | null`.
- `agent.spawn` input: `{ tool_use_id, prompt, description, subagentType, provider, model?, parentModel, background, fork, ... }`.
  The result is `{ model, agentId? }` or `{ deny }`.
- `prompt.submit` input: `{ text, turnId?, ... }`. `turnId` is set only when the prompt is delivered
  into a turn that is already running.
- `$.http.fetch(url, { method, headers, body })` resolves to `{ status, ok, headers, text }`.
- `$.store.get/set/delete/keys`, `$.env.get('LITERAL_NAME')`, `$.clock.now/after`, `$.session.id()`.
- Tests: `import { expect, mock, test } from 'claude-code/testing'`, run with `claude plugin test`.
  Stubs are registered with the test's `on` before the first call on `$`. A stub for a mods API call
  returns `{ value }`.

---

## Task 0: Branch

```bash
git checkout -b feat/switchyard-v1
```

Expected: `Switched to a new branch 'feat/switchyard-v1'`.

---

## Task 1: Plugin scaffold

**Files:** `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts`, `tests/smoke.test.ts`

### 1.1 Failing test — `tests/smoke.test.ts`

```ts
import { expect, test } from 'claude-code/testing'

test('registers /switchyard at session start', async ($, on) => {
  const names: string[] = []
  on('command.register', ($, e) => {
    names.push(e.name)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(names).toEqual(['switchyard'])
})
```

Run: `claude plugin test`
Expected: the run fails because the plugin directory has no manifest or hooks module yet.

### 1.2 Implement

`.claude-plugin/plugin.json`:

```json
{
  "name": "switchyard",
  "version": "0.1.0",
  "description": "Routes each Claude Code turn and sub-agent to the cheapest sufficient model using a SystemOne decision model",
  "userConfig": {
    "systemone_url": {
      "type": "string",
      "title": "SystemOne URL",
      "description": "Base URL of a /v1/systemone server, e.g. http://localhost:11434. Blank uses TypeSafe.",
      "default": ""
    },
    "systemone_model": {
      "type": "string",
      "title": "Decision model",
      "description": "Model the SystemOne server runs, e.g. clef-flash. Blank uses jev-latest on TypeSafe.",
      "default": ""
    },
    "systemone_key": {
      "type": "string",
      "title": "SystemOne API key",
      "description": "Bearer key for a server that needs one",
      "sensitive": true
    },
    "timeout_ms": {
      "type": "number",
      "title": "Decision timeout (ms)",
      "description": "0 uses 3000 for TypeSafe and 8000 otherwise. Capped at 9000.",
      "default": 0
    },
    "baseline": {
      "type": "string",
      "title": "Savings baseline",
      "description": "usual, opus, or an exact model id",
      "default": "usual"
    },
    "models": {
      "type": "string",
      "title": "Tier models",
      "description": "Overrides, e.g. haiku=claude-haiku-5-5,opus=claude-opus-5-5",
      "default": ""
    },
    "allow_fable": {
      "type": "boolean",
      "title": "Allow the Fable tier",
      "default": false
    }
  }
}
```

`hooks/hooks.json`:

```json
{ "modules": ["./register.ts"] }
```

`hooks/register.ts`. Task 7 replaces this file:

```ts
import type { Register } from 'claude-code'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'switchyard', description: 'Model routing: on, off, stats, explain', argumentHint: '[on|off|stats|explain]', immediate: true })
    return next(e)
  })
}
```

### 1.3 Verify

```bash
claude plugin validate . --strict
claude plugin test
```

Expected: validate reports no errors, then `(pass) registers /switchyard at session start` and `1 pass  0 fail`.

### 1.4 Commit

Use the commit-sscc workflow, mid-feature mode. Message: `feat: plugin scaffold`.

---

## Task 2: Config

**Files:** `src/config.ts`, `tests/config.test.ts`

### 2.1 Failing test — `tests/config.test.ts`

```ts
import { expect, test } from 'claude-code/testing'
import { DEFAULT_MODELS, resolveSettings, tierOf } from '../src/config.ts'

test('a JEV key selects TypeSafe with its defaults', () => {
  const s = resolveSettings({ JEV_API_KEY: 'k' }, {})
  expect(s.backend).toEqual({ kind: 'typesafe', url: 'https://api.typesafe.ai', model: 'jev-latest', key: 'k', timeoutMs: 3000 })
})

test('TYPESAFE_API_KEY works too', () => {
  expect(resolveSettings({ TYPESAFE_API_KEY: 't' }, {}).backend?.key).toBe('t')
})

test('a SystemOne URL wins over a TypeSafe key', () => {
  const s = resolveSettings({ JEV_API_KEY: 'k', SWITCHYARD_SYSTEMONE_URL: 'http://localhost:11434/', SWITCHYARD_SYSTEMONE_MODEL: 'clef-flash' }, {})
  expect(s.backend).toEqual({ kind: 'custom', url: 'http://localhost:11434', model: 'clef-flash', key: undefined, timeoutMs: 8000 })
})

test('a URL without a model turns routing off and says why', () => {
  const s = resolveSettings({ SWITCHYARD_SYSTEMONE_URL: 'http://localhost:11434' }, {})
  expect(s.backend).toBe(null)
  expect(s.offReason).toMatch(/SWITCHYARD_SYSTEMONE_MODEL/)
})

test('nothing configured turns routing off', () => {
  const s = resolveSettings({}, {})
  expect(s.backend).toBe(null)
  expect(s.offReason).toMatch(/JEV_API_KEY/)
})

test('userConfig options beat the environment', () => {
  const s = resolveSettings(
    { SWITCHYARD_SYSTEMONE_URL: 'http://env', SWITCHYARD_SYSTEMONE_MODEL: 'env-model', SWITCHYARD_BASELINE: 'opus' },
    { systemone_url: 'http://opt', systemone_model: 'opt-model', baseline: 'claude-sonnet-5-5' },
  )
  expect(s.backend?.url).toBe('http://opt')
  expect(s.backend?.model).toBe('opt-model')
  expect(s.baseline).toBe('claude-sonnet-5-5')
})

test('blank options fall through to the environment', () => {
  const s = resolveSettings({ SWITCHYARD_SYSTEMONE_URL: 'http://env', SWITCHYARD_SYSTEMONE_MODEL: 'm' }, { systemone_url: '', timeout_ms: 0 })
  expect(s.backend?.url).toBe('http://env')
})

test('the timeout is capped below the hook time limit', () => {
  expect(resolveSettings({ JEV_API_KEY: 'k', SWITCHYARD_TIMEOUT_MS: '60000' }, {}).backend?.timeoutMs).toBe(9000)
  expect(resolveSettings({ JEV_API_KEY: 'k' }, { timeout_ms: 1500 }).backend?.timeoutMs).toBe(1500)
})

test('fable is opt-in', () => {
  expect(resolveSettings({}, {}).tiers).toEqual(['haiku', 'sonnet', 'opus'])
  expect(resolveSettings({ SWITCHYARD_ALLOW_FABLE: '1' }, {}).tiers).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
  expect(resolveSettings({}, { allow_fable: true }).tiers).toContain('fable')
})

test('the models option overrides single tiers', () => {
  const s = resolveSettings({}, { models: 'opus=claude-opus-5, nonsense=x' })
  expect(s.models).toEqual({ ...DEFAULT_MODELS, opus: 'claude-opus-5' })
})

test('tierOf reads aliases and older versions', () => {
  expect(tierOf('haiku')).toBe('haiku')
  expect(tierOf('claude-opus-4-8')).toBe('opus')
  expect(tierOf('gpt-6')).toBe(null)
  expect(tierOf(undefined)).toBe(null)
})
```

Run: `claude plugin test tests`
Expected: fails with an error loading `../src/config.ts`.

### 2.2 Implement — `src/config.ts`

```ts
// Every routing knob lives here, so the whole policy is reviewable in one file.

export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'

/** Cheapest first. */
export const TIER_NAMES: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']

export const rankOf = (tier: Tier) => TIER_NAMES.indexOf(tier)

/** Exact model id per tier; the `models` option overrides any of them. */
export const DEFAULT_MODELS: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}

/** Tier of a model id or alias (`haiku`, `claude-opus-4-8`), by family name; null when unrecognised. */
export const tierOf = (model: string | undefined): Tier | null =>
  TIER_NAMES.find((tier) => model?.includes(tier) ?? false) ?? null

export const THRESHOLDS = {
  /** Below this confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.3,
  uncertainCeiling: 'sonnet' as Tier,
  /**
   * A model switch re-sends the whole conversation uncached (measured at ~23.6k cache-creation
   * tokens switching into Opus), so a downgrade only pays off while the conversation is small.
   */
  downgradeMaxContextTokens: 20000,
  /** TypeSafe answers in ~300 ms warm. A hook may run 10 s, so nothing waits longer than 9 s. */
  typesafeTimeoutMs: 3000,
  customTimeoutMs: 8000,
  maxTimeoutMs: 9000,
  /** The startup probe also loads a cold local model, so it gets the longest fetch the host allows. */
  probeTimeoutMs: 30000,
}

export type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }

/**
 * USD per million tokens, Anthropic list prices. Cache write is the 5-minute rate (1.25x input).
 * ponytail: priced by tier family, so an older version in a family (claude-opus-4-8) is priced as
 * the current one; add per-id entries if that skews the savings figure.
 */
export const PRICES: Record<Tier, Price> = {
  haiku: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  fable: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
}

export type Backend = { kind: 'typesafe' | 'custom'; url: string; model: string; key?: string; timeoutMs: number }

export type Settings = {
  backend: Backend | null
  /** Why routing is off, when `backend` is null. */
  offReason: string
  baseline: string
  tiers: Tier[]
  models: Record<Tier, string>
  prices: Record<Tier, Price>
}

/** The variables switchyard reads. `$.env.get` needs each name written literally. */
export type Env = Partial<
  Record<
    | 'SWITCHYARD_SYSTEMONE_URL'
    | 'SWITCHYARD_SYSTEMONE_MODEL'
    | 'SWITCHYARD_SYSTEMONE_KEY'
    | 'SWITCHYARD_TIMEOUT_MS'
    | 'SWITCHYARD_BASELINE'
    | 'SWITCHYARD_ALLOW_FABLE'
    | 'JEV_API_KEY'
    | 'TYPESAFE_API_KEY',
    string | undefined
  >
>

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/** `haiku=claude-haiku-5-5,opus=claude-opus-5` to overrides for those tiers; unknown tiers are ignored. */
function parseModels(spec: string | undefined): Partial<Record<Tier, string>> {
  const out: Partial<Record<Tier, string>> = {}
  for (const pair of spec?.split(',') ?? []) {
    const [tier, id] = pair.split('=').map((part) => part.trim())
    if (TIER_NAMES.includes(tier as Tier) && id) out[tier as Tier] = id
  }
  return out
}

/** userConfig options first, then the environment. */
export function resolveSettings(env: Env, options: Readonly<Record<string, unknown>>): Settings {
  const url = text(options.systemone_url) ?? text(env.SWITCHYARD_SYSTEMONE_URL)
  const model = text(options.systemone_model) ?? text(env.SWITCHYARD_SYSTEMONE_MODEL)
  const timeout = Math.min(Number(options.timeout_ms) || Number(env.SWITCHYARD_TIMEOUT_MS) || 0, THRESHOLDS.maxTimeoutMs)
  const typesafeKey = text(env.JEV_API_KEY) ?? text(env.TYPESAFE_API_KEY)

  let backend: Backend | null = null
  let offReason = ''
  if (url) {
    if (model) {
      const key = text(options.systemone_key) ?? text(env.SWITCHYARD_SYSTEMONE_KEY)
      backend = { kind: 'custom', url: url.replace(/\/+$/, ''), model, key, timeoutMs: timeout || THRESHOLDS.customTimeoutMs }
    } else {
      offReason = 'SWITCHYARD_SYSTEMONE_MODEL is not set'
    }
  } else if (typesafeKey) {
    backend = { kind: 'typesafe', url: 'https://api.typesafe.ai', model: model ?? 'jev-latest', key: typesafeKey, timeoutMs: timeout || THRESHOLDS.typesafeTimeoutMs }
  } else {
    offReason = 'no backend: set JEV_API_KEY or SWITCHYARD_SYSTEMONE_URL'
  }

  const allowFable = options.allow_fable === true || env.SWITCHYARD_ALLOW_FABLE === '1'
  return {
    backend,
    offReason,
    baseline: text(options.baseline) ?? text(env.SWITCHYARD_BASELINE) ?? 'usual',
    tiers: TIER_NAMES.filter((tier) => tier !== 'fable' || allowFable),
    models: { ...DEFAULT_MODELS, ...parseModels(text(options.models)) },
    prices: PRICES,
  }
}
```

### 2.3 Verify

Run: `claude plugin test`
Expected: all config tests and the smoke test pass, `0 fail`.

### 2.4 Commit

commit-sscc, mid-feature. Message: `feat: settings and backend selection`.

---

## Task 3: Policy

**Files:** `src/policy.ts`, `tests/policy.test.ts`

### 3.1 Failing test — `tests/policy.test.ts`

```ts
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
```

Run: `claude plugin test`
Expected: fails loading `../src/policy.ts`.

### 3.2 Implement — `src/policy.ts`

```ts
import { rankOf, THRESHOLDS, TIER_NAMES, type Tier } from './config.ts'

/** Phrases that mean "the human already decided", checked against the raw prompt. */
const OVERRIDES: [Tier, RegExp][] = [
  ['haiku', /\b(?:use|switch to|with|on)\s+(?:haiku|fast)\b/i],
  ['sonnet', /\b(?:use|switch to|with|on)\s+(?:sonnet|balanced)\b/i],
  ['opus', /\b(?:use|switch to|with|on)\s+(?:opus|strong)\b/i],
  ['fable', /\b(?:use|switch to|with|on)\s+(?:fable|long)\b/i],
]

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(prompt: string): Tier | null {
  return OVERRIDES.find(([, re]) => re.test(prompt))?.[0] ?? null
}

/**
 * Nearest tier the session can run. Prefers stepping up so a hard task never silently lands on a
 * weaker model, but never steps up into fable unless fable was asked for.
 */
function clampToAvailable(tier: Tier, available: readonly Tier[]): Tier | null {
  if (available.includes(tier)) return tier
  const rank = rankOf(tier)
  const up = TIER_NAMES.find((t, i) => i > rank && available.includes(t) && (t !== 'fable' || tier === 'fable'))
  if (up) return up
  return [...TIER_NAMES].reverse().find((t) => rankOf(t) < rank && available.includes(t)) ?? null
}

export type Verdict = { tier: Tier; reason: string; changed: boolean }

/**
 * Turns a decision model's answer into the tier we will run. Pure and total: a missing,
 * low-confidence or unavailable answer falls back to the tier already in use.
 */
export function decide(input: {
  prompt: string
  answer: { tier: Tier; confidence: number } | null
  current: Tier
  available: readonly Tier[]
  contextTokens?: number
}): Verdict {
  const { prompt, answer, current, available, contextTokens = 0 } = input
  const settle = (tier: Tier, reason: string): Verdict => {
    const final = clampToAvailable(tier, available) ?? current
    const why = final === tier ? reason : `${reason}+unavailable`
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current }
  }

  const override = detectOverride(prompt)
  if (override) return settle(override, 'override')
  if (!answer) return settle(current, 'no-answer')

  const target = answer.tier
  if (answer.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, 'low-confidence-no-downgrade')
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling))
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling], 'low-confidence-capped')
  }
  if (rankOf(target) < rankOf(current) && contextTokens > THRESHOLDS.downgradeMaxContextTokens) {
    return settle(current, 'downgrade-not-worth-cache-rebuild')
  }
  return settle(target, 'answer')
}
```

Note on the `override` test: the expected reason is `'override'` with no suffix. In that test the
current tier is sonnet and the override picks haiku, so `settle` doesn't add `/no-change`.

### 3.3 Verify

Run: `claude plugin test`
Expected: all policy tests pass, `0 fail`.

### 3.4 Commit

commit-sscc, mid-feature. Message: `feat: routing policy ported from jev-router`.

---

## Task 4: SystemOne client

**Files:** `src/systemone.ts`, `tests/systemone.test.ts`

### 4.1 Failing test — `tests/systemone.test.ts`

```ts
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
```

Run: `claude plugin test`
Expected: fails loading `../src/systemone.ts`.

### 4.2 Implement — `src/systemone.ts`

```ts
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
```

`askSystemOne` needs the mods API, so its timeout and error paths are tested through the plugin in
Task 7.

### 4.3 Verify

Run: `claude plugin test`
Expected: all tests pass, `0 fail`.

### 4.4 Commit

commit-sscc, mid-feature. Message: `feat: SystemOne request, parsing and client`.

---

## Task 5: Stats

**Files:** `src/stats.ts`, `tests/stats.test.ts`

### 5.1 Failing test — `tests/stats.test.ts`

```ts
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
```

Run: `claude plugin test`
Expected: fails loading `../src/stats.ts`.

### 5.2 Implement — `src/stats.ts`

```ts
import { tierOf, type Price, type Tier } from './config.ts'
import type { Answer } from './systemone.ts'

/** What `turn.step`'s result reports for one request. */
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Totals = {
  steps: number
  outcomes: Record<string, number>
  /** Decision latencies in ms, newest last, at most 200. */
  latencies: number[]
  tokens: Record<string, Tokens>
  actualUsd: number
  baselineUsd: number
  /** Cache writes a main-thread model switch caused, which the baseline would have read from cache. */
  switchPenaltyUsd: number
}

export type DecisionRecord = {
  at: number
  agent: boolean
  /** The first 200 characters of what was routed. */
  prompt: string
  outcome: string
  ms: number
  from: Tier
  to: Tier
  reason: string
  answer?: Answer
}

export const emptyTotals = (): Totals => ({
  steps: 0,
  outcomes: {},
  latencies: [],
  tokens: {},
  actualUsd: 0,
  baselineUsd: 0,
  switchPenaltyUsd: 0,
})

const priceOf = (model: string, prices: Record<Tier, Price>) => prices[tierOf(model) ?? 'opus']

export function costOf(u: Usage, model: string, prices: Record<Tier, Price>): number {
  const p = priceOf(model, prices)
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_input_tokens * p.cacheRead +
      u.cache_creation_input_tokens * p.cacheWrite) /
    1e6
  )
}

const addTokens = (a: Tokens | undefined, b: Tokens): Tokens => ({
  input: (a?.input ?? 0) + b.input,
  output: (a?.output ?? 0) + b.output,
  cacheRead: (a?.cacheRead ?? 0) + b.cacheRead,
  cacheWrite: (a?.cacheWrite ?? 0) + b.cacheWrite,
})

/**
 * One model request. The baseline is priced on the same token counts, so a switch's cache rebuild
 * is overstated there; switchPenaltyUsd backs it out for the net figure.
 */
export function addStep(t: Totals, s: { usage: Usage; baseline: string; switched: boolean; prices: Record<Tier, Price> }): Totals {
  const u = s.usage
  const b = priceOf(s.baseline, s.prices)
  const step = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }
  return {
    ...t,
    steps: t.steps + 1,
    tokens: { ...t.tokens, [u.model]: addTokens(t.tokens[u.model], step) },
    actualUsd: t.actualUsd + costOf(u, u.model, s.prices),
    baselineUsd: t.baselineUsd + costOf(u, s.baseline, s.prices),
    switchPenaltyUsd: t.switchPenaltyUsd + (s.switched ? (u.cache_creation_input_tokens * (b.cacheWrite - b.cacheRead)) / 1e6 : 0),
  }
}

export function addDecision(t: Totals, outcome: string, ms: number): Totals {
  return {
    ...t,
    outcomes: { ...t.outcomes, [outcome]: (t.outcomes[outcome] ?? 0) + 1 },
    latencies: [...t.latencies, ms].slice(-200),
  }
}

export const savings = (t: Totals) => ({
  gross: t.baselineUsd - t.actualUsd,
  net: t.baselineUsd - t.actualUsd - t.switchPenaltyUsd,
})

export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

export function mergeTotals(all: readonly Totals[]): Totals {
  return all.reduce((acc, t) => {
    const outcomes = { ...acc.outcomes }
    for (const [k, n] of Object.entries(t.outcomes)) outcomes[k] = (outcomes[k] ?? 0) + n
    const tokens = { ...acc.tokens }
    for (const [model, x] of Object.entries(t.tokens)) tokens[model] = addTokens(tokens[model], x)
    return {
      steps: acc.steps + t.steps,
      outcomes,
      latencies: [...acc.latencies, ...t.latencies],
      tokens,
      actualUsd: acc.actualUsd + t.actualUsd,
      baselineUsd: acc.baselineUsd + t.baselineUsd,
      switchPenaltyUsd: acc.switchPenaltyUsd + t.switchPenaltyUsd,
    }
  }, emptyTotals())
}
```

### 5.3 Verify

Run: `claude plugin test`
Expected: all tests pass, `0 fail`.

### 5.4 Commit

commit-sscc, mid-feature. Message: `feat: usage and savings stats`.

---

## Task 6: View text

**Files:** `src/view.ts`, `tests/view.test.ts`

### 6.1 Failing test — `tests/view.test.ts`

```ts
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
```

Run: `claude plugin test`
Expected: fails loading `../src/view.ts`.

### 6.2 Implement — `src/view.ts`

```ts
import { percentile, savings, type DecisionRecord, type Totals } from './stats.ts'

export type BandState = {
  off?: string
  paused: string | null
  /** `pending`, `ready`, or the failure the startup probe hit. */
  probe: string
  last: { tier: string; ms: number; outcome: string } | null
  sessionNet: number
}

export const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

const ROUTED = new Set(['routed', 'keep', 'override'])

export function bandLine(s: BandState): string {
  if (s.off) return `switchyard off · ${s.off}`
  if (s.paused) return `⏸ switchyard paused (${s.paused}) · /switchyard on`
  if (s.probe !== 'ready' && s.probe !== 'pending') return `⚠ switchyard ${s.probe}`
  const saved = `saved ${usd(s.sessionNet)} this session`
  if (!s.last) return `⚡ switchyard ready · ${saved}`
  const head = ROUTED.has(s.last.outcome) ? `⚡ ${s.last.tier}` : `⚠ ${s.last.outcome}, kept ${s.last.tier}`
  return `${head} · ${s.last.ms}ms · ${saved}`
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function block(title: string, t: Totals): string[] {
  const { gross, net } = savings(t)
  const decisions = Object.values(t.outcomes).reduce((a, b) => a + b, 0)
  const ms = (p: number) => {
    const v = percentile(t.latencies, p)
    return v === null ? '-' : `${v}ms`
  }
  const outcomes = Object.entries(t.outcomes).map(([o, n]) => `${o} ${n}`).join(' · ')
  return [
    `${title}: saved ${usd(net)} net (${usd(gross)} gross, ${usd(t.switchPenaltyUsd)} switch cost)`,
    `Decisions: ${decisions} · p50 ${ms(50)} · p95 ${ms(95)}`,
    `Outcomes: ${outcomes || 'none'}`,
    ...Object.entries(t.tokens).map(
      ([model, x]) => `  ${model}: in ${k(x.input)} · out ${k(x.output)} · cache read ${k(x.cacheRead)} · write ${k(x.cacheWrite)}`,
    ),
  ]
}

export const statsLines = (session: Totals, recent: Totals) => [...block('This session', session), '', ...block('Last 100 sessions', recent)]

export function explainText(rec: DecisionRecord | undefined): string {
  if (!rec) return 'switchyard has made no decision yet this session.'
  const level = (x: number | null) => (x === null ? '-' : x.toFixed(2))
  const a = rec.answer
  return [
    `Last decision (${rec.agent ? 'sub-agent' : 'main thread'}): ${rec.from} → ${rec.to}`,
    `Prompt: ${rec.prompt}`,
    `Outcome: ${rec.outcome} · ${rec.ms}ms · policy: ${rec.reason}`,
    a ? `Answer: ${a.model} at ${Math.round(a.confidence * 100)}% confidence` : 'Answer: none',
    a ? `Scores: task ${level(a.scores.taskComplexity)} · reasoning ${level(a.scores.reasoningRequired)} · tools ${level(a.scores.toolComplexity)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
```

### 6.3 Verify

Run: `claude plugin test`
Expected: all tests pass, `0 fail`.

### 6.4 Commit

commit-sscc, mid-feature. Message: `feat: band, stats and explain text`.

---

## Task 7: The hooks module

**Files:** replace `hooks/register.ts`; add `tests/world.ts` and `tests/routing.test.ts`; delete
`tests/smoke.test.ts`. The new `session.start` hook reads env, the session id and the store, so the
smoke test's stubs no longer cover it. `routing.test.ts` replaces it.

### 7.1 Test helper — `tests/world.ts`

```ts
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
  on('command.register', () => ({ value: undefined }))
  on('classic.PreModelSwitch', () => ({}))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  return { clock, store, requests, models, spawns }
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

export const prompt = ($: Engine, text: string) => $.prompt.submit({ text })

export const run = async ($: Engine, args: string) => (await $.command.run({ command: 'switchyard', args })).text ?? ''

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
    hook_event_name: 'PreModelSwitch',
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
```

### 7.2 Failing tests — `tests/routing.test.ts`

```ts
import { expect, test } from 'claude-code/testing'
import { answer, pickModel, prompt, run, spawn, start, step, world } from './world.ts'

const micro = (usd: number) => Math.round(usd * 1e6)

test('routes a fresh main-thread turn and pins it for the rest of the turn', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, 'rename the variable x to count')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  await step($, { turnId: 't1', index: 1, model: 'claude-opus-5-5' })
  expect(w.models).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
  // The startup probe, then one decision for the whole turn
  expect(w.requests.length).toBe(2)
  expect(w.requests[1].url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(w.requests[1].headers.authorization).toBe('Bearer test-key')
  expect(w.requests[1].body.model).toBe('jev-latest')
  expect(w.requests[1].body.state.request).toBe('rename the variable x to count')
})

test('a turn with no new prompt keeps the current model and asks nothing', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, 'rename x')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  await step($, { turnId: 't2', index: 0, model: 'claude-opus-5-5' })
  expect(w.models).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
  expect(w.requests.length).toBe(2)
})

test('an explicit override skips the decision call', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, 'use sonnet for this one')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(w.models).toEqual(['claude-sonnet-5-5'])
  expect(w.requests.length).toBe(1)
})

test('a timeout keeps the current model and the band says so', async ($, on) => {
  const w = world(on, { replies: [{ status: 200, text: answer('claude-haiku-5-5') }, 'hang'] })
  await start($, w.clock)
  await prompt($, 'rename x')
  const pending = step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  await w.clock.advance(3000)
  await pending
  expect(w.models).toEqual(['claude-opus-5-5'])
  expect(await run($, '')).toMatch(/⚠ timeout, kept opus/)
})

test('an incompatible local server is reported at startup, and keep_alive is dropped on retry', async ($, on) => {
  const bad = { status: 400, text: '{"error":"format no longer supported"}' }
  const w = world(on, {
    env: { SWITCHYARD_SYSTEMONE_URL: 'http://localhost:11434', SWITCHYARD_SYSTEMONE_MODEL: 'clef-flash' },
    replies: [bad, bad],
  })
  await start($, w.clock)
  expect(w.requests[0].url).toBe('http://localhost:11434/v1/systemone')
  expect(w.requests[0].body.model).toBe('clef-flash')
  expect(w.requests[0].body.keep_alive).toBe('30m')
  expect(w.requests[1].body.keep_alive).toBe(undefined)
  expect(await run($, '')).toMatch(/⚠ switchyard incompatible: HTTP 400/)
})

test('with no backend every request passes through untouched', async ($, on) => {
  const w = world(on, { env: {} })
  await start($, w.clock)
  await prompt($, 'rename x')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(w.models).toEqual(['claude-opus-5-5'])
  expect(w.requests.length).toBe(0)
  expect(await run($, '')).toMatch(/switchyard off · no backend/)
})

test('routes a sub-agent when it is spawned', async ($, on) => {
  const w = world(on, { replies: [{ status: 200, text: answer('claude-haiku-5-5') }, { status: 200, text: answer('claude-sonnet-5-5') }] })
  await start($, w.clock)
  await spawn($)
  expect(w.spawns).toEqual(['claude-sonnet-5-5'])
  expect(w.requests[1].body.state.request).toBe('find every caller of parse() and list them')
})

test('a spawn that names a model or forks passes through', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await spawn($, { model: 'haiku' })
  await spawn($, { fork: true })
  expect(w.spawns).toEqual(['haiku', undefined])
  expect(w.requests.length).toBe(1)
})

test('picking a model in /model pauses routing until /switchyard on', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await pickModel($, 'sonnet')
  await prompt($, 'rename x')
  await step($, { turnId: 't1', index: 0, model: 'claude-sonnet-5-5' })
  expect(w.models).toEqual(['claude-sonnet-5-5'])
  expect(await run($, '')).toMatch(/paused \(you picked sonnet\)/)

  await run($, 'on')
  await prompt($, 'rename y')
  await step($, { turnId: 't2', index: 0, model: 'claude-sonnet-5-5' })
  expect(w.models).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])
})

test('/switchyard off pauses routing', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await run($, 'off')
  await prompt($, 'rename x')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(w.models).toEqual(['claude-opus-5-5'])
})

test('records usage and savings against the session model', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, 'rename x')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  await step($, { turnId: 't1', index: 1, model: 'claude-opus-5-5' })
  const saved = w.store.get('session:session-1') as any
  expect(saved.totals.steps).toBe(2)
  expect(micro(saved.totals.actualUsd)).toBe(300)
  expect(micro(saved.totals.baselineUsd)).toBe(12000)
  expect(saved.recent.length).toBe(1)
})

test('explain shows the last decision', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, 'rename x')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(await run($, 'explain')).toMatch(/Last decision \(main thread\): opus → haiku/)
})

test('the band shows the last routed tier', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, 'rename x')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  const ui = await $.ui.mount({
    plugin: 'switchyard',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /⚡ haiku · \d+ms · saved \$0\.01 this session/ })).toBeDefined()
})

test('/switchyard stats opens the stats pane', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, 'rename x')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  await run($, 'stats')
  const ui = await $.ui.mount({
    plugin: 'switchyard',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'switchyard-stats',
    viewport: { columns: 120, rows: 40 },
    props: { title: 'switchyard', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /^This session: saved/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Last 100 sessions: saved/ })).toBeDefined()
})
```

Run: `rm tests/smoke.test.ts && claude plugin test`
Expected: the routing tests fail, because the Task 1 stub module doesn't route.

### 7.3 Implement — replace `hooks/register.ts`

```ts
import type { EngineInterface, Register } from 'claude-code'
import { resolveSettings, THRESHOLDS, tierOf, type Settings } from '../src/config.ts'
import { decide, detectOverride, type Verdict } from '../src/policy.ts'
import { askSystemOne, buildRequest, type Reply } from '../src/systemone.ts'
import { addDecision, addStep, emptyTotals, mergeTotals, savings, type DecisionRecord, type Totals, type Usage } from '../src/stats.ts'
import { bandLine, explainText, statsLines, type BandState } from '../src/view.ts'

type Api = EngineInterface
type Saved = { updatedAt: number; totals: Totals; recent: DecisionRecord[] }

const PANE = 'switchyard-stats'
/** ponytail: "all-time" is the newest 100 sessions, which keeps $.store far under its 4 MiB cap. */
const KEEP_SESSIONS = 100

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

function ask($: Api, prompt: string, current: string, context: number, timeoutMs?: number): Promise<Reply> {
  const s = settings!
  const backend = s.backend!
  const request = buildRequest({ model: backend.model, prompt, current, contextTokens: context, models: s.models, tiers: s.tiers })
  return askSystemOne($, backend, keepAlive ? { ...request, keep_alive: '30m' } : request, timeoutMs ?? backend.timeoutMs)
}

/** One call at startup: proves the server speaks SystemOne and loads a cold local model. */
async function runProbe($: Api) {
  const s = settings!
  keepAlive = s.backend!.kind === 'custom'
  let reply = await ask($, 'rename a variable', s.models.opus, 0, THRESHOLDS.probeTimeoutMs)
  if (reply.outcome === 'incompatible' && keepAlive) {
    // ponytail: a server that rejects keep_alive gets one retry without it
    keepAlive = false
    reply = await ask($, 'rename a variable', s.models.opus, 0, THRESHOLDS.probeTimeoutMs)
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
    if (e.turnId === undefined) pendingPrompt = e.text
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
    if (result.usage) await record($, e.agentId, result.usage)
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    if (!settings?.backend || paused || e.fork || e.model !== undefined) return next(e)
    // ponytail: an agent definition's own model is invisible here, so the parent's stands in for "current"
    const verdict = await route($, e.prompt, e.parentModel, 0, true)
    const result = await next(verdict.changed ? { ...e, model: settings.models[verdict.tier] } : e)
    if (result.deny === undefined && result.agentId) agentBaselines.set(result.agentId, verdict.changed ? e.parentModel : result.model)
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
```

### 7.4 Verify

```bash
claude plugin validate . --strict
claude plugin test
```

Expected: validate reports no errors. Every test in `config`, `policy`, `systemone`, `stats`, `view` and
`routing` passes, `0 fail`. If a `ui.mount` test fails only on prop validation, copy the exact
`AbovePrompt`/`Pane` prop shapes from the error message into the test. Don't change the hook.

### 7.5 Commit

commit-sscc, mid-feature. Message: `feat: route turns and sub-agents from a Claude Code mod`.

---

## Task 8: README and live verification

**Files:** `README.md`

### 8.1 Write `README.md`

```markdown
# switchyard

A Claude Code mod that routes each turn, and each sub-agent, to the cheapest model that can do the
job. A SystemOne decision model makes the call: TypeSafe Jev by default, or any server with a
`/v1/systemone` endpoint (Ollama, llama.cpp, LM Studio, LiteLLM).

Requires Claude Code v2.1.304 or later.

## Run

    claude --plugin-dir /path/to/switchyard

## Configure

Set these in `/config` (plugin options) or in the environment. Options win.

| Option | Env var | Default |
| --- | --- | --- |
| systemone_url | `SWITCHYARD_SYSTEMONE_URL` | TypeSafe |
| systemone_model | `SWITCHYARD_SYSTEMONE_MODEL` | `jev-latest` on TypeSafe; required otherwise |
| systemone_key | `SWITCHYARD_SYSTEMONE_KEY` | none |
| timeout_ms | `SWITCHYARD_TIMEOUT_MS` | 3000 TypeSafe, 8000 otherwise, capped at 9000 |
| baseline | `SWITCHYARD_BASELINE` | `usual` |
| models | — | haiku/sonnet/opus/fable 5.x ids |
| allow_fable | `SWITCHYARD_ALLOW_FABLE=1` | off |

TypeSafe needs `JEV_API_KEY` (or `TYPESAFE_API_KEY`). For a local model:

    SWITCHYARD_SYSTEMONE_URL=http://localhost:11434 SWITCHYARD_SYSTEMONE_MODEL=clef-flash claude --plugin-dir .

## Use

- The band above the prompt shows the last decision and this session's savings.
- `/switchyard off` / `on` pauses and resumes. Picking a model in `/model` also pauses.
- `/switchyard stats` opens latency, outcomes, tokens per model and savings.
- `/switchyard explain` shows why the last decision went the way it did.
- `use opus` (or haiku, sonnet, fast, strong) in a prompt overrides the decision for that turn.

## Limits

- Savings price the same token counts at the baseline model, so they are an estimate. "Net"
  subtracts the cache rebuilds that switching models caused.
- A mod can't see an agent definition's own model, so a routed sub-agent's baseline is its parent's model.
- Organization policy (`allowManagedHooksOnly`, `disableSideloadFlags`) can disable mods. On a Team
  or Enterprise login, the `/model` auto-pause may not fire; use `/switchyard off`.
```

### 8.2 Live checks (manual gate — record the results in the PR description)

1. TypeSafe model name:
   `curl -s -H "Authorization: Bearer $JEV_API_KEY" https://api.typesafe.ai/v1/models`
   Expected: the list includes `jev-latest`. If it doesn't, change the default in `resolveSettings`
   and its test.
2. TypeSafe end to end: `claude --plugin-dir .` with `JEV_API_KEY` set. Send `rename x to count in a.ts`.
   Expected: the band shows `⚡ haiku · …ms`, and `/switchyard stats` lists tokens under
   `claude-haiku-5-5`. That confirms `turn.step` accepts exact model ids (spec risk 1).
3. Sub-agent: ask for a task that spawns an Explore agent, then run `/switchyard explain`.
   Expected: `Last decision (sub-agent)`.
4. `/model` pause: pick Sonnet in `/model`.
   Expected: the band shows `⏸ switchyard paused (you picked …)`. If not, `classic.*` hooks are
   blocked by the built-in guard (spec risk 2). Note that in the README.
5. Ollama: `ollama pull clef-flash`, then run with `SWITCHYARD_SYSTEMONE_URL=http://localhost:11434 SWITCHYARD_SYSTEMONE_MODEL=clef-flash`.
   Expected: the band shows `⚡ switchyard ready` after the probe. If it shows `incompatible`, record
   the detail. That confirms or refutes spec risk 3.
6. Latency: send 20 ordinary prompts per backend, then run `/switchyard stats`. Record the p50/p95
   decision latency per backend in the README under a "Measured" heading.

### 8.3 Commit and finish

commit-sscc, branch complete (steps 1–9). Message: `docs: README and live verification results`.
```
