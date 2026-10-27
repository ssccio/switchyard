// Runs every prompt in eval/prompts.json as its own fresh `claude -p` session with switchyard
// loaded against one decision backend, and records what the debug log and Claude Code report.
// Usage: node eval/run.mts <jev|clef-flash|clef> [promptId ...]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OLLAMA = 'http://localhost:11434'
const BACKENDS: Record<string, Record<string, string>> = {
  jev: { SWITCHYARD_SYSTEMONE_MODEL: 'jev-latest' },
  'clef-flash': { SWITCHYARD_SYSTEMONE_URL: OLLAMA, SWITCHYARD_SYSTEMONE_MODEL: 'clef-flash' },
  clef: { SWITCHYARD_SYSTEMONE_URL: OLLAMA, SWITCHYARD_SYSTEMONE_MODEL: 'clef' },
}
/** The session's own model, so the "usual" baseline is the Opus main thread. */
const SESSION_MODEL = 'claude-opus-5-5'

type Prompt = { id: string; expect: string; prompt: string }

const [backend, ...only] = process.argv.slice(2)
if (!backend || !BACKENDS[backend]) {
  console.error(`usage: node eval/run.mts <${Object.keys(BACKENDS).join('|')}> [promptId ...]`)
  process.exit(2)
}

const prompts = (JSON.parse(readFileSync(join(ROOT, 'eval/prompts.json'), 'utf8')) as Prompt[]).filter(
  (p) => only.length === 0 || only.includes(p.id),
)
const outDir = join(ROOT, 'eval/results', backend)
mkdirSync(outDir, { recursive: true })

// Inherit the shell's environment minus any switchyard settings, then apply this backend's.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SWITCHYARD_'))) as Record<string, string>

for (const p of prompts) {
  const log = join(outDir, `${p.id}.log`)
  if (existsSync(log)) rmSync(log)
  const started = Date.now()
  const run = spawnSync(
    'claude',
    ['-p', '--plugin-dir', ROOT, '--model', SESSION_MODEL, '--permission-mode', 'default', '--output-format', 'json', p.prompt],
    {
      cwd: ROOT,
      env: { ...baseEnv, ...BACKENDS[backend], SWITCHYARD_DEBUG: log },
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  let result: any = null
  try {
    result = JSON.parse(run.stdout)
  } catch {
    // Kept as null; stderr below says why.
  }
  // Saved plugin options outrank env vars, so check which decision model the log shows was used.
  const seen = existsSync(log) ? /systemone \S+ model=(\S+)/.exec(readFileSync(log, 'utf8'))?.[1] : undefined
  const backendOk = seen === BACKENDS[backend]!.SWITCHYARD_SYSTEMONE_MODEL
  writeFileSync(
    join(outDir, `${p.id}.json`),
    JSON.stringify({ ...p, backend, backendSeen: seen, backendOk, wallMs: Date.now() - started, exitCode: run.status, stderr: run.stderr?.slice(0, 2000), result }, null, 2),
  )
  const answered = result?.modelUsage ? Object.keys(result.modelUsage).join(', ') : 'no result'
  console.log(`${backend} ${p.id}: exit ${run.status}, ${Date.now() - started}ms, answered by ${answered}${backendOk ? '' : `, WRONG BACKEND (${seen ?? 'none'})`}`)
}
