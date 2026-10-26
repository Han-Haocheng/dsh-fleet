/**
 * The Harness snapshots every agent-tool result with `snapshotJsonValue` and
 * throws `ToolOutputError: value is not lossless JSON` as soon as one object
 * property is `undefined` (JSON.stringify would drop the key, so the round trip
 * differs). Status payloads used to carry several such keys, which made
 * `fleet(action="status")` fail in every front end, TUI included.
 *
 * These tests pin the tool boundary: whatever an action returns, the value the
 * tool hands back must survive a JSON round trip unchanged.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { apply } from '../index.js'
import { stripUndefinedJson } from '../lib/util.js'
import { makeHome, makeProfile, writeTextFile } from './helpers.js'

const MANIFEST = `version: 1
profiles:
  - web
  - dsh-tui
providers:
  - key: p1
    scope:
      - all
    config:
      apiKeyEnv: P1_KEY
bundles:
  - name: b1
    spec: b1@1.0.0
    scope:
      - all
items:
  - id: row1
    name: pkg-row1
    scope:
      - all
    config:
      a: 1
`

const ROW_PATCH = '- id: row1\n  name: pkg-row1\n  config:\n    a: 1\n'

/** Register the tool against a stub context; `fleet` has no hard injects. */
function registerTool(home, profileName, profileDir) {
  const tools = []
  const ctx = {
    get(name) {
      if (name === 'profileContext') {
        return { home, name: profileName, installAnchor: null, dir: profileDir }
      }
      return undefined
    },
    inject(deps, callback) {
      if (!deps.includes('tools')) return
      callback({
        effect: (fn) => fn(),
        tools: { register: (definition) => tools.push(definition) },
      })
    },
    effect: (fn) => fn(),
    on: () => () => {},
    emit: () => {},
    logger: { warn() {} },
  }
  apply(ctx, { manifestPath: 'fleet.yml' })
  assert.equal(tools.length, 1, 'the fleet tool must register')
  return tools[0]
}

/** Build a home with a realistic-enough manifest and two present profiles. */
function makeFixture(t) {
  const home = makeHome(t)
  writeTextFile(join(home, 'fleet.yml'), MANIFEST)
  const b1 = { version: '1.0.0', patch: '- insert:\n    - id: b1-row\n' }
  for (const profile of ['web', 'dsh-tui']) {
    makeProfile(home, profile, {
      bundles: ['b1'],
      dependencies: { b1: '1.0.0' },
      packages: { b1 },
      patchText: ROW_PATCH,
    })
  }
  return { home, tool: registerTool(home, 'dsh-tui', join(home, 'profiles', 'dsh-tui')) }
}

/** Every place a `undefined` would be dropped by JSON.stringify. */
function undefinedPaths(value, path = '$', found = []) {
  if (value === undefined) {
    found.push(path)
    return found
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => undefinedPaths(entry, `${path}[${index}]`, found))
    return found
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) undefinedPaths(entry, `${path}.${key}`, found)
  }
  return found
}

/** Mirror the Harness rule: no undefined, and a JSON round trip must not change the value. */
function assertLossless(value, label) {
  assert.deepEqual(undefinedPaths(value), [], `${label}: payload still carries undefined properties`)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: JSON round trip changed the value`)
}

test('stripUndefinedJson drops absent keys, keeps null, and fixes array holes', () => {
  const date = new Date('2026-10-25T00:00:00.000Z')
  const cleaned = stripUndefinedJson({
    keep: 0,
    empty: null,
    gone: undefined,
    nested: { gone: undefined, keep: [] },
    list: [undefined, 1, { gone: undefined, keep: 'x' }],
    stamp: date,
  })
  assert.deepEqual(cleaned, {
    keep: 0,
    empty: null,
    nested: { keep: [] },
    list: [null, 1, { keep: 'x' }],
    stamp: '2026-10-25T00:00:00.000Z',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(cleaned)), cleaned)
})

test('status output survives the tool boundary', async (t) => {
  const { tool } = makeFixture(t)
  const value = await tool.execute({ action: 'status' })

  assertLossless(value, 'status')
  assert.equal(value.currentProfile, 'dsh-tui')

  const bundle = value.items.find((item) => item.kind === 'bundle')
  assert.ok(bundle, 'the bundle entry is present')
  // entryDetails() used to emit these as undefined ("absent"), which is what
  // made the whole payload non-lossless.
  assert.equal('provides' in bundle.details, false)
  assert.equal('prune' in bundle.details, false)

  const configItem = value.items.find((item) => item.kind === 'item')
  assert.ok(configItem, 'the config-row entry is present')
  assert.equal('title' in configItem, false, 'an unset title is dropped, not undefined')
})

test('plan, doctor and a dry-run apply also survive the tool boundary', async (t) => {
  const { tool } = makeFixture(t)

  assertLossless(await tool.execute({ action: 'plan' }), 'plan')
  assertLossless(await tool.execute({ action: 'doctor' }), 'doctor')
  assertLossless(
    await tool.execute({ action: 'apply', dryRun: true, profiles: ['dsh-tui'] }),
    'apply(dryRun)',
  )
})

test('unknown actions keep their error shape', async (t) => {
  const { tool } = makeFixture(t)
  const value = await tool.execute({ action: 'nope' })
  assert.equal(value.ok, false)
  assert.match(value.errors[0], /unknown action/)
  assertLossless(value, 'unknown action')
})
