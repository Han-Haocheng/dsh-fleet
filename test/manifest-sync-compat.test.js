/**
 * A runtime sync manifest is generated from discovered source rows instead of
 * being read back from `fleet.yml`, so it can carry shapes the file-backed
 * validation intentionally rejects: one copy of a row per profile, providers
 * without an `llm-pi-ai` aggregation row, and a default model pointing at a
 * provider the source carries outside the manifest. Validation must accept
 * those while keeping the strict rules for a manifest without `sync`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateManifest } from '../lib/manifest.js'
import { buildPlan } from '../lib/plan.js'
import { readProfileState } from '../lib/profile.js'
import { baseManifest, makeHome, makeProfile } from './helpers.js'

const KNOWN = { knownProfiles: ['web', 'desktop', 'dsh-tui'] }

/** Duplicate item id errors from one validation run. */
function duplicateErrors(errors) {
  return errors.filter((error) => /duplicate item id/.test(error))
}

test('validateManifest accepts duplicate item ids on disjoint scopes', () => {
  const manifest = baseManifest({
    sync: { targets: ['web', 'desktop'] },
    items: [
      { id: 'web', scope: ['web'], config: { searchProvider: 'ddg' } },
      { id: 'web', scope: ['desktop'], config: { searchProvider: 'kimi' } },
    ],
  })
  assert.deepEqual(validateManifest(manifest, KNOWN), [])
})

test('validateManifest rejects duplicate item ids whose scopes intersect', () => {
  const manifest = baseManifest({
    items: [
      { id: 'web', scope: ['web'], config: {} },
      { id: 'web', scope: ['web', 'desktop'], config: {} },
    ],
  })
  const errors = duplicateErrors(validateManifest(manifest, KNOWN))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^items\[1\]\.id: duplicate item id "web"/)
  assert.match(errors[0], /scopes overlap/)
})

test('validateManifest rejects duplicate item ids when one copy has no scope', () => {
  // An absent scope means every profile, so it intersects any other copy.
  const missing = baseManifest({
    items: [
      { id: 'web', scope: ['desktop'], config: {} },
      { id: 'web', config: {} },
    ],
  })
  const missingErrors = duplicateErrors(validateManifest(missing, KNOWN))
  assert.equal(missingErrors.length, 1)
  assert.match(missingErrors[0], /scopes overlap/)

  const empty = baseManifest({
    items: [
      { id: 'web', scope: [], config: {} },
      { id: 'web', scope: ['desktop'], config: {} },
    ],
  })
  assert.equal(duplicateErrors(validateManifest(empty, KNOWN)).length, 1)
})

test('validateManifest skips the llm-pi-ai requirement when sync is declared', () => {
  const providers = [{ key: 'openmodel', scope: ['all'], config: {} }]
  const withSync = baseManifest({ providers, sync: { targets: ['all'] } })
  assert.deepEqual(validateManifest(withSync, KNOWN), [])

  const withoutSync = baseManifest({ providers })
  assert.ok(
    validateManifest(withoutSync, KNOWN).some((error) => /must declare the "llm-pi-ai" item/.test(error)),
  )
})

test('validateManifest skips the default-model provider check when sync is declared', () => {
  const manifest = baseManifest({
    providers: [{ key: 'openmodel', scope: ['all'], config: {} }],
    items: [
      { id: 'llm-pi-ai', scope: ['all'], config: {} },
      { id: 'agent-default-model', scope: ['all'], config: { provider: 'from-source' } },
    ],
  })
  assert.deepEqual(validateManifest({ ...manifest, sync: {} }, KNOWN), [])

  const withoutSync = validateManifest(manifest, KNOWN)
  assert.ok(
    withoutSync.some((error) => /agent-default-model\.config\.provider "from-source" is not a provider/.test(error)),
  )
})

test('buildPlan accepts a synced manifest with per-scope duplicate items', (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web')
  makeProfile(home, 'desktop')
  const manifest = baseManifest({
    profiles: ['web', 'desktop'],
    sync: { targets: ['web', 'desktop'] },
    items: [
      { id: 'web', name: '@deepseek-ai/dsh-web', scope: ['web'], config: { searchProvider: 'ddg' } },
      { id: 'web', name: '@deepseek-ai/dsh-web', scope: ['desktop'], config: { searchProvider: 'ddg' } },
    ],
  })
  const states = new Map([
    ['web', readProfileState(home, 'web')],
    ['desktop', readProfileState(home, 'desktop')],
  ])

  const plan = buildPlan({ manifest, knownProfiles: ['web', 'desktop'], states })
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(duplicateErrors(plan.errors), [])
  const patched = plan.changes.filter((change) => change.kind === 'patch').map((change) => change.profile)
  assert.deepEqual(patched.sort(), ['desktop', 'web'])
})
