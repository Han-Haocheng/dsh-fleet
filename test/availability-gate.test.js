/**
 * Availability gate: a profile's `package.json` only lists what that profile
 * declares itself. DSH core packages live in the installation tree, so the gate
 * must resolve through the install anchor before it calls a row's package
 * missing — otherwise every core row (agent-default-model, permission, web…)
 * would be withheld from a sync.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { prepareSync } from '../lib/sync-run.js'
import { makeHome, makeInstallation, makeProfile, writeTextFile } from './helpers.js'

const CORE = '@deepseek-ai/dsh-agent-default-model'

function makeContext(home, configuration) {
  return {
    get(name) {
      if (name === 'profileContext') {
        return { home, name: 'web', installAnchor: null, dir: join(home, 'profiles', 'web') }
      }
      if (name === 'configEditor') return { configuration: async () => configuration }
      return undefined
    },
    inject() {},
    effect: (fn) => fn(),
    on: () => () => {},
    emit: () => {},
    logger: { warn() {} },
  }
}

function rowOf(id, name, config) {
  return {
    entry: { options: { id, name }, fiber: { config } },
    inherited: {},
    override: {},
  }
}

function makeFixture(t, { installCore = true } = {}) {
  const home = makeHome(t)
  makeProfile(home, 'web', { bundles: [] })
  makeProfile(home, 'desktop', { bundles: [] })
  const install = makeInstallation(t, installCore ? { [CORE]: { version: '1.0.0' } } : {})
  const manifest = {
    version: 1,
    profiles: ['web', 'desktop'],
    sync: { enabled: true, targets: ['desktop'] },
    providers: [],
    bundles: [],
    items: [],
  }
  const states = new Map(
    ['web', 'desktop'].map((profile) => [
      profile,
      {
        name: profile,
        present: true,
        dir: join(home, 'profiles', profile),
        // Neither profile declares the core package itself.
        installed: new Set(['dsh-fleet']),
        versions: new Map([['dsh-fleet', '0.1.2']]),
        bundles: [],
        rowIds: new Set(),
      },
    ]),
  )
  return { home, install, manifest, states }
}

async function run(t, fixture, { installAnchor }) {
  const ctx = makeContext(fixture.home, [rowOf('agent-default-model', CORE, { provider: 'go', model: 'm1' })])
  return prepareSync({
    ctx,
    env: { home: fixture.home, currentProfile: 'web', installAnchor },
    manifest: fixture.manifest,
    knownProfiles: ['web', 'desktop'],
    states: fixture.states,
    dshBin: '/fake/dsh',
    allowedRowIds: ['agent-default-model'],
    dumpTarget: async () => ({
      ok: true,
      text: '- id: agent-default-model\n  config:\n    provider: go\n    model: old\n',
      error: null,
    }),
  })
}

test('a core package resolved from the install anchor is not plugin-missing', async (t) => {
  const fixture = makeFixture(t)
  const prepared = await run(t, fixture, { installAnchor: fixture.install })
  const row = prepared.plan.rows.find((entry) => entry.id === 'agent-default-model')
  assert.equal(row.action, 'push')
  assert.equal(row.skippedTargets, undefined, 'no target is withheld')
  assert.deepEqual(row.changes.map((change) => change.path.join('.')), ['model'])
})

test('a package the anchor cannot resolve really is plugin-missing', async (t) => {
  const fixture = makeFixture(t, { installCore: false })
  const prepared = await run(t, fixture, { installAnchor: fixture.install })
  const row = prepared.plan.rows.find((entry) => entry.id === 'agent-default-model')
  assert.equal(row.action, 'skip')
  assert.deepEqual(row.skippedTargets, [{ profile: 'desktop', reason: 'plugin-missing' }])
})
