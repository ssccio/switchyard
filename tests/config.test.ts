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
  expect(resolveSettings({ JEV_API_KEY: 'k', SWITCHYARD_TIMEOUT_MS: '-5' }, { timeout_ms: -1 }).backend?.timeoutMs).toBe(3000)
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
