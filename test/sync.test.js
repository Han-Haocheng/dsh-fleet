/**
 * Sync planning: what to push from one profile's rows, and the manifest the
 * existing renderer consumes after a sync.
 *
 * Everything here is pure — no Harness home, no patch file, no policy parser.
 * The resolved policy and the target rows are fixtures, so the tests pin the
 * plan shape itself: skip precedence, field-level changes and whole-row adds.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSyncedManifest, planSync } from '../lib/sync.js'

const NOW = '2026-01-02T03:04:05.000Z'

/** Baseline enabled policy; every test narrows what it cares about. */
function policy(overrides = {}) {
  return {
    enabled: true,
    targets: ['desktop'],
    exclude: new Set(),
    overrides: new Map(),
    errors: [],
    ...overrides,
  }
}

/** profile -> (rowId -> config) as nested Maps, the shape planSync documents. */
function rowsByProfile(entries) {
  const result = new Map()
  for (const [profile, rows] of Object.entries(entries)) {
    result.set(profile, new Map(Object.entries(rows)))
  }
  return result
}

test('planSync reports a disabled policy and plans nothing', () => {
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({ enabled: false }),
    sourceRows: new Map([['row-a', { id: 'row-a', config: { a: 1 } }]]),
    knownProfiles: ['web', 'desktop'],
    now: () => NOW,
  })

  assert.deepEqual(plan, {
    ok: false,
    sourceProfile: 'web',
    generatedAt: NOW,
    rows: [],
    errors: ['sync is not enabled in this manifest'],
  })
})

test('planSync reports one field-level change for a single target', () => {
  const sourceConfig = { provider: 'openmodel', model: 'deepseek-v4', options: { retries: 2 } }
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({ targets: ['web', 'desktop'] }),
    sourceRows: new Map([['llm-pi-ai', { id: 'llm-pi-ai', name: 'LLM', config: sourceConfig }]]),
    knownProfiles: ['web', 'desktop'],
    targetRows: rowsByProfile({
      desktop: { 'llm-pi-ai': { provider: 'openmodel', model: 'older', options: { retries: 2 } } },
    }),
    now: () => NOW,
  })

  assert.equal(plan.ok, true)
  assert.equal(plan.sourceProfile, 'web')
  assert.equal(plan.generatedAt, NOW)
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.rows, [
    {
      id: 'llm-pi-ai',
      targets: ['desktop'],
      action: 'push',
      changes: [{ profile: 'desktop', path: ['model'], from: 'older', to: 'deepseek-v4' }],
    },
  ])
})

test('planSync aggregates changes per target and adds a missing row whole', () => {
  const sourceConfig = { alpha: 1, beta: 2 }
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({ targets: ['web', 'desktop', 'laptop'] }),
    sourceRows: new Map([['row-a', { id: 'row-a', config: sourceConfig }]]),
    knownProfiles: ['web', 'desktop', 'laptop'],
    // The laptop profile is absent entirely, so that row is a whole-row add.
    targetRows: rowsByProfile({ desktop: { 'row-a': { alpha: 0, beta: 2 } } }),
    now: () => NOW,
  })

  assert.deepEqual(plan.rows, [
    {
      id: 'row-a',
      targets: ['desktop', 'laptop'],
      action: 'push',
      changes: [
        { profile: 'desktop', path: ['alpha'], from: 0, to: 1 },
        { profile: 'laptop', path: [], from: undefined, to: sourceConfig },
      ],
    },
  ])
})

test('planSync skips rows whose targets already match, ignoring key order', () => {
  const config = { nested: { a: 1, list: [1, 2, { x: true }] }, name: 'same' }
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({ targets: ['desktop'] }),
    sourceRows: new Map([['row-a', { id: 'row-a', config }]]),
    knownProfiles: ['web', 'desktop'],
    targetRows: rowsByProfile({
      desktop: { 'row-a': { name: 'same', nested: { list: [1, 2, { x: true }], a: 1 } } },
    }),
    now: () => NOW,
  })

  assert.equal(plan.ok, true)
  assert.deepEqual(plan.rows, [
    { id: 'row-a', targets: ['desktop'], action: 'skip', reason: 'in-sync', changes: [] },
  ])
})

test('planSync skips a row with no target left after removing the source profile', () => {
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({
      targets: ['web', 'desktop'],
      exclude: new Set(['excluded']),
      overrides: new Map([['only-source', { targets: ['web'] }]]),
    }),
    sourceRows: new Map([
      ['excluded', { id: 'excluded', config: { a: 1 } }],
      ['only-source', { id: 'only-source', config: { b: 2 } }],
    ]),
    knownProfiles: ['web', 'desktop'],
    targetRows: rowsByProfile({ desktop: { excluded: { a: 1 }, 'only-source': { b: 2 } } }),
    now: () => NOW,
  })

  assert.deepEqual(
    plan.rows.map((row) => [row.id, row.targets, row.action, row.reason]),
    [
      ['excluded', [], 'skip', 'no-target'],
      ['only-source', [], 'skip', 'no-target'],
    ],
  )
})

test('planSync checks autoSkip before no-target and the diff', () => {
  const seen = []
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({
      targets: ['web', 'desktop'],
      overrides: new Map([['pinned', { enabled: false }]]),
    }),
    sourceRows: new Map([
      ['pinned', { id: 'pinned', name: 'Pinned', config: { a: 1 } }],
      ['clean', { id: 'clean', config: { b: 2 } }],
    ]),
    knownProfiles: ['web', 'desktop'],
    targetRows: rowsByProfile({ desktop: { pinned: { a: 1 }, clean: { b: 2 } } }),
    autoSkip: (row) => {
      seen.push(row)
      return row.id === 'pinned' ? 'pinned-by-policy' : undefined
    },
    now: () => NOW,
  })

  assert.deepEqual(seen.map((row) => row.id), ['pinned', 'clean'])
  assert.equal(seen[0].config.a, 1, 'autoSkip receives the source row itself')
  assert.deepEqual(
    plan.rows.map((row) => [row.id, row.targets, row.reason]),
    [
      ['pinned', [], 'pinned-by-policy'],
      ['clean', ['desktop'], 'in-sync'],
    ],
  )
})

test('planSync lets a row override replace the default target list', () => {
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({
      targets: ['desktop', 'laptop'],
      overrides: new Map([['narrow', { targets: ['laptop'] }]]),
    }),
    sourceRows: new Map([
      ['narrow', { id: 'narrow', config: { a: 1 } }],
      ['plain', { id: 'plain', config: { b: 2 } }],
    ]),
    knownProfiles: ['web', 'desktop', 'laptop'],
    targetRows: rowsByProfile({ desktop: {}, laptop: {} }),
    now: () => NOW,
  })

  assert.deepEqual(plan.rows.find((row) => row.id === 'narrow').targets, ['laptop'])
  assert.deepEqual(plan.rows.find((row) => row.id === 'plain').targets, ['desktop', 'laptop'])
})

test('planSync recurses into objects and compares arrays as whole values', () => {
  const sourceConfig = {
    outer: { inner: { keep: 'yes', change: 2 }, list: [1, 2, 3] },
    models: [{ id: 'a', tags: ['x'] }, { id: 'b', tags: ['y'] }],
    typeChange: { deep: true },
  }
  const targetConfig = {
    outer: { inner: { keep: 'yes', change: 1 }, list: [1, 2, 3] },
    models: [{ id: 'a', tags: ['x'] }, { id: 'b', tags: ['z'] }],
    typeChange: 7,
    targetOnly: 'stale',
  }
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({ targets: ['desktop'] }),
    sourceRows: new Map([['row-a', { id: 'row-a', config: sourceConfig }]]),
    knownProfiles: ['web', 'desktop'],
    targetRows: rowsByProfile({ desktop: { 'row-a': targetConfig } }),
    now: () => NOW,
  })

  assert.deepEqual(plan.rows[0].changes, [
    { profile: 'desktop', path: ['outer', 'inner', 'change'], from: 1, to: 2 },
    { profile: 'desktop', path: ['models'], from: targetConfig.models, to: sourceConfig.models },
    { profile: 'desktop', path: ['typeChange'], from: 7, to: { deep: true } },
    { profile: 'desktop', path: ['targetOnly'], from: 'stale', to: undefined },
  ])
})

test('planSync reports policy errors and keeps planning rows', () => {
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({ targets: ['desktop'], errors: ['sync.targets: unknown profile "ghost"'] }),
    sourceRows: new Map([['row-a', { id: 'row-a', config: { a: 1 } }]]),
    knownProfiles: ['web', 'desktop'],
    targetRows: rowsByProfile({ desktop: {} }),
    now: () => NOW,
  })

  assert.equal(plan.ok, false)
  assert.deepEqual(plan.errors, ['sync.targets: unknown profile "ghost"'])
  assert.equal(plan.rows.length, 1)
  assert.equal(plan.rows[0].action, 'push')
})

test('planSync turns a throwing autoSkip into a plan error', () => {
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({ targets: ['desktop'] }),
    sourceRows: new Map([['row-a', { id: 'row-a', config: { a: 1 } }]]),
    knownProfiles: ['web', 'desktop'],
    targetRows: rowsByProfile({ desktop: { 'row-a': { a: 1 } } }),
    autoSkip: () => {
      throw new Error('boom')
    },
    now: () => NOW,
  })

  assert.equal(plan.ok, false)
  assert.deepEqual(plan.errors, ['autoSkip for row "row-a" failed: boom'])
  assert.equal(plan.rows[0].reason, 'in-sync')
})

test('buildSyncedManifest keeps the top level and replaces items with pushed rows', () => {
  const manifest = {
    version: 1,
    profiles: ['web', 'desktop', 'laptop'],
    providers: [{ key: 'openmodel', scope: ['all'] }],
    bundles: [{ name: 'dsh-mnemon', spec: 'dsh-mnemon@1.0.0', scope: ['all'] }],
    items: [{ id: 'stale-row', scope: ['all'], config: { stale: true } }],
  }
  const sourceRows = new Map([
    ['llm-pi-ai', { id: 'llm-pi-ai', name: 'LLM', config: { provider: 'openmodel', models: ['deepseek-v4'] } }],
    ['agent-default-model', { id: 'agent-default-model', config: { provider: 'openmodel' } }],
    ['web-only', { id: 'web-only', config: { only: 'web' } }],
    ['pinned', { id: 'pinned', config: { pinned: true } }],
  ])
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({
      targets: ['desktop', 'laptop'],
      overrides: new Map([['web-only', { enabled: false }]]),
    }),
    sourceRows,
    knownProfiles: ['web', 'desktop', 'laptop'],
    targetRows: rowsByProfile({
      desktop: {
        'llm-pi-ai': { provider: 'openmodel', models: ['older'] },
        'agent-default-model': { provider: 'openmodel' },
      },
      laptop: {
        'llm-pi-ai': { provider: 'openmodel', models: ['deepseek-v4'] },
        'agent-default-model': { provider: 'openmodel' },
      },
    }),
    autoSkip: (row) => (row.id === 'pinned' ? 'pinned-by-policy' : undefined),
    now: () => NOW,
  })

  const built = buildSyncedManifest({ manifest, plan, sourceRows })

  assert.equal(built.manifest.version, 1)
  assert.deepEqual(built.manifest.profiles, ['web', 'desktop', 'laptop'])
  assert.deepEqual(built.manifest.providers, manifest.providers)
  assert.deepEqual(built.manifest.bundles, manifest.bundles)
  assert.deepEqual(built.manifest.items, [
    {
      id: 'llm-pi-ai',
      name: 'LLM',
      scope: ['desktop', 'laptop'],
      config: sourceRows.get('llm-pi-ai').config,
    },
  ])
  assert.equal(built.manifest.items[0].config, sourceRows.get('llm-pi-ai').config, 'config comes from the source row')
  assert.equal(built.manifest.items.some((item) => item.id === 'stale-row'), false, 'original items are dropped')
  assert.equal(manifest.items.length, 1, 'the input manifest is not mutated')
  assert.deepEqual(built.skipped, [
    { id: 'agent-default-model', reason: 'in-sync' },
    { id: 'web-only', reason: 'no-target' },
    { id: 'pinned', reason: 'pinned-by-policy' },
  ])
})

test('buildSyncedManifest derives profiles from the plan only when the manifest has none', () => {
  const manifest = { version: 1, providers: [], bundles: [], items: [] }
  const sourceRows = new Map([
    ['push-row', { id: 'push-row', config: { a: 1 } }],
    ['same-row', { id: 'same-row', config: { b: 2 } }],
  ])
  const plan = planSync({
    sourceProfile: 'web',
    sync: policy({
      targets: ['web', 'desktop', 'laptop', 'staging'],
      overrides: new Map([['push-row', { targets: ['desktop'] }]]),
    }),
    sourceRows,
    knownProfiles: ['web', 'desktop', 'laptop', 'staging'],
    targetRows: rowsByProfile({
      desktop: { 'same-row': { b: 2 } },
      laptop: { 'same-row': { b: 2 } },
      staging: { 'same-row': { b: 2 } },
    }),
    now: () => NOW,
  })

  const built = buildSyncedManifest({ manifest, plan, sourceRows })

  assert.deepEqual(built.manifest.profiles, ['desktop', 'laptop', 'staging'])
  assert.deepEqual(built.manifest.items, [{ id: 'push-row', scope: ['desktop'], config: { a: 1 } }])
  assert.equal('name' in built.manifest.items[0], false, 'a nameless source row yields a nameless item')
  assert.deepEqual(built.skipped, [{ id: 'same-row', reason: 'in-sync' }])
})

test('planSync and buildSyncedManifest tolerate missing options', () => {
  const plan = planSync()
  assert.equal(plan.ok, false)
  assert.equal(plan.sourceProfile, '')
  assert.equal(typeof plan.generatedAt, 'string')
  assert.deepEqual(plan.rows, [])
  assert.deepEqual(plan.errors, ['sync is not enabled in this manifest'])

  assert.deepEqual(buildSyncedManifest(), {
    manifest: { profiles: [], providers: [], bundles: [], items: [] },
    skipped: [],
  })
})
