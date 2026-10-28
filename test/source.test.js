/**
 * Source-side row reading: volatile unwrapping, `!!js` detection, both dump
 * shapes, and the runtime/CLI fallback. The CLI is always a stub here — these
 * tests must never spawn dsh or read a real profile.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  autoSkipReason,
  containsJsExpression,
  plainValue,
  readSourceRows,
  rowsFromConfiguration,
  rowsFromDump,
} from '../lib/source.js'

const DUMP_TEXT = [
  '# == cordis.patch.yml',
  '- id: llm-pi-ai',
  '  name: models',
  '  config:',
  '    baseURL: https://api.example.test/v1',
  '    models:',
  '      - id: fast',
  '        contextWindow: 128000',
  '- id: tools',
  '  config:',
  '    enabled: true',
  '- id: bare',
  '- name: missing-id',
  '  config:',
  '    ignored: true',
  '',
].join('\n')

/** A Cordis-like context exposing one configEditor service. */
function ctxWith(configuration) {
  return {
    get(name) {
      return name === 'configEditor' ? { configuration: () => configuration } : undefined
    },
  }
}

test('containsJsExpression finds top-level and nested expression nodes', () => {
  assert.equal(containsJsExpression(undefined), false)
  assert.equal(containsJsExpression(null), false)
  assert.equal(containsJsExpression('!!js 1 + 1'), false)
  assert.equal(containsJsExpression({ model: 'fast' }), false)
  assert.equal(containsJsExpression({ __jsExpr: 'process.env.TOKEN' }), true)
  assert.equal(
    containsJsExpression({ providers: { openai: { apiKey: { __jsExpr: 'process.env.OPENAI_KEY' } } } }),
    true,
  )
  assert.equal(containsJsExpression([{ disabled: false }, [{ nested: { __jsExpr: 'Date.now()' } }]]), true)
})

test('containsJsExpression visits a cyclic config without recursing forever', () => {
  const cyclic = { name: 'loop' }
  cyclic.self = cyclic
  assert.equal(containsJsExpression(cyclic), false)
})

test('plainValue unwraps volatile wrappers and detaches the data', () => {
  assert.equal(plainValue({ get: () => true }), true)
  assert.equal(plainValue(42), 42)
  assert.equal(plainValue(undefined), undefined)
  assert.deepEqual(plainValue({ a: undefined, b: () => 1, c: 2 }), { c: 2 })
  // A prototype get() (Map, Headers, …) is not a volatile wrapper.
  assert.deepEqual(plainValue(new Map([['token', 'secret']])), {})

  const snapshot = { token: 'secret' }
  const source = {
    auth: { get: () => snapshot },
    nested: { get: () => ({ flag: { get: () => true } }) },
    list: [1, { get: () => 'two' }],
  }
  const plain = plainValue(source)
  assert.deepEqual(plain, {
    auth: { token: 'secret' },
    nested: { flag: true },
    list: [1, 'two'],
  })

  // A clone, not an alias: editing it must not reach the live config snapshot.
  plain.auth.token = 'changed'
  assert.equal(snapshot.token, 'secret')
})

test('plainValue keeps cyclic config finite', () => {
  const cyclic = { name: 'loop' }
  cyclic.self = cyclic
  assert.deepEqual(plainValue(cyclic), { name: 'loop' })
})

test('rowsFromConfiguration prefers the runtime config and falls back to layers', () => {
  const snapshot = { models: [{ id: 'fast' }] }
  const configuration = [
    {
      entry: { options: { id: 'llm-pi-ai', name: 'models' }, fiber: { config: { get: () => snapshot } } },
      inherited: { ignored: 'runtime config wins' },
      override: { ignored: 'runtime config wins' },
    },
    {
      entry: { options: { id: '  tools  ' } },
      inherited: { enabled: true, provider: 'inherited' },
      override: { provider: 'override' },
    },
    {
      entry: { options: { id: 'empty' }, fiber: { config: {} } },
      inherited: { dropped: true },
      override: { dropped: true },
    },
    { entry: { options: { name: 'no-id' } }, inherited: { a: 1 }, override: {} },
    null,
  ]

  const rows = rowsFromConfiguration(configuration)
  assert.deepEqual([...rows.keys()], ['llm-pi-ai', 'tools', 'empty'])
  assert.deepEqual(rows.get('llm-pi-ai'), {
    id: 'llm-pi-ai',
    name: 'models',
    config: { models: [{ id: 'fast' }] },
  })
  assert.deepEqual(rows.get('tools'), {
    id: 'tools',
    config: { enabled: true, provider: 'override' },
  })
  assert.deepEqual(rows.get('empty'), { id: 'empty', config: {} })
})

test('rowsFromConfiguration ignores non-list input', () => {
  assert.equal(rowsFromConfiguration(undefined).size, 0)
  assert.equal(rowsFromConfiguration(null).size, 0)
  assert.equal(rowsFromConfiguration({ entry: { options: { id: 'web' } } }).size, 0)
})

test('rowsFromDump reads a CLI dump list', () => {
  const rows = rowsFromDump(DUMP_TEXT)
  assert.deepEqual([...rows.keys()], ['llm-pi-ai', 'tools', 'bare'])
  assert.deepEqual(rows.get('llm-pi-ai'), {
    id: 'llm-pi-ai',
    name: 'models',
    config: {
      baseURL: 'https://api.example.test/v1',
      models: [{ id: 'fast', contextWindow: 128000 }],
    },
  })
  assert.deepEqual(rows.get('tools'), { id: 'tools', config: { enabled: true } })
  assert.deepEqual(rows.get('bare'), { id: 'bare', config: {} })
})

test('rowsFromDump yields an empty map for empty, invalid or non-list dumps', () => {
  assert.equal(rowsFromDump(undefined).size, 0)
  assert.equal(rowsFromDump('').size, 0)
  assert.equal(rowsFromDump('# only comments\n').size, 0)
  assert.equal(rowsFromDump('id: not-a-list\n').size, 0)
  assert.equal(rowsFromDump('- id: [unclosed\n').size, 0)
})

test('readSourceRows prefers the runtime configEditor', async () => {
  let dumps = 0
  const result = await readSourceRows({
    ctx: ctxWith([
      {
        entry: { options: { id: 'llm-pi-ai', name: 'models' }, fiber: { config: { models: [{ id: 'fast' }] } } },
        inherited: { ignored: true },
        override: { ignored: true },
      },
    ]),
    env: { currentProfile: 'web', dshCommand: 'dsh' },
    dump: async () => {
      dumps += 1
      return { ok: true, text: DUMP_TEXT, error: null }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.backend, 'runtime')
  assert.equal(result.error, null)
  assert.deepEqual([...result.rows.keys()], ['llm-pi-ai'])
  assert.equal(dumps, 0)
})

test('readSourceRows falls back to the CLI with an injected dump', async () => {
  const calls = []
  const result = await readSourceRows({
    ctx: ctxWith([]),
    env: { currentProfile: 'web', dshCommand: 'env-dsh' },
    dshBin: '/opt/dsh',
    dump: async (options) => {
      calls.push(options)
      return { ok: true, text: DUMP_TEXT, error: null }
    },
  })
  assert.deepEqual(calls, [{ dshBin: '/opt/dsh', profile: 'web' }])
  assert.equal(result.ok, true)
  assert.equal(result.backend, 'cli')
  assert.equal(result.error, null)
  assert.deepEqual([...result.rows.keys()], ['llm-pi-ai', 'tools', 'bare'])
})

test('readSourceRows falls back to the CLI when configEditor throws', async () => {
  const ctx = {
    get(name) {
      if (name !== 'configEditor') return undefined
      return {
        configuration() {
          throw new Error('service is down')
        },
      }
    },
  }
  const result = await readSourceRows({
    ctx,
    env: { currentProfile: 'web', dshCommand: 'dsh' },
    dump: async () => ({ ok: true, text: '- id: web\n', error: null }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.backend, 'cli')
  assert.deepEqual([...result.rows.keys()], ['web'])
})

test('readSourceRows reports a failing CLI dump', async () => {
  const failed = await readSourceRows({
    env: { currentProfile: 'web', dshCommand: 'dsh' },
    dump: async () => ({ ok: false, text: '', error: 'dsh --dump-config printed nothing' }),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.backend, 'cli')
  assert.equal(failed.rows.size, 0)
  assert.match(failed.error, /printed nothing/)

  const thrown = await readSourceRows({
    env: { currentProfile: 'web', dshCommand: 'dsh' },
    dump: async () => {
      throw new Error('spawn EACCES')
    },
  })
  assert.equal(thrown.ok, false)
  assert.equal(thrown.backend, 'cli')
  assert.equal(thrown.rows.size, 0)
  assert.match(thrown.error, /spawn EACCES/)
})

test('readSourceRows explains why neither backend can run', async () => {
  const neither = await readSourceRows()
  assert.equal(neither.ok, false)
  assert.equal(neither.backend, null)
  assert.equal(neither.rows.size, 0)
  assert.match(neither.error, /configEditor service is unavailable/)
  assert.match(neither.error, /env\.currentProfile/)
  assert.match(neither.error, /dshBin or env\.dshCommand/)

  const noProfile = await readSourceRows({ env: { dshCommand: 'dsh' } })
  assert.equal(noProfile.ok, false)
  assert.equal(noProfile.backend, null)
  assert.match(noProfile.error, /env\.currentProfile/)
  assert.doesNotMatch(noProfile.error, /dshBin or env\.dshCommand/)

  const noCli = await readSourceRows({ env: { currentProfile: 'web' } })
  assert.equal(noCli.ok, false)
  assert.equal(noCli.backend, null)
  assert.doesNotMatch(noCli.error, /env\.currentProfile/)
  assert.match(noCli.error, /dshBin or env\.dshCommand/)

  const emptyRuntime = await readSourceRows({ ctx: ctxWith([]), env: {} })
  assert.equal(emptyRuntime.ok, false)
  assert.equal(emptyRuntime.backend, null)
  assert.match(emptyRuntime.error, /returned no configuration rows/)

  const thrower = {
    get(name) {
      if (name !== 'configEditor') return undefined
      return {
        configuration() {
          throw new Error('service is down')
        },
      }
    },
  }
  const failedRuntime = await readSourceRows({ ctx: thrower })
  assert.equal(failedRuntime.ok, false)
  assert.equal(failedRuntime.backend, null)
  assert.match(failedRuntime.error, /configEditor service failed \(service is down\)/)
})

test('autoSkipReason names every reason a row must not sync', () => {
  assert.equal(autoSkipReason({ id: 'web', config: {} }, { selfId: 'web' }), 'self')
  assert.equal(autoSkipReason({ id: ' web ', config: {} }, { selfId: 'web' }), 'self')
  assert.equal(
    autoSkipReason({ id: 'web', config: { token: { __jsExpr: 'process.env.TOKEN' } } }),
    'js-expression',
  )
  assert.equal(autoSkipReason({ id: 'tools', config: { token: { __jsExpr: 'process.env.TOKEN' } } }), 'js-expression')
  assert.equal(autoSkipReason({ config: {} }), 'no-id')
  assert.equal(autoSkipReason({ id: '  ', config: {} }), 'no-id')
  assert.equal(autoSkipReason(null), 'no-id')

  assert.equal(autoSkipReason({ id: 'tools', config: {} }), undefined)
  assert.equal(autoSkipReason({ id: 'tools', config: {} }, { selfId: 'web' }), undefined)

  // A missing selfId must never match an id-less row.
  assert.equal(autoSkipReason({ config: {} }, { selfId: '' }), 'no-id')
  // self wins over an expression, which wins over a missing id.
  assert.equal(
    autoSkipReason({ id: 'web', config: { token: { __jsExpr: '1' } } }, { selfId: 'web' }),
    'self',
  )
})
