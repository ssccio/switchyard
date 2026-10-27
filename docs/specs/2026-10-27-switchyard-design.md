# switchyard — design

Date: 2026-10-27
Status: draft, awaiting approval

## Goal

Per-turn and per-sub-agent model routing for Claude Code, implemented entirely as a Claude Code
mod. A SystemOne decision model (TypeSafe Jev, or any server exposing `/v1/systemone`, such as
Ollama, llama.cpp, LM Studio) picks the cheapest sufficient model. Successor to `jev-router`
(Node proxy), which is used as the porting reference only.

Primary target workflow: Opus on the main thread, Haiku sub-agents. The biggest expected win is
routing sub-agents, which start from a fresh context and pay no prompt-cache penalty for a model
switch.

## Non-goals (v1)

- Codex or any CLI other than Claude Code.
- A proxy, a launcher binary, or edits to `~/.claude/settings.json`.
- Hosting a model in-process. "Local" means a local `/v1/systemone` server.
- A `/model` picker entry. Mods cannot add one; `/switchyard` replaces it.
- Windows-specific handling beyond what Claude Code mods give for free.

## Architecture

One plugin directory containing a TypeScript hooks module.

| Part | Responsibility |
| --- | --- |
| `prompt.submit` hook | Capture the typed prompt for the turn; detect explicit overrides (`use opus`, `use haiku`, ...) |
| `turn.step` hook | First step of a `turnId`: get a decision, apply policy, pin the result. Later steps reuse the pin. Rewrite `model` (and `effort` where the target tier does not support it). Record `result.usage`. |
| `agent.spawn` hook | Decide a sub-agent's model from its task text. A spawn that already names a model passes through. |
| `classic.PreModelSwitch` hook | User picked a concrete model in `/model`: pause routing for the session |
| Decision client | `$.http.fetch` POST to `<url>/v1/systemone` with optional Bearer key |
| Policy | Port of `jev-router/src/policy.mjs` |
| Stats | `$.store` aggregates; feeds the band and the stats pane |
| Commands | `/switchyard on`, `off`, `stats`, `explain` |

Routing is fail-open: any decision failure keeps the current model.

## Configuration

Each setting comes from plugin `userConfig` first (`/config`), then the environment.

| Setting | Env var | Default |
| --- | --- | --- |
| SystemOne base URL | `SWITCHYARD_SYSTEMONE_URL` | unset |
| SystemOne model | `SWITCHYARD_SYSTEMONE_MODEL` | required when the URL is set |
| Bearer key | `SWITCHYARD_SYSTEMONE_KEY` | none |
| Decision timeout | `SWITCHYARD_TIMEOUT_MS` | 3000 (TypeSafe), 15000 (custom URL) |
| Savings baseline | `SWITCHYARD_BASELINE` | `usual` |
| Allow Fable tier | `SWITCHYARD_ALLOW_FABLE` | off |
| Tier table | `userConfig` only | Haiku/Sonnet/Opus/Fable to current exact model ids |
| Price table | `userConfig` only | built-in list prices |

Backend selection:

1. `SWITCHYARD_SYSTEMONE_URL` set: use that server.
2. Else `JEV_API_KEY` or `TYPESAFE_API_KEY` set: use TypeSafe (`https://api.typesafe.ai`, Jev model).
3. Else routing is off; the band says why.

Bare `OLLAMA_*` variables are never read.

### Startup probe

On `session.start`, send one small SystemOne request. It verifies the response shape and warms a
local model. Include `keep_alive` when the server accepts it. Outcomes shown in the band:
`ready`, `incompatible` (bad status or unparseable answer), `unreachable`.

## Decision request

Same shape `jev-router` sends today: `state` = `{ request, session: { current_model,
context_tokens }, environment: { available_models } }`; `questions` = `task_complexity`,
`reasoning_required`, `tool_complexity` (score), and `model` (choice over the tier table's exact
ids, with the guidance text from `jev-router/src/config.mjs`). Plus the required `model` field
naming the decision model.

## Policy

Main thread, applied on the first step of each turn:

- An explicit override in the prompt wins.
- Error, timeout, or an unrecognised answer keeps the current model.
- Confidence below 0.3 never downgrades, and caps upgrades at Sonnet.
- No downgrade once context exceeds 20k tokens (prompt-cache rebuild costs more than it saves).
- An unavailable tier steps up to the nearest stronger one.
- Fable only with `SWITCHYARD_ALLOW_FABLE`.

Sub-agents, at `agent.spawn`: the same rules except the context-size rule, which does not apply.

Paused (`/switchyard off`, or a concrete `/model` pick): every hook passes through; stats still
record usage.

## Stats

Per step: model, `agentId`, decision latency, outcome (`routed`, `override`, `keep`, `timeout`,
`incompatible`), and `input`, `output`, `cache_read`, `cache_creation` tokens.

Savings: actual token counts priced at the baseline model, minus the cache-write cost of each
switch. Show gross and net.

Baselines: `usual` (the model you'd otherwise use: the session's `/model` for the main thread,
the spawn's requested model for sub-agents), `opus`, or an exact model id.

Storage: per-session and all-time totals in `$.store` (4 MiB cap; aggregates only), plus the last
20 decisions for explain.

### Display

- Band above the prompt, one line: `⚡ haiku · 280ms · saved $1.42 this session`, or the paused
  or failure state.
- `/switchyard stats` opens a docked pane: decision latency p50/p95, outcome counts, tokens per
  model, gross/net savings for the session and all-time.
- `/switchyard explain`: the last decision's request, answer, scores, and policy reason. Reads the
  stored record; never calls the backend again.

## Testing

- `claude plugin test` with `.test.ts` files that fire `prompt.submit`, `turn.step` and
  `agent.spawn` against a stubbed `$.http.fetch`.
- Port the cases in `jev-router/test/policy.test.mjs` and the turn-pinning cases in
  `jev-router/test/proxy.test.mjs`.
- One recorded response fixture per backend (TypeSafe, Ollama).

Manual gate before v1:
- A live call to TypeSafe.
- A live call to Ollama `clef-flash`, after re-pulling it (both local clef models currently
  return HTTP 400: format no longer supported).
- Record warm p50/p95 latency for each backend.

Minimum Claude Code version: v2.1.304.

## Risks to verify early

1. Which values `turn.step`/`agent.spawn` accept for `model`. Exact ids are assumed; check the
   types for the installed build.
2. `classic.*` hooks in a user-installed mod do not run where the built-in guard loads (managed
   settings, or a Team/Enterprise login). If the guard loads, a concrete `/model` pick can't
   pause routing automatically, and `/switchyard off` is the only way.
3. Ollama `/v1/systemone` schema parity with TypeSafe: unconfirmed until the live call.
4. Org policy (`allowManagedHooksOnly`, `disableSideloadFlags`) can disable the mod entirely.

## Later

- v2: in-process local model via a separate Rust `/v1/systemone` server, which the mod uses as a
  plain URL.
