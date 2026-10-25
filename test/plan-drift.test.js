import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPlan } from '../lib/plan.js'
import { renderManagedBlock } from '../lib/render.js'
import { baseManifest } from './helpers.js'

function stateFor(patchText) {
  return { present: true, patchText, bundles: [], rowIds: new Set(), installed: new Set() }
}

test('buildPlan rewrites a managed block whose body was edited while its header kept the old hash', () => {
  const manifest = baseManifest({
    profiles: ['web'],
    bundles: [],
    providers: [],
    items: [{ id: 'web', name: '@deepseek-ai/dsh-web', scope: ['web'], config: { searchProvider: 'ddg' } }],
  })
  const rendered = renderManagedBlock({ manifest, profile: 'web', knownProfiles: ['web'] })

  const clean = buildPlan({
    manifest,
    knownProfiles: ['web'],
    states: new Map([['web', stateFor(rendered.text)]]),
    capabilities: () => 'cli',
  })
  assert.equal(clean.changes.some((change) => change.kind === 'patch'), false)

  // Same header hash, different body: a config editor or a manual edit that
  // preserves the marker line must still be visible as drift.
  const tampered = rendered.text.replace('searchProvider: ddg', 'searchProvider: bing')
  assert.notEqual(tampered, rendered.text)

  const drifted = buildPlan({
    manifest,
    knownProfiles: ['web'],
    states: new Map([['web', stateFor(tampered)]]),
    capabilities: () => 'cli',
  })
  const patch = drifted.changes.find((change) => change.kind === 'patch')
  assert.ok(patch, 'plan must report a patch change')
  assert.match(patch.detail, /edited outside fleet/)
})

test('buildPlan still reports a stale header even when the body matches', () => {
  const manifest = baseManifest({
    profiles: ['web'],
    bundles: [],
    providers: [],
    items: [{ id: 'web', name: '@deepseek-ai/dsh-web', scope: ['web'], config: { searchProvider: 'ddg' } }],
  })
  const rendered = renderManagedBlock({ manifest, profile: 'web', knownProfiles: ['web'] })
  const staleHeader = rendered.text.replace(/sha256:[0-9a-f]{64}/, `sha256:${'0'.repeat(64)}`)

  const plan = buildPlan({
    manifest,
    knownProfiles: ['web'],
    states: new Map([['web', stateFor(staleHeader)]]),
    capabilities: () => 'cli',
  })
  const patch = plan.changes.find((change) => change.kind === 'patch')
  assert.ok(patch)
  assert.match(patch.detail, /out of date/)
})
