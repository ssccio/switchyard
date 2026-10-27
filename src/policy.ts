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
    // Keeping the current model never switches, even to a tier the router may not pick itself.
    if (tier === current) return { tier, reason: `${reason}/no-change`, changed: false }
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
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling]!,'low-confidence-capped')
  }
  if (rankOf(target) < rankOf(current) && contextTokens > THRESHOLDS.downgradeMaxContextTokens) {
    return settle(current, 'downgrade-not-worth-cache-rebuild')
  }
  return settle(target, 'answer')
}
