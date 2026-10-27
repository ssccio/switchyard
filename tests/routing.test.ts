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
  expect(w.requests[1]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(w.requests[1]!.headers.authorization).toBe('Bearer test-key')
  expect(w.requests[1]!.body.model).toBe('jev-latest')
  expect(w.requests[1]!.body.state.request).toBe('rename the variable x to count')
})

test('an injected message that starts a turn is not routed on', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, '<agent-message>hand-back from a sub-agent</agent-message>', 'peer')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(w.models).toEqual(['claude-opus-5-5'])
  // Only the startup probe reached the decision server
  expect(w.requests.length).toBe(1)
})

test('a notification does not use up the pending user prompt', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, 'rename x')
  await prompt($, 'build finished', 'task-notification')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(w.requests[1]!.body.state.request).toBe('rename x')
  expect(w.models).toEqual(['claude-haiku-5-5'])
})

test('claude -p prompts are routed', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, 'rename x', 'sdk')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(w.models).toEqual(['claude-haiku-5-5'])
})

test('debug mode logs where requests go, and stays silent otherwise', async ($, on) => {
  const w = world(on, { env: { JEV_API_KEY: 'test-key', SWITCHYARD_DEBUG: '1' } })
  await start($, w.clock)
  await prompt($, 'rename x')
  await prompt($, 'hand-back', 'peer')
  expect(w.logs.some((l) => /systemone https:\/\/api\.typesafe\.ai\/v1\/systemone model=jev-latest .* ok /.test(l))).toBe(true)
  expect(w.logs.some((l) => /prompt\.submit origin=composer idle will route: rename x/.test(l))).toBe(true)
  expect(w.logs.some((l) => /prompt\.submit origin=peer idle not routed/.test(l))).toBe(true)
})

test('without SWITCHYARD_DEBUG nothing is logged', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await prompt($, 'rename x')
  expect(w.logs).toEqual([])
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

test('turns send keep_alive once the local server has accepted it', async ($, on) => {
  const w = world(on, { env: { SWITCHYARD_SYSTEMONE_URL: 'http://localhost:11434', SWITCHYARD_SYSTEMONE_MODEL: 'clef-flash' } })
  await start($, w.clock)
  await prompt($, 'rename x')
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(w.requests[0]!.body.keep_alive).toBe('30m')
  expect(w.requests[1]!.body.keep_alive).toBe('30m')
})

test('an incompatible local server is reported at startup, and keep_alive is dropped on retry', async ($, on) => {
  const bad = { status: 400, text: '{"error":"format no longer supported"}' }
  const w = world(on, {
    env: { SWITCHYARD_SYSTEMONE_URL: 'http://localhost:11434', SWITCHYARD_SYSTEMONE_MODEL: 'clef-flash' },
    replies: [bad, bad],
  })
  await start($, w.clock)
  expect(w.requests[0]!.url).toBe('http://localhost:11434/v1/systemone')
  expect(w.requests[0]!.body.model).toBe('clef-flash')
  expect(w.requests[0]!.body.keep_alive).toBe('30m')
  expect(w.requests[1]!.body.keep_alive).toBe(undefined)
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
  expect(w.requests[1]!.body.state.request).toBe('find every caller of parse() and list them')
})

test('an Explore spawn keeps its own cheap model and asks nothing', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  await spawn($, { subagentType: 'Explore' })
  expect(w.spawns).toEqual([undefined])
  expect(w.requests.length).toBe(1)
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
