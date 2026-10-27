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
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null
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
