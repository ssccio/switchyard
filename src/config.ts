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
  const positive = (value: unknown) => (Number(value) > 0 ? Number(value) : 0)
  const timeout = Math.min(positive(options.timeout_ms) || positive(env.SWITCHYARD_TIMEOUT_MS), THRESHOLDS.maxTimeoutMs)
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
