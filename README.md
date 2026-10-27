# switchyard

![switchyard: every turn switched onto the right track](assets/hero.jpg)

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
| min_confidence | `SWITCHYARD_MIN_CONFIDENCE` | 0.3 TypeSafe, none otherwise |
| baseline | `SWITCHYARD_BASELINE` | `usual` |
| — | `SWITCHYARD_DEBUG` | off; `1` logs routing to the transcript, a path also appends to that file |
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

## Develop

    claude plugin test
    claude plugin validate . --strict

## Measured (2026-10-27, Apple Silicon, switchyard's own request)

| | TypeSafe `jev-latest` | Ollama `clef-flash` |
| --- | --- | --- |
| Cold first call | 341 ms | 5.1 s (model load) |
| Warm call, new prompt | 113–176 ms | 508 ms |
| "rename x to count" | Haiku, confidence 0.95–0.97 | Haiku, confidence 0.31 |
| "find why sessions drop under load" | — | Opus, confidence 0.41 |

clef-flash reports much lower confidence than Jev for the same choice. The policy's 0.3
low-confidence threshold was tuned on Jev, so with clef it sits right at the edge.

Also verified live: a `claude -p` turn on an Opus 5.5 session was answered by `claude-haiku-5-5`
with the mod loaded, so `turn.step` accepts exact model ids.

## Limits

- Savings price the same token counts at the baseline model, so they are an estimate. "Net"
  subtracts the cache rebuilds that switching models caused.
- A mod can't see an agent definition's own model, so a routed sub-agent's baseline is its parent's model.
- Organization policy (`allowManagedHooksOnly`, `disableSideloadFlags`) can disable mods. On a Team
  or Enterprise login, the `/model` auto-pause may not fire; use `/switchyard off`.
