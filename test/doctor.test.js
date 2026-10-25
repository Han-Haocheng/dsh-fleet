import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { doctorReport } from '../lib/doctor.js'
import { makeHome, writeTextFile } from './helpers.js'

function baseInput(home, overrides = {}) {
  return {
    home,
    manifestPath: join(home, 'fleet.yml'),
    currentProfile: 'web',
    knownProfiles: ['web'],
    states: new Map([['web', { name: 'web', present: true }]]),
    manifestErrors: [],
    plan: { pendingInstalls: [] },
    backups: [],
    unmanaged: [],
    lock: { held: false, owner: null },
    capability: () => 'cli',
    ...overrides,
  }
}

test('doctorReport is clean for a healthy home', async (t) => {
  const home = makeHome(t)
  const report = await doctorReport(baseInput(home))
  assert.equal(report.ok, true)
  assert.ok(report.checks.some((check) => check.level === 'ok' && check.title === 'manifest'))
  assert.ok(report.checks.every((check) => check.level !== 'error'))
})

test('doctorReport flags the home patch layer, a stale lock and a missing profile', async (t) => {
  const home = makeHome(t)
  writeTextFile(join(home, 'cordis.patch.yml'), '- insert: []\n')
  const report = await doctorReport(
    baseInput(home, {
      knownProfiles: ['web', 'desktop'],
      states: new Map([
        ['web', { name: 'web', present: true }],
        ['desktop', { name: 'desktop', present: false }],
      ]),
      lock: { held: true, owner: 'dsh-fleet:apply:web' },
      plan: {
        pendingInstalls: [{ profile: 'web', bundle: 'dsh-mnemon', spec: 'dsh-mnemon@1.1.0', from: '1.0.0', outdated: true }],
      },
    }),
  )
  assert.equal(report.ok, false)
  const titles = report.checks.map((check) => check.title)
  for (const title of ['home patch layer', 'write lock', 'profile desktop', 'versions']) {
    assert.ok(titles.includes(title), `missing check: ${title}`)
  }
  assert.ok(report.checks.some((check) => check.level === 'error' && check.title === 'profile desktop'))
})
