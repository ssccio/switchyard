import type { Register } from 'claude-code'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'switchyard', description: 'Model routing: on, off, stats, explain', argumentHint: '[on|off|stats|explain]', immediate: true })
    return next(e)
  })
}
