import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveSync, syncTargetsFor } from '../lib/manifest.js'

const KNOWN = ['web', 'desktop', 'dsh-tui']

/** Build a minimal manifest carrying one raw `sync` section. */
function manifestWithSync(sync) {
  return { version: 1, profiles: [...KNOWN], providers: [], bundles: [], items: [], sync }
}

test('resolveSync keeps a manifest without sync disabled', () => {
  const resolved = resolveSync(manifestWithSync(undefined), KNOWN)
  assert.equal(resolved.enabled, false)
  assert.deepEqual(resolved.targets, [])
  assert.ok(resolved.exclude instanceof Set)
  assert.equal(resolved.exclude.size, 0)
  assert.ok(resolved.overrides instanceof Map)
  assert.equal(resolved.overrides.size, 0)
  assert.deepEqual(resolved.errors, [])
  assert.deepEqual(syncTargetsFor(resolved, 'web'), [])
})

test('resolveSync honors sync.enabled: false but still resolves the other fields', () => {
  const resolved = resolveSync(manifestWithSync({
    enabled: false,
    targets: ['desktop'],
    exclude: ['web'],
    overrides: { 'dsh-tui': { targets: ['web'] } },
  }), KNOWN)
  assert.equal(resolved.enabled, false)
  assert.deepEqual(resolved.targets, ['desktop'])
  assert.deepEqual([...resolved.exclude], ['web'])
  assert.deepEqual(resolved.overrides.get('dsh-tui'), { targets: ['web'] })
  assert.deepEqual(resolved.errors, [])
  assert.deepEqual(syncTargetsFor(resolved, 'dsh-tui'), [])

  const defaults = resolveSync(manifestWithSync({ enabled: false }), KNOWN)
  assert.deepEqual(defaults.targets, KNOWN)
})

test('resolveSync enables sync by default and targets every known profile', () => {
  const resolved = resolveSync(manifestWithSync({}), KNOWN)
  assert.equal(resolved.enabled, true)
  assert.deepEqual(resolved.targets, KNOWN)
  assert.deepEqual(resolved.errors, [])
})

test('resolveSync expands the "all" target', () => {
  const resolved = resolveSync(manifestWithSync({ targets: ['all'] }), KNOWN)
  assert.deepEqual(resolved.targets, KNOWN)
  assert.deepEqual(resolved.errors, [])
})

test('resolveSync reports unknown profiles and drops them', () => {
  const resolved = resolveSync(manifestWithSync({ targets: ['web', 'staging', 'web'] }), KNOWN)
  assert.deepEqual(resolved.targets, ['web'])
  assert.equal(resolved.errors.length, 1)
  assert.match(resolved.errors[0], /sync\.targets: unknown profile "staging"/)
})

test('resolveSync collects exclusions and skips excluded rows', () => {
  const resolved = resolveSync(manifestWithSync({ exclude: ['web', 'desktop', 'web'] }), KNOWN)
  assert.deepEqual([...resolved.exclude], ['web', 'desktop'])
  assert.deepEqual(syncTargetsFor(resolved, 'web'), [])
  assert.deepEqual(syncTargetsFor(resolved, 'dsh-tui'), KNOWN)
})

test('resolveSync applies override targets and override disable flags', () => {
  const resolved = resolveSync(manifestWithSync({
    targets: ['all'],
    overrides: {
      web: { targets: ['desktop', 'staging'] },
      'dsh-tui': { enabled: false },
      desktop: {},
    },
  }), KNOWN)
  assert.deepEqual(resolved.targets, KNOWN)
  assert.deepEqual(syncTargetsFor(resolved, 'web'), ['desktop'])
  assert.deepEqual(syncTargetsFor(resolved, 'dsh-tui'), [])
  assert.deepEqual(syncTargetsFor(resolved, 'desktop'), KNOWN)
  assert.deepEqual(syncTargetsFor(resolved, 'unknown-row'), KNOWN)
  assert.ok(resolved.errors.some((error) => /sync\.overrides\.web\.targets: unknown profile "staging"/.test(error)))
})

test('syncTargetsFor covers the disabled, excluded, overridden and default branches', () => {
  const resolved = resolveSync(manifestWithSync({
    targets: ['desktop'],
    exclude: ['hidden'],
    overrides: { off: { enabled: false }, narrow: { targets: ['web'] } },
  }), KNOWN)
  assert.deepEqual(syncTargetsFor(resolved, 'hidden'), [])
  assert.deepEqual(syncTargetsFor(resolved, 'off'), [])
  assert.deepEqual(syncTargetsFor(resolved, 'narrow'), ['web'])
  assert.deepEqual(syncTargetsFor(resolved, 'plain'), ['desktop'])
  assert.deepEqual(syncTargetsFor({ ...resolved, enabled: false }, 'plain'), [])
  assert.deepEqual(syncTargetsFor(undefined, 'plain'), [])

  const targets = syncTargetsFor(resolved, 'plain')
  targets.push('mutated')
  assert.deepEqual(syncTargetsFor(resolved, 'plain'), ['desktop'])
})

test('resolveSync reports a non-object sync section and stays disabled', () => {
  for (const sync of [null, [], 'everything', 42]) {
    const resolved = resolveSync(manifestWithSync(sync), KNOWN)
    assert.equal(resolved.enabled, false)
    assert.deepEqual(resolved.targets, [])
    assert.equal(resolved.errors.length, 1)
    assert.match(resolved.errors[0], /^sync: must be a mapping/)
  }
})

test('resolveSync reports malformed exclude entries and list shapes', () => {
  const resolved = resolveSync(manifestWithSync({ exclude: ['web', 3, '', 'desktop'] }), KNOWN)
  assert.deepEqual([...resolved.exclude], ['web', 'desktop'])
  assert.equal(
    resolved.errors.filter((error) => /sync\.exclude: entries must be non-empty strings/.test(error)).length,
    2,
  )

  const notList = resolveSync(manifestWithSync({ exclude: 'web', overrides: [] }), KNOWN)
  assert.ok(notList.errors.some((error) => /sync\.exclude: must be a list of row ids/.test(error)))
  assert.ok(notList.errors.some((error) => /sync\.overrides: must be a mapping/.test(error)))

  const badTargets = resolveSync(manifestWithSync({ targets: 'web' }), KNOWN)
  assert.deepEqual(badTargets.targets, [])
  assert.ok(badTargets.errors.some((error) => /sync\.targets: must be a list of profile names/.test(error)))
})

test('resolveSync defaults to no targets when no profile is known', () => {
  const resolved = resolveSync(manifestWithSync({}), [])
  assert.equal(resolved.enabled, true)
  assert.deepEqual(resolved.targets, [])
  assert.deepEqual(resolved.errors, [])
  assert.deepEqual(syncTargetsFor(resolved, 'any-row'), [])

  const all = resolveSync(manifestWithSync({ targets: ['all'] }), [])
  assert.deepEqual(all.targets, [])
  assert.deepEqual(all.errors, [])
})

test('resolveSync validates override mappings', () => {
  const resolved = resolveSync(manifestWithSync({
    overrides: {
      web: { targets: ['ghost'], enabled: 'yes' },
      broken: [],
      '': { enabled: false },
    },
  }), KNOWN)
  assert.deepEqual(resolved.overrides.get('web'), { targets: [] })
  assert.equal(resolved.overrides.has('broken'), false)
  assert.equal(resolved.overrides.has(''), false)
  assert.ok(resolved.errors.some((error) => /sync\.overrides\.web\.targets: unknown profile "ghost"/.test(error)))
  assert.ok(resolved.errors.some((error) => /sync\.overrides\.web\.enabled: must be a boolean/.test(error)))
  assert.ok(resolved.errors.some((error) => /sync\.overrides\.broken: must be a mapping with optional targets\/enabled/.test(error)))
  assert.ok(resolved.errors.some((error) => /sync\.overrides\.: row id must be a non-empty string/.test(error)))
})

test('resolveSync is non-throwing and reports a non-boolean enabled', () => {
  const resolved = resolveSync(manifestWithSync({ enabled: 'false' }), KNOWN)
  assert.equal(resolved.enabled, true)
  assert.ok(resolved.errors.some((error) => /sync\.enabled: must be a boolean/.test(error)))

  for (const manifest of [null, undefined, [], 'manifest', 7]) {
    const fallback = resolveSync(manifest, KNOWN)
    assert.equal(fallback.enabled, false)
    assert.deepEqual(fallback.targets, [])
    assert.deepEqual(fallback.errors, [])
  }
})
