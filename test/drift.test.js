/**
 * Startup drift notice (design choice A: report, never write).
 *
 * dsh-fleet has no watcher, so a manifest edit reaches a profile only through
 * `apply`. On startup the plugin plans once, logs a warning and writes a TUI
 * footer cell when the profile is behind — but it must never touch a file, and
 * it must stay silent when the manifest is in sync or the check is switched off.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { apply } from '../index.js'
import { hashEntries } from '../lib/render.js'
import { driftBadge, summarizeDrift } from '../lib/drift.js'
import { makeHome, makeProfile, writeTextFile } from './helpers.js'

const MANIFEST = `version: 1
profiles:
  - web
providers: []
bundles: []
items: []
`

/** Minimal context: profileContext, a captured tuiStatus, and real logging. */
function makeContext(home, { profile = 'web', status = true } = {}) {
  const record = { statusFields: [], warnings: [] }
  const ctx = {
    get(name) {
      if (name === 'profileContext') {
        return { home, name: profile, installAnchor: null, dir: join(home, 'profiles', profile) }
      }
      return undefined
    },
    inject(deps, callback) {
      if (deps.includes('tuiStatus') && status) {
        callback({
          effect: (fn) => fn(),
          tuiStatus: {
            setField: (key, text, options) => {
              record.statusFields.push({ key, text, options })
              return () => {}
            },
          },
        })
      }
    },
    effect: (fn) => fn(),
    on: () => () => {},
    emit: () => {},
    logger: { warn: (message) => record.warnings.push(message), info() {}, error() {} },
  }
  return { ctx, record }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('summarizeDrift counts pending changes, optionally for one profile', () => {
  const plan = {
    changes: [
      { profile: 'web', kind: 'patch' },
      { profile: 'web', kind: 'bundles' },
      { profile: 'desktop', kind: 'patch' },
    ],
  }
  assert.deepEqual(summarizeDrift(plan, 'web'), { pending: 2, byProfile: { web: 2 } })
  assert.deepEqual(summarizeDrift(plan), { pending: 3, byProfile: { web: 2, desktop: 1 } })
  assert.deepEqual(summarizeDrift(null), { pending: 0, byProfile: {} })
  assert.deepEqual(summarizeDrift({ changes: 'nope' }, 'web'), { pending: 0, byProfile: {} })
})

test('driftBadge hides an in-sync plan', () => {
  assert.equal(driftBadge({ pending: 0 }), undefined)
  assert.equal(driftBadge(undefined), undefined)
  assert.equal(driftBadge({ pending: 3 }), 'fleet: 3 待应用')
})

test('a stale profile is reported on startup and nothing is written', async (t) => {
  process.env.DSH_FLEET_DRIFT_DELAY_MS = '10'
  t.after(() => {
    delete process.env.DSH_FLEET_DRIFT_DELAY_MS
  })

  const home = makeHome(t)
  writeTextFile(join(home, 'fleet.yml'), MANIFEST)
  makeProfile(home, 'web', { bundles: [] }) // no cordis.patch.yml -> managed block missing
  const { ctx, record } = makeContext(home)

  apply(ctx, { manifestPath: 'fleet.yml', notifyOnDrift: true })
  await wait(300)

  const badge = record.statusFields.find((entry) => entry.key === 'fleet' && entry.text !== undefined)
  assert.ok(badge, 'a footer badge is written')
  assert.match(badge.text, /^fleet: \d+ 待应用$/u)
  assert.equal(badge.options.tone, 'warning')
  assert.ok(record.warnings.some((line) => /待应用/u.test(line)), 'a warning line is logged')
  assert.equal(existsSync(join(home, 'profiles', 'web', 'cordis.patch.yml')), false, 'the check must not write')
})

test('an in-sync profile clears the badge instead of showing one', async (t) => {
  process.env.DSH_FLEET_DRIFT_DELAY_MS = '10'
  t.after(() => {
    delete process.env.DSH_FLEET_DRIFT_DELAY_MS
  })

  const home = makeHome(t)
  writeTextFile(join(home, 'fleet.yml'), MANIFEST)
  // A patch that already carries the (empty) managed block: nothing to apply.
  const emptyBlock = [
    `# >>> dsh-fleet v1 sha256:${hashEntries([])} —— generated from ~/.dsh/fleet.yml, do not edit`,
    '[]',
    '# <<< dsh-fleet',
    '',
  ].join('\n')
  makeProfile(home, 'web', { bundles: [], patchText: emptyBlock })
  const { ctx, record } = makeContext(home)

  apply(ctx, { manifestPath: 'fleet.yml', notifyOnDrift: true })
  await wait(300)

  assert.equal(record.warnings.length, 0, 'no warning for an in-sync profile')
  assert.ok(record.statusFields.some((entry) => entry.key === 'fleet' && entry.text === undefined), 'the badge is cleared')
})

test('notifyOnDrift false skips the check entirely', async (t) => {
  process.env.DSH_FLEET_DRIFT_DELAY_MS = '10'
  t.after(() => {
    delete process.env.DSH_FLEET_DRIFT_DELAY_MS
  })

  const home = makeHome(t)
  writeTextFile(join(home, 'fleet.yml'), MANIFEST)
  makeProfile(home, 'web', { bundles: [] })
  const { ctx, record } = makeContext(home)

  apply(ctx, { manifestPath: 'fleet.yml', notifyOnDrift: false })
  await wait(300)

  assert.equal(record.statusFields.length, 0)
  assert.equal(record.warnings.length, 0)
})

test('a composition without tuiStatus still checks and only logs', async (t) => {
  process.env.DSH_FLEET_DRIFT_DELAY_MS = '10'
  t.after(() => {
    delete process.env.DSH_FLEET_DRIFT_DELAY_MS
  })

  const home = makeHome(t)
  writeTextFile(join(home, 'fleet.yml'), MANIFEST)
  makeProfile(home, 'web', { bundles: [] })
  const { ctx, record } = makeContext(home, { status: false })

  assert.doesNotThrow(() => apply(ctx, { manifestPath: 'fleet.yml' }))
  await wait(300)
  assert.ok(record.warnings.some((line) => /待应用/u.test(line)))
})
