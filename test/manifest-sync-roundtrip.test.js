/**
 * The `sync:` section is part of the manifest document, not an unknown
 * top-level field: parse and serialize must preserve it so a round trip never
 * silently strips the sync policy.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseManifest, resolveSync, serializeManifest, syncTargetsFor } from '../lib/manifest.js'

const KNOWN = ['web', 'desktop']

const WITH_SYNC = `version: 1
profiles: [web, desktop]
items:
  - id: row-a
    scope: [all]
    config: {}
sync:
  targets: [all]
  exclude: [x]
  overrides:
    y:
      targets: [web]
`

test('parseManifest keeps the sync section without an unknown-field warning', () => {
  const { manifest, errors, warnings } = parseManifest(WITH_SYNC)

  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
  assert.deepEqual(manifest.sync, {
    targets: ['all'],
    exclude: ['x'],
    overrides: { y: { targets: ['web'] } },
  })
})

test('a parsed sync section resolves into an enabled policy', () => {
  const { manifest } = parseManifest(WITH_SYNC)
  const resolved = resolveSync(manifest, KNOWN)

  assert.deepEqual(resolved.errors, [])
  assert.equal(resolved.enabled, true)
  assert.deepEqual(resolved.targets, KNOWN)
  assert.deepEqual([...resolved.exclude], ['x'])
  assert.deepEqual(resolved.overrides.get('y'), { targets: ['web'] })
  assert.deepEqual(syncTargetsFor(resolved, 'row-a'), KNOWN)
  assert.deepEqual(syncTargetsFor(resolved, 'x'), [], 'the exclude list wins')
  assert.deepEqual(syncTargetsFor(resolved, 'y'), ['web'], 'per-row targets win')
})

test('serializeManifest -> parseManifest round-trips the sync section', () => {
  const first = parseManifest(WITH_SYNC).manifest
  const text = serializeManifest(first)
  assert.match(text, /^sync:/m)

  const second = parseManifest(text)
  assert.deepEqual(second.errors, [])
  assert.deepEqual(second.warnings, [])
  assert.deepEqual(second.manifest.sync, first.sync)
  assert.equal(serializeManifest(second.manifest), text, 'serialization stays stable')
})
