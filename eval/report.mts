// Compares eval runs across backends: decisions, latency, the model that answered, and cost.
// Usage: node eval/report.mts  (reads eval/results/<backend>/, writes eval/results/report.md)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = join(ROOT, 'eval/results')
const ORDER = ['jev', 'clef-flash', 'clef']
const PROBE = 'rename a variable'

type Prompt = { id: string; expect: string; prompt: string }
type Decision = { outcome: string; ms: number; choice?: string; confidence?: number; for: string }
type Row = {
  decisions: Decision[]
  mainSent?: string
  spawns: string[]
  answeredBy: string[]
  costUsd?: number
  wallMs: number
  ok: boolean
}

const DECISION = /systemone \S+ model=\S+ keep_alive=\S+ → (\w+) (\d+)ms (?:choice=(\S+) confidence=([\d.]+) )?.*for "(.*)"$/
const MAIN_STEP = /turn\.step main #0: asked \S+, sent (\S+),/
const SPAWN = /agent\.spawn (.*)$/
const tier = (model?: string) => ['haiku', 'sonnet', 'opus', 'fable'].find((t) => model?.includes(t)) ?? model ?? '-'

function load(backend: string, p: Prompt): Row | null {
  const json = join(RESULTS, backend, `${p.id}.json`)
  if (!existsSync(json)) return null
  const run = JSON.parse(readFileSync(json, 'utf8'))
  const logFile = join(RESULTS, backend, `${p.id}.log`)
  const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n') : []
  const decisions: Decision[] = []
  let mainSent: string | undefined
  const spawns: string[] = []
  for (const line of lines) {
    const d = DECISION.exec(line)
    if (d && d[5] !== PROBE) {
      decisions.push({ outcome: d[1]!, ms: Number(d[2]), choice: d[3], confidence: d[4] ? Number(d[4]) : undefined, for: d[5]! })
    }
    const m = MAIN_STEP.exec(line)
    if (m && !mainSent) mainSent = m[1]
    const s = SPAWN.exec(line)
    if (s) spawns.push(s[1]!)
  }
  return {
    decisions,
    mainSent,
    spawns,
    answeredBy: run.result?.modelUsage ? Object.keys(run.result.modelUsage) : [],
    costUsd: run.result?.total_cost_usd,
    wallMs: run.wallMs,
    ok: run.exitCode === 0 && run.result?.is_error === false && run.backendOk !== false,
  }
}

const percentile = (xs: number[], p: number) => {
  if (!xs.length) return '-'
  const s = [...xs].sort((a, b) => a - b)
  return `${s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]}`
}

const prompts = JSON.parse(readFileSync(join(ROOT, 'eval/prompts.json'), 'utf8')) as Prompt[]
const backends = ORDER.filter((b) => existsSync(join(RESULTS, b)) && readdirSync(join(RESULTS, b)).some((f) => f.endsWith('.json')))
const rows = new Map(backends.map((b) => [b, new Map(prompts.map((p) => [p.id, load(b, p)]))]))

const out: string[] = ['# switchyard eval', '', `Backends: ${backends.join(', ')}. Session model: Opus 5.5. One fresh \`claude -p\` session per prompt.`, '']

// Summary per backend
out.push('## Summary', '', '| Backend | Runs ok | Main tier matches expected | Decision ms p50 / p95 | Decisions blocked by low confidence | Total cost |', '| --- | --- | --- | --- | --- | --- |')
for (const b of backends) {
  const rs = prompts.map((p) => [p, rows.get(b)!.get(p.id)] as const).filter(([, r]) => r)
  const ms = rs.flatMap(([, r]) => r!.decisions.filter((d) => d.outcome === 'ok').map((d) => d.ms))
  const matches = rs.filter(([p, r]) => r!.ok && tier(r!.mainSent) === p.expect).length
  const blocked = rs.flatMap(([, r]) => r!.spawns).filter((s) => s.includes('low-confidence')).length
  const cost = rs.reduce((sum, [, r]) => sum + (r!.costUsd ?? 0), 0)
  out.push(`| ${b} | ${rs.filter(([, r]) => r!.ok).length}/${rs.length} | ${matches}/${rs.length} | ${percentile(ms, 50)} / ${percentile(ms, 95)} | ${blocked} spawn(s) | $${cost.toFixed(2)} |`)
}
out.push('', 'Low-confidence blocks on the main thread show up as a main tier of opus where the expected tier is lower.', '')

// Per prompt
out.push('## Per prompt', '', `| Prompt | Expected | ${backends.map((b) => `${b}: choice (conf, ms) → ran`).join(' | ')} |`, `| --- | --- | ${backends.map(() => '---').join(' | ')} |`)
for (const p of prompts) {
  const cells = backends.map((b) => {
    const r = rows.get(b)!.get(p.id)
    if (!r) return 'not run'
    const first = r.decisions[0]
    const choice = first ? (first.outcome === 'ok' ? `${tier(first.choice)} (${first.confidence?.toFixed(2)}, ${first.ms})` : `${first.outcome} (${first.ms})`) : 'no call'
    return `${choice} → ${tier(r.mainSent)}${r.ok ? '' : ' ✗'}`
  })
  out.push(`| ${p.id} | ${p.expect} | ${cells.join(' | ')} |`)
}

// Sub-agents
out.push('', '## Sub-agent spawns', '')
for (const p of prompts) {
  for (const b of backends) {
    const r = rows.get(b)!.get(p.id)
    for (const s of r?.spawns ?? []) out.push(`- ${p.id} · ${b}: ${s}`)
  }
}

writeFileSync(join(RESULTS, 'report.md'), out.join('\n') + '\n')
console.log(out.join('\n'))
