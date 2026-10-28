/**
 * Host-side sync preparation: policy gating, source reading, the patch-text
 * row-id scans, the allowed-id rule, target effective-config diffing, the
 * cross-backend `!!js` exclusion, and the merged manifest the renderer would
 * apply.
 *
 * The source is always a fake `configEditor` (never a live service) and the
 * target profiles are real fixture files under a throwaway Harness home, so a
 * test exercises the same `readProfileState` path the Host uses without
 * touching this machine's profiles. Target dumps are always stubs: no test ever
 * spawns `dsh`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { prepareSync, rowIdsFromPatch } from '../lib/sync-run.js'
import { readProfileState } from '../lib/profile.js'
import { BLOCK_FOOTER, BLOCK_HEADER_PREFIX, stringifyYaml } from '../lib/util.js'
import { makeHome, makeProfile } from './helpers.js'

const KNOWN = ['web', 'desktop', 'laptop']
const HEADER = `${BLOCK_HEADER_PREFIX} v1 sha256:${'0'.repeat(64)} —— generated from ~/.dsh/fleet.yml, do not edit`

/** A patch file whose managed block carries `rows`. */
function blockOf(rows) {
  return `${HEADER}\n${stringifyYaml(rows)}${BLOCK_FOOTER}\n`
}

/** A manifest with sync enabled against the whole known profile universe. */
function manifestOf(overrides = {}) {
  return {
    version: 1,
    profiles: [...KNOWN],
    providers: [],
    bundles: [],
    items: [],
    sync: { enabled: true, targets: ['all'] },
    ...overrides,
  }
}

/**
 * Cordis-like context exposing `profileContext` and optionally a
 * `configEditor`. `calls` records how often each service was used, which is
 * how the "policy disabled" and "no source profile" tests prove the source
 * was never read.
 */
function makeContext(home, { profile = 'web', configuration } = {}) {
  const calls = { configuration: 0, dumps: 0 }
  const ctx = {
    get(name) {
      if (name === 'profileContext') {
        return profile === null
          ? { home }
          : { home, name: profile, installAnchor: null, dir: join(home, 'profiles', profile) }
      }
      if (name === 'configEditor' && configuration !== undefined) {
        return {
          configuration: async () => {
            calls.configuration += 1
            return configuration()
          },
        }
      }
      return undefined
    },
  }
  return { ctx, calls }
}

/** The `readProfileState()` map `buildSnapshot()` would pass to prepareSync. */
function statesFrom(home, profiles = KNOWN) {
  return new Map(profiles.map((name) => [name, readProfileState(home, name)]))
}

/** One runtime configuration row with a stable fiber config. */
function rowOf(id, config) {
  return { entry: { options: { id }, fiber: { config } } }
}

test('a manifest without sync previews nothing and never reads the source', async (t) => {
  const home = makeHome(t)
  for (const profile of KNOWN) makeProfile(home, profile, { patchText: blockOf([]) })
  const { ctx, calls } = makeContext(home, { configuration: () => [] })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web', dshCommand: 'dsh' },
    manifest: manifestOf({ sync: undefined }),
    knownProfiles: KNOWN,
    states: statesFrom(home),
  })

  assert.equal(prepared.ok, false)
  assert.deepEqual(prepared.errors, ['sync is not enabled in this manifest'])
  assert.equal(prepared.sourceProfile, null)
  assert.equal(prepared.backend, null)
  assert.equal(prepared.resolved, null)
  assert.equal(prepared.plan, null)
  assert.equal(prepared.merged, null)
  assert.deepEqual(prepared.warnings, [])
  assert.equal(calls.configuration, 0, 'a disabled policy must not read the source rows')
})

test('a normal push skips js rows, diffs targets and scopes merged items', async (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web')
  makeProfile(home, 'desktop', {
    patchText: blockOf([
      { id: 'demo', config: { mode: 'slow', token: 'secret' } },
      { id: 'local-only', config: { search: 'ddg' } },
    ]),
  })
  makeProfile(home, 'laptop', { patchText: blockOf([]) })

  const { ctx } = makeContext(home, {
    configuration: () => [
      rowOf('demo', { mode: 'fast', token: 'secret' }),
      rowOf('expr-row', { token: { __jsExpr: 'process.env.TOKEN' } }),
    ],
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states: statesFrom(home),
  })

  assert.equal(prepared.ok, true)
  assert.equal(prepared.sourceProfile, 'web')
  assert.equal(prepared.backend, 'runtime')
  assert.equal(prepared.resolved.enabled, true)
  assert.deepEqual(prepared.resolved.errors, [])
  assert.deepEqual(prepared.errors, [])

  const byId = new Map(prepared.plan.rows.map((row) => [row.id, row]))

  const demo = byId.get('demo')
  assert.equal(demo.action, 'push')
  assert.deepEqual(demo.targets, ['desktop', 'laptop'], 'the source profile is removed from its own targets')
  const desktopChange = demo.changes.find((change) => change.profile === 'desktop')
  assert.deepEqual(desktopChange, {
    profile: 'desktop',
    path: ['mode'],
    from: 'slow',
    to: 'fast',
  })
  const laptopChange = demo.changes.find((change) => change.profile === 'laptop')
  assert.deepEqual(laptopChange, {
    profile: 'laptop',
    path: [],
    from: undefined,
    to: { mode: 'fast', token: 'secret' },
  }, 'a missing target row is a whole-row change')

  const expr = byId.get('expr-row')
  assert.equal(expr.action, 'skip')
  assert.equal(expr.reason, 'js-expression')
  assert.deepEqual(expr.changes, [])

  assert.deepEqual(prepared.merged.items, [
    {
      id: 'demo',
      scope: ['desktop', 'laptop'],
      config: { mode: 'fast', token: 'secret' },
      origin: 'sync',
    },
    {
      id: 'local-only',
      scope: ['desktop'],
      config: { search: 'ddg' },
      origin: 'local',
    },
  ])
  assert.deepEqual(prepared.merged.manifest.profiles, KNOWN)
  assert.equal(
    prepared.merged.items.some((item) => item.id === 'expr-row'),
    false,
    'an expression row never reaches the merged manifest',
  )
})

test('a sync target row is diffed from its current value', async (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web')
  makeProfile(home, 'desktop', {
    patchText: blockOf([{ id: 'demo', config: { mode: 'slow', extra: true } }]),
  })

  const { ctx } = makeContext(home, {
    configuration: () => [rowOf('demo', { mode: 'fast' })],
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf({ profiles: ['web', 'desktop'], sync: { enabled: true, targets: ['desktop'] } }),
    knownProfiles: ['web', 'desktop'],
    states: statesFrom(home, ['web', 'desktop']),
  })

  const row = prepared.plan.rows.find((entry) => entry.id === 'demo')
  assert.equal(row.action, 'push')
  assert.deepEqual(row.changes, [
    { profile: 'desktop', path: ['mode'], from: 'slow', to: 'fast' },
    // A target field the source does not carry is removed by the push.
    { profile: 'desktop', path: ['extra'], from: true, to: undefined },
  ])
})

test('a !!js row in the source patch is excluded even when the CLI evaluated it', async (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', {
    patchText: `- id: demo\n  config:\n    token: !!js process.env.DEMO_TOKEN\n`,
  })
  makeProfile(home, 'desktop', { patchText: blockOf([]) })

  // An empty runtime configuration makes readSourceRows fall back to the CLI,
  // whose dump has already evaluated the expression.
  const { ctx, calls } = makeContext(home, { configuration: () => [] })
  let dumpCalls = 0
  const dump = async (options) => {
    dumpCalls += 1
    assert.deepEqual(options, { dshBin: '/fake/dsh', profile: 'web' })
    return { ok: true, text: '- id: demo\n  config:\n    token: evaluated-value\n', error: null }
  }
  // Target effective-config reads are a different test's concern; failing them
  // here keeps the only `dump` call the source read this test is about.
  const dumpTarget = async ({ profile }) => ({ ok: false, text: '', error: `no dump for ${profile}` })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web', dshCommand: 'dsh' },
    manifest: manifestOf({ profiles: ['web', 'desktop'], sync: { enabled: true, targets: ['desktop'] } }),
    knownProfiles: ['web', 'desktop'],
    states: statesFrom(home, ['web', 'desktop']),
    dshBin: '/fake/dsh',
    dump,
    dumpTarget,
  })

  assert.equal(calls.configuration, 1, 'the runtime backend was tried first')
  assert.equal(dumpCalls, 1, 'the CLI backend supplied the rows')
  assert.equal(prepared.backend, 'cli')
  assert.equal(prepared.ok, true)
  // The patch text still names `demo`, so the text scan must catch it.
  assert.equal(prepared.plan.rows.length, 1)
  assert.equal(prepared.plan.rows[0].id, 'demo')
  assert.equal(prepared.plan.rows[0].action, 'skip')
  assert.equal(prepared.plan.rows[0].reason, 'js-expression')
})

test('a missing current profile is an explicit error', async (t) => {
  const home = makeHome(t)
  for (const profile of KNOWN) makeProfile(home, profile, { patchText: blockOf([]) })
  const { ctx, calls } = makeContext(home, { profile: null, configuration: () => [] })

  const prepared = await prepareSync({
    ctx,
    env: { home },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states: statesFrom(home),
  })

  assert.equal(prepared.ok, false)
  assert.deepEqual(prepared.errors, ['the source profile is unknown (no profileContext)'])
  assert.equal(prepared.sourceProfile, null)
  assert.equal(prepared.backend, null)
  assert.equal(prepared.plan, null)
  assert.equal(prepared.merged, null)
  assert.equal(calls.configuration, 0, 'no profile means no source read')
})

test('a source read failure is reported without a plan', async (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web')
  const { ctx } = makeContext(home, {
    configuration: () => {
      throw new Error('configEditor is down')
    },
  })

  const prepared = await prepareSync({
    ctx,
    // No dsh command: the CLI fallback cannot run either.
    env: { home, currentProfile: 'web' },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states: statesFrom(home),
  })

  assert.equal(prepared.ok, false)
  assert.equal(prepared.sourceProfile, 'web')
  assert.equal(prepared.backend, null)
  assert.equal(prepared.plan, null)
  assert.equal(prepared.merged, null)
  assert.match(prepared.errors[0], /configEditor service failed \(configEditor is down\)/)
})

test('rowIdsFromPatch reads top-level row headers only', () => {
  assert.deepEqual(
    [...rowIdsFromPatch('- id: demo\n  config:\n    mode: fast\n- id: other\n  config: {}\n')],
    ['demo', 'other'],
  )
  // A `!!js` value does not hide the row: the scan is about headers, not values.
  assert.deepEqual([...rowIdsFromPatch('- id: expr\n  config:\n    token: !!js process.env.TOKEN\n')], ['expr'])
  // Duplicate ids collapse into one entry.
  assert.deepEqual([...rowIdsFromPatch('- id: demo\n- id: demo\n')], ['demo'])
  // A nested `- id:` belongs to a row's config, not to the document.
  assert.deepEqual(
    [...rowIdsFromPatch('- id: demo\n  config:\n    nested:\n      - id: inner\n')],
    ['demo'],
  )
  // Anything that is not patch text declares no rows.
  for (const empty of [undefined, null, '', '   \n', 42, {}, []]) {
    assert.equal(rowIdsFromPatch(empty).size, 0, `no ids for ${String(empty)}`)
  }
})

test('by default only ids declared in a profile patch may be synced', async (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', { patchText: blockOf([{ id: 'demo', config: { mode: 'fast' } }]) })
  makeProfile(home, 'desktop', { patchText: blockOf([{ id: 'demo', config: { mode: 'slow' } }]) })
  makeProfile(home, 'laptop', { patchText: blockOf([]) })

  // `ghost` is mounted by the source but declared by no profile's patch file,
  // so it is inherited state and must not be copied anywhere.
  const { ctx } = makeContext(home, {
    configuration: () => [rowOf('demo', { mode: 'fast' }), rowOf('ghost', { mode: 'fast' })],
  })
  const dumped = []
  const dumpTarget = async ({ profile }) => {
    dumped.push(profile)
    return { ok: true, text: '', error: null }
  }

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states: statesFrom(home),
    dumpTarget,
  })

  assert.deepEqual(dumped, ['desktop', 'laptop'], 'the source profile is never dumped a second time')
  const byId = new Map(prepared.plan.rows.map((row) => [row.id, row]))
  assert.equal(byId.get('demo').action, 'push')
  const ghost = byId.get('ghost')
  assert.equal(ghost.action, 'skip')
  assert.equal(ghost.reason, 'not-a-profile-row')
  assert.deepEqual(ghost.changes, [])
  assert.deepEqual(prepared.warnings, [], 'successful dumps add no warning')
})

test('an explicit allowedRowIds replaces the patch-derived default', async (t) => {
  const home = makeHome(t)
  // Both ids are declared, so the default union would allow both.
  makeProfile(home, 'web', {
    patchText: blockOf([
      { id: 'demo', config: { mode: 'fast' } },
      { id: 'ghost', config: { search: 'ddg' } },
    ]),
  })
  makeProfile(home, 'desktop', { patchText: blockOf([]) })
  makeProfile(home, 'laptop', { patchText: blockOf([]) })

  const { ctx } = makeContext(home, {
    configuration: () => [rowOf('demo', { mode: 'fast' }), rowOf('ghost', { search: 'ddg' })],
  })
  const dumpTarget = async () => ({ ok: true, text: '', error: null })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states: statesFrom(home),
    dumpTarget,
    // A Set is accepted, and entries are trimmed like every other id option.
    allowedRowIds: new Set([' ghost ']),
  })

  const byId = new Map(prepared.plan.rows.map((row) => [row.id, row]))
  assert.equal(byId.get('demo').action, 'skip')
  assert.equal(byId.get('demo').reason, 'not-a-profile-row')
  assert.equal(byId.get('ghost').action, 'push')
})

test('an empty config row is skipped with empty-config', async (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', {
    patchText: blockOf([
      { id: 'empty', config: {} },
      { id: 'filled', config: { mode: 'fast' } },
    ]),
  })
  makeProfile(home, 'desktop', { patchText: blockOf([]) })
  makeProfile(home, 'laptop', { patchText: blockOf([]) })

  const { ctx } = makeContext(home, {
    configuration: () => [rowOf('empty', {}), rowOf('filled', { mode: 'fast' }), rowOf('bare', {})],
  })
  const dumpTarget = async () => ({ ok: true, text: '', error: null })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states: statesFrom(home),
    dumpTarget,
  })

  const byId = new Map(prepared.plan.rows.map((row) => [row.id, row]))
  assert.equal(byId.get('empty').action, 'skip')
  assert.equal(byId.get('empty').reason, 'empty-config')
  assert.equal(byId.get('filled').action, 'push')
  // Membership is checked before emptiness: `bare` is not declared anywhere.
  assert.equal(byId.get('bare').action, 'skip')
  assert.equal(byId.get('bare').reason, 'not-a-profile-row')
})

test('a target dump that already matches the source is in sync', async (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', { patchText: blockOf([{ id: 'demo', config: { mode: 'fast' } }]) })
  makeProfile(home, 'desktop', { patchText: blockOf([{ id: 'demo', config: { mode: 'block-value' } }]) })

  const { ctx } = makeContext(home, { configuration: () => [rowOf('demo', { mode: 'fast' })] })
  const dumpTarget = async (options) => {
    assert.deepEqual(options, { dshBin: '/fake/dsh', profile: 'desktop' })
    return { ok: true, text: '- id: demo\n  config:\n    mode: fast\n', error: null }
  }

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf({ profiles: ['web', 'desktop'], sync: { enabled: true, targets: ['desktop'] } }),
    knownProfiles: ['web', 'desktop'],
    states: statesFrom(home, ['web', 'desktop']),
    dshBin: '/fake/dsh',
    dumpTarget,
  })

  assert.equal(prepared.ok, true)
  assert.deepEqual(prepared.warnings, [])
  assert.equal(prepared.plan.rows.length, 1)
  assert.equal(prepared.plan.rows[0].action, 'skip')
  assert.equal(prepared.plan.rows[0].reason, 'in-sync')
})

test('a target diff uses the dump value, not the managed-block value', async (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', { patchText: blockOf([{ id: 'demo', config: { mode: 'fast' } }]) })
  makeProfile(home, 'desktop', { patchText: blockOf([{ id: 'demo', config: { mode: 'block-value' } }]) })

  const { ctx } = makeContext(home, { configuration: () => [rowOf('demo', { mode: 'fast' })] })
  const dumpTarget = async () => ({
    ok: true,
    text: '- id: demo\n  config:\n    mode: old-value\n',
    error: null,
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf({ profiles: ['web', 'desktop'], sync: { enabled: true, targets: ['desktop'] } }),
    knownProfiles: ['web', 'desktop'],
    states: statesFrom(home, ['web', 'desktop']),
    dshBin: '/fake/dsh',
    dumpTarget,
  })

  const row = prepared.plan.rows.find((entry) => entry.id === 'demo')
  assert.equal(row.action, 'push')
  assert.deepEqual(row.changes, [{ profile: 'desktop', path: ['mode'], from: 'old-value', to: 'fast' }])
  assert.equal(JSON.stringify(prepared.plan).includes('block-value'), false, 'the block value is never diffed')
})

test('a failed target dump falls back to the managed block with a warning', async (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', { patchText: blockOf([{ id: 'demo', config: { mode: 'fast' } }]) })
  makeProfile(home, 'desktop', { patchText: blockOf([{ id: 'demo', config: { mode: 'slow' } }]) })
  makeProfile(home, 'laptop', { patchText: blockOf([{ id: 'demo', config: { mode: 'slow' } }]) })

  const { ctx } = makeContext(home, { configuration: () => [rowOf('demo', { mode: 'fast' })] })
  const dumpTarget = async ({ profile }) => {
    if (profile === 'desktop') return { ok: false, text: '', error: 'dump-config exploded' }
    throw new Error('binary is missing')
  }

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states: statesFrom(home),
    dshBin: '/fake/dsh',
    dumpTarget,
  })

  assert.equal(prepared.ok, true)
  assert.deepEqual(prepared.warnings, [
    'effective config for desktop is unavailable (dump-config exploded); diffs use its managed block',
    'effective config for laptop is unavailable (binary is missing); diffs use its managed block',
  ])
  const row = prepared.plan.rows.find((entry) => entry.id === 'demo')
  assert.equal(row.action, 'push')
  for (const change of row.changes) assert.equal(change.from, 'slow', 'the managed block supplied the target value')
})

// ---------------------------------------------------------------------------
// P2: target availability gate, baseline passthrough and field-level merge
// ---------------------------------------------------------------------------

/** One runtime configuration row that names the plugin package it configures. */
function pluginRowOf(id, name, config) {
  return { entry: { options: { id, name }, fiber: { config } } }
}

/** A `readProfileState()`-shaped state with installed packages and versions. */
function pkgState(home, profile, { installed = [], versions = {}, patchText = blockOf([]) } = {}) {
  return {
    name: profile,
    dir: join(home, 'profiles', profile),
    present: true,
    bundles: [...installed],
    dependencies: {},
    patchText,
    installed: new Set(installed),
    versions: new Map(Object.entries(versions)),
    sources: new Map(),
    rowIds: new Set(),
  }
}

/** profile -> pkgState, as `buildSnapshot()` passes to prepareSync. */
function gatedStates(home, entries) {
  return new Map(Object.entries(entries).map(([profile, spec]) => [profile, pkgState(home, profile, spec)]))
}

/** A target dump whose single row has `config`. */
function dumpedRow(id, config) {
  return async () => ({ ok: true, text: stringifyYaml([{ id, config }]), error: null })
}

test('a named row skips a target that does not have the plugin installed', async (t) => {
  const home = makeHome(t)
  const { ctx } = makeContext(home, {
    configuration: () => [pluginRowOf('demo', 'demo-plugin', { mode: 'fast' })],
  })
  const states = gatedStates(home, {
    web: { installed: ['demo-plugin'], versions: { 'demo-plugin': '1.0.0' } },
    desktop: { installed: [], versions: {} },
    laptop: { installed: ['demo-plugin'], versions: { 'demo-plugin': '1.0.0' } },
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states,
    dumpTarget: dumpedRow('demo', { mode: 'slow' }),
    baseline: {},
  })

  assert.equal(prepared.ok, true)
  const row = prepared.plan.rows.find((entry) => entry.id === 'demo')
  assert.equal(row.action, 'push')
  assert.deepEqual(row.targets, ['laptop'], 'the profile without the package is dropped')
  assert.deepEqual(row.skippedTargets, [{ profile: 'desktop', reason: 'plugin-missing' }])
  assert.deepEqual(row.changes.map((change) => change.profile), ['laptop'])
  assert.deepEqual(prepared.merged.items.find((item) => item.id === 'demo')?.scope, ['laptop'])
  assert.deepEqual(prepared.warnings, [])
})

test('a row whose every target lacks the plugin is skipped as plugin-missing', async (t) => {
  const home = makeHome(t)
  const { ctx } = makeContext(home, {
    configuration: () => [pluginRowOf('demo', 'demo-plugin', { mode: 'fast' })],
  })
  const states = gatedStates(home, {
    web: { installed: ['demo-plugin'], versions: { 'demo-plugin': '1.0.0' } },
    desktop: { installed: [], versions: {} },
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf({ profiles: ['web', 'desktop'], sync: { enabled: true, targets: ['desktop'] } }),
    knownProfiles: ['web', 'desktop'],
    states,
    dumpTarget: dumpedRow('demo', { mode: 'slow' }),
    baseline: {},
  })

  const row = prepared.plan.rows.find((entry) => entry.id === 'demo')
  assert.equal(row.action, 'skip')
  assert.equal(row.reason, 'plugin-missing')
  assert.deepEqual(row.targets, [])
  assert.deepEqual(row.changes, [])
  assert.deepEqual(row.skippedTargets, [{ profile: 'desktop', reason: 'plugin-missing' }])
  assert.equal(prepared.merged.items.some((item) => item.id === 'demo'), false)
})

test('a version mismatch warns but still pushes', async (t) => {
  const home = makeHome(t)
  const { ctx } = makeContext(home, {
    configuration: () => [pluginRowOf('demo', 'demo-plugin', { mode: 'fast' })],
  })
  const states = gatedStates(home, {
    web: { installed: ['demo-plugin'], versions: { 'demo-plugin': '1.0.0' } },
    desktop: { installed: ['demo-plugin'], versions: { 'demo-plugin': '2.0.0' } },
    laptop: { installed: ['demo-plugin'], versions: { 'demo-plugin': '1.0.0' } },
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states,
    dumpTarget: dumpedRow('demo', { mode: 'slow' }),
    baseline: {},
  })

  assert.deepEqual(prepared.warnings, [
    'version mismatch for demo on desktop: 1.0.0 -> 2.0.0',
  ])
  const row = prepared.plan.rows.find((entry) => entry.id === 'demo')
  assert.equal(row.action, 'push')
  assert.deepEqual(row.targets, ['desktop', 'laptop'], 'a version mismatch never blocks the push')
  assert.deepEqual(row.skippedTargets, undefined)
})

test('a nameless built-in row is never availability-gated', async (t) => {
  const home = makeHome(t)
  const { ctx } = makeContext(home, {
    configuration: () => [rowOf('demo', { mode: 'fast' })],
  })
  const states = gatedStates(home, {
    web: { installed: [], versions: {} },
    desktop: { installed: [], versions: {} },
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf({ profiles: ['web', 'desktop'], sync: { enabled: true, targets: ['desktop'] } }),
    knownProfiles: ['web', 'desktop'],
    states,
    dumpTarget: dumpedRow('demo', { mode: 'slow' }),
    baseline: {},
  })

  const row = prepared.plan.rows.find((entry) => entry.id === 'demo')
  assert.equal(row.action, 'push')
  assert.deepEqual(row.targets, ['desktop'])
  assert.equal('skippedTargets' in row, false)
})

test('prepareSync passes the baseline through and preserves target-local fields', async (t) => {
  const home = makeHome(t)
  const sourceConfig = { mode: 'fast', token: 'secret' }
  const { ctx } = makeContext(home, {
    configuration: () => [rowOf('demo', sourceConfig)],
  })
  const states = gatedStates(home, {
    web: {},
    desktop: { patchText: blockOf([{ id: 'demo', config: { mode: 'slow', token: 'local' } }]) },
  })
  const targetDump = async () => ({
    ok: true,
    text: stringifyYaml([{ id: 'demo', config: { mode: 'slow', token: 'local' } }]),
    error: null,
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf({ profiles: ['web', 'desktop'], sync: { enabled: true, targets: ['desktop'] } }),
    knownProfiles: ['web', 'desktop'],
    states,
    dumpTarget: targetDump,
    baseline: { demo: { desktop: { mode: 'slow', token: 'secret' } } },
  })

  assert.deepEqual(prepared.warnings, [])
  const row = prepared.plan.rows.find((entry) => entry.id === 'demo')
  assert.deepEqual(row, {
    id: 'demo',
    targets: ['desktop'],
    action: 'push',
    changes: [{ profile: 'desktop', path: ['mode'], from: 'slow', to: 'fast' }],
  })
  // The target edited `token` itself; the push writes only `mode` and keeps it.
  assert.deepEqual(prepared.merged.items, [
    { id: 'demo', scope: ['desktop'], config: { mode: 'fast', token: 'local' }, origin: 'sync' },
  ])
  assert.deepEqual(prepared.baselineEntries, [
    { id: 'demo', profile: 'desktop', config: sourceConfig },
  ])

  // Without a baseline the same fixtures fall back to the P1 two-way diff.
  const legacy = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf({ profiles: ['web', 'desktop'], sync: { enabled: true, targets: ['desktop'] } }),
    knownProfiles: ['web', 'desktop'],
    states,
    dumpTarget: targetDump,
  })
  assert.deepEqual(legacy.plan.rows.find((entry) => entry.id === 'demo').changes, [
    { profile: 'desktop', path: ['mode'], from: 'slow', to: 'fast' },
    { profile: 'desktop', path: ['token'], from: 'local', to: 'secret' },
  ])
  assert.deepEqual(legacy.merged.items[0].config, sourceConfig)
})

test('a conflict row produces no sync item and therefore no write', async (t) => {
  const home = makeHome(t)
  const { ctx } = makeContext(home, {
    configuration: () => [rowOf('demo', { mode: 'fast' })],
  })
  const states = gatedStates(home, {
    web: {},
    desktop: { patchText: blockOf([{ id: 'demo', config: { mode: 'local' } }]) },
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf({ profiles: ['web', 'desktop'], sync: { enabled: true, targets: ['desktop'] } }),
    knownProfiles: ['web', 'desktop'],
    states,
    dumpTarget: dumpedRow('demo', { mode: 'local' }),
    baseline: { demo: { desktop: { mode: 'slow' } } },
  })

  const row = prepared.plan.rows.find((entry) => entry.id === 'demo')
  assert.equal(row.action, 'conflict')
  assert.deepEqual(row.conflicts, [
    { profile: 'desktop', path: ['mode'], base: 'slow', source: 'fast', target: 'local' },
  ])
  assert.equal(
    prepared.merged.items.some((item) => item.origin === 'sync'),
    false,
    'a withheld row never reaches the manifest that apply writes',
  )
  assert.deepEqual(prepared.baselineEntries, [])
})

test('three-way merge splits an item when the targets keep different local fields', async (t) => {
  const home = makeHome(t)
  const { ctx } = makeContext(home, {
    configuration: () => [rowOf('demo', { mode: 'fast', token: 'secret' })],
  })
  const states = gatedStates(home, {
    web: {},
    desktop: { patchText: blockOf([{ id: 'demo', config: { mode: 'slow', token: 'desktop' } }]) },
    laptop: { patchText: blockOf([{ id: 'demo', config: { mode: 'slow', token: 'laptop' } }]) },
  })
  const dumpTarget = async ({ profile }) => ({
    ok: true,
    text: stringifyYaml([
      {
        id: 'demo',
        config: { mode: 'slow', token: profile === 'desktop' ? 'desktop' : 'laptop' },
      },
    ]),
    error: null,
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states,
    dumpTarget,
    baseline: { demo: { desktop: { mode: 'slow', token: 'secret' }, laptop: { mode: 'slow', token: 'secret' } } },
  })

  assert.deepEqual(prepared.plan.rows.find((row) => row.id === 'demo').changes, [
    { profile: 'desktop', path: ['mode'], from: 'slow', to: 'fast' },
    { profile: 'laptop', path: ['mode'], from: 'slow', to: 'fast' },
  ])
  assert.deepEqual(prepared.merged.items, [
    { id: 'demo', scope: ['desktop'], config: { mode: 'fast', token: 'desktop' }, origin: 'sync' },
    { id: 'demo', scope: ['laptop'], config: { mode: 'fast', token: 'laptop' }, origin: 'sync' },
  ])
})

test('a mixed first-sync row preserves the target that does have a baseline', async (t) => {
  const home = makeHome(t)
  const { ctx } = makeContext(home, {
    configuration: () => [rowOf('demo', { mode: 'fast', token: 'secret' })],
  })
  const states = gatedStates(home, {
    web: {},
    desktop: { patchText: blockOf([{ id: 'demo', config: { mode: 'slow', token: 'desktop' } }]) },
    laptop: { patchText: blockOf([{ id: 'demo', config: { mode: 'slow' } }]) },
  })
  const dumpTarget = async ({ profile }) => ({
    ok: true,
    text: stringifyYaml([
      { id: 'demo', config: profile === 'desktop' ? { mode: 'slow', token: 'desktop' } : { mode: 'slow' } },
    ]),
    error: null,
  })

  const prepared = await prepareSync({
    ctx,
    env: { home, currentProfile: 'web' },
    manifest: manifestOf(),
    knownProfiles: KNOWN,
    states,
    dumpTarget,
    baseline: { demo: { desktop: { mode: 'slow', token: 'secret' } } },
  })

  const row = prepared.plan.rows.find((entry) => entry.id === 'demo')
  assert.equal(row.firstSync, true, 'the laptop target has no ancestor')
  assert.deepEqual(prepared.merged.items, [
    { id: 'demo', scope: ['desktop'], config: { mode: 'fast', token: 'desktop' }, origin: 'sync' },
    { id: 'demo', scope: ['laptop'], config: { mode: 'fast', token: 'secret' }, origin: 'sync' },
  ])
})
