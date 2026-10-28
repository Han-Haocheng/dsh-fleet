/**
 * Folding a sync plan into renderer-ready items must not delete rows that only
 * exist in a target profile's managed block.
 *
 * Everything here is pure: profile states are fixtures carrying a `patchText`
 * with a managed block, and the plan is built by hand, so the tests pin the
 * item list (scope, origin, config) rather than the planning rules.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { renderManagedBlock } from '../lib/render.js'
import { buildSyncTargets } from '../lib/sync-merge.js'
import { BLOCK_FOOTER, BLOCK_HEADER_PREFIX, stringifyYaml } from '../lib/util.js'

const KNOWN = ['web', 'desktop', 'laptop']
const HEADER = `${BLOCK_HEADER_PREFIX} v1 sha256:${'0'.repeat(64)} —— generated from ~/.dsh/fleet.yml, do not edit`

/** A patch file whose managed block carries `rows`. */
function blockOf(rows) {
  return `${HEADER}\n${stringifyYaml(rows)}${BLOCK_FOOTER}\n`
}

/** profile -> readProfileState() shape, with only `patchText` set. */
function statesOf(entries) {
  return new Map(Object.entries(entries).map(([profile, patchText]) => [profile, { patchText }]))
}

/** A manifest with the fields a sync fold must carry over unchanged. */
function manifestOf(overrides = {}) {
  return {
    version: 1,
    profiles: ['web', 'desktop'],
    providers: [{ key: 'openmodel', scope: ['all'] }],
    bundles: [{ name: 'dsh-mnemon', spec: 'dsh-mnemon@1.0.0', scope: ['all'] }],
    items: [{ id: 'stale', scope: ['all'], config: { stale: true } }],
    ...overrides,
  }
}

function push(id, targets) {
  return { id, targets, action: 'push', changes: [] }
}

test('push rows become sync items scoped to their plan targets', () => {
  const sourceRows = new Map([
    ['row-a', { id: 'row-a', name: 'Row A', config: { a: 1 } }],
    ['row-b', { id: 'row-b', config: { b: 2 } }],
  ])
  const plan = {
    rows: [
      push('row-a', ['desktop']),
      push('row-b', ['web', 'desktop', 'web']),
      { id: 'ignored', targets: ['web'], action: 'skip', reason: 'in-sync', changes: [] },
    ],
  }
  const built = buildSyncTargets({
    manifest: manifestOf(),
    plan,
    sourceRows,
    states: new Map(),
    knownProfiles: [],
  })

  assert.deepEqual(built.items, [
    { id: 'row-a', scope: ['desktop'], config: { a: 1 }, origin: 'sync' },
    { id: 'row-b', scope: ['web', 'desktop'], config: { b: 2 }, origin: 'sync' },
  ])
  assert.equal(built.items[0].config, sourceRows.get('row-a').config, 'config is the source row config')
  assert.equal('name' in built.items[0], false, 'only the documented item fields are emitted')
  assert.deepEqual(built.warnings, [])
  assert.equal(built.manifest.items, built.items)
})

test('a row only a target block carries becomes a local item scoped to that profile', () => {
  const sourceRows = new Map([['row-a', { id: 'row-a', config: { a: 1 } }]])
  const built = buildSyncTargets({
    manifest: manifestOf(),
    plan: { rows: [push('row-a', ['desktop'])] },
    sourceRows,
    states: statesOf({
      web: blockOf([{ id: 'web-only', name: 'Web', config: { search: 'ddg' } }]),
      desktop: blockOf([{ id: 'row-a', config: { a: 0 } }]),
    }),
    knownProfiles: ['web', 'desktop'],
  })

  assert.deepEqual(built.items, [
    { id: 'row-a', scope: ['desktop'], config: { a: 1 }, origin: 'sync' },
    { id: 'web-only', scope: ['web'], config: { search: 'ddg' }, origin: 'local' },
  ])
  assert.deepEqual(built.warnings, [])
})

test('equal local copies merge into one item with a shared scope', () => {
  const config = { search: 'ddg', nested: { retries: 2 } }
  const built = buildSyncTargets({
    manifest: manifestOf({ profiles: [...KNOWN] }),
    plan: { rows: [] },
    sourceRows: new Map(),
    states: statesOf({
      web: blockOf([{ id: 'shared', config }]),
      // Same content, different key order: still one item.
      desktop: blockOf([{ id: 'shared', config: { nested: { retries: 2 }, search: 'ddg' } }]),
      laptop: blockOf([{ id: 'shared', config: { search: 'bing' } }]),
    }),
    knownProfiles: KNOWN,
  })

  assert.deepEqual(built.items, [
    { id: 'shared', scope: ['web', 'desktop'], config, origin: 'local' },
    { id: 'shared', scope: ['laptop'], config: { search: 'bing' }, origin: 'local' },
  ])
})

test('equal ids with different content stay split so each profile renders its own copy', () => {
  const built = buildSyncTargets({
    manifest: manifestOf(),
    plan: { rows: [] },
    sourceRows: new Map(),
    states: statesOf({
      web: blockOf([{ id: 'shared', config: { mode: 'web' } }]),
      desktop: blockOf([{ id: 'shared', config: { mode: 'desktop' } }]),
    }),
    knownProfiles: ['web', 'desktop'],
  })

  assert.deepEqual(built.items, [
    { id: 'shared', scope: ['web'], config: { mode: 'web' }, origin: 'local' },
    { id: 'shared', scope: ['desktop'], config: { mode: 'desktop' }, origin: 'local' },
  ])

  for (const [profile, mode] of [['web', 'web'], ['desktop', 'desktop']]) {
    const { entries } = renderManagedBlock({
      manifest: built.manifest,
      profile,
      knownProfiles: ['web', 'desktop'],
    })
    assert.deepEqual(entries, [{ id: 'shared', config: { mode } }], `${profile} hits exactly its own row`)
  }
})

test('a covered profile is not duplicated and an uncovered profile keeps its copy', () => {
  const sourceRows = new Map([['row-a', { id: 'row-a', config: { value: 'new' } }]])
  const built = buildSyncTargets({
    manifest: manifestOf(),
    plan: { rows: [push('row-a', ['desktop'])] },
    sourceRows,
    states: statesOf({
      web: blockOf([{ id: 'row-a', config: { value: 'web-old' } }]),
      desktop: blockOf([{ id: 'row-a', config: { value: 'desktop-old' } }]),
    }),
    knownProfiles: ['web', 'desktop'],
  })

  assert.deepEqual(built.items, [
    { id: 'row-a', scope: ['desktop'], config: { value: 'new' }, origin: 'sync' },
    { id: 'row-a', scope: ['web'], config: { value: 'web-old' }, origin: 'local' },
  ])
  assert.equal(
    built.items.some((item) => item.origin === 'local' && item.scope.includes('desktop')),
    false,
    'the covered profile is left to the sync item',
  )
})

test('missing patch text, a missing block and a broken block warn instead of throwing', () => {
  const built = buildSyncTargets({
    manifest: manifestOf(),
    plan: { rows: [] },
    sourceRows: new Map(),
    states: new Map([
      ['web', {}],
      ['desktop', { patchText: '# an ordinary patch, no fleet block\n- id: outside\n' }],
      // An unresolved alias is one of the few documents parseYamlTolerant rejects.
      ['laptop', { patchText: `${HEADER}\n- id: broken\n  config: *missing\n${BLOCK_FOOTER}\n` }],
    ]),
    knownProfiles: ['web', 'desktop', 'laptop'],
  })

  assert.deepEqual(built.items, [])
  assert.equal(built.warnings.length, 3)
  assert.ok(built.warnings.some((warning) => /profile "web": no patch text/.test(warning)))
  assert.ok(built.warnings.some((warning) => /profile "desktop": no managed block/.test(warning)))
  assert.ok(built.warnings.some((warning) => /profile "laptop": managed block is not a valid row list/.test(warning)))
})

test('the original manifest fields survive and items are replaced', () => {
  const original = manifestOf()
  const before = JSON.stringify(original)
  const built = buildSyncTargets({
    manifest: original,
    plan: { rows: [] },
    sourceRows: new Map(),
    states: statesOf({
      web: blockOf([{ id: 'local', config: { keep: true } }]),
      desktop: blockOf([]),
    }),
    knownProfiles: ['web', 'desktop'],
  })

  assert.equal(built.manifest.version, 1)
  assert.deepEqual(built.manifest.profiles, original.profiles)
  assert.deepEqual(built.manifest.providers, original.providers)
  assert.deepEqual(built.manifest.bundles, original.bundles)
  assert.deepEqual(built.manifest.items, [
    { id: 'local', scope: ['web'], config: { keep: true }, origin: 'local' },
  ])
  assert.equal(JSON.stringify(original), before, 'the input manifest is not mutated')
})

test('absent top-level fields are not invented', () => {
  const built = buildSyncTargets({ manifest: { version: 1 }, plan: { rows: [] }, knownProfiles: [] })
  assert.deepEqual(Object.keys(built.manifest).sort(), ['items', 'version'])
  assert.deepEqual(built.manifest.items, [])
})

test('a missing options object yields an empty item list', () => {
  assert.deepEqual(buildSyncTargets(), { manifest: { items: [] }, items: [], warnings: [] })
})
