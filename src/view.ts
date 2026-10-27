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
