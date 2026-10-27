import { expect, test } from 'claude-code/testing'

test('registers /switchyard at session start', async ($, on) => {
  const names: string[] = []
  on('command.register', ($, e) => {
    names.push(e.name)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(names).toEqual(['switchyard'])
})
