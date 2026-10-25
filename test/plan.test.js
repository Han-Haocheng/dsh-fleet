import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import YAML from 'yaml'

import {
  applyPlan,
  buildPlan,
} from '../lib/plan.js'
import { readProfileState, writeProfileFiles } from '../lib/profile.js'
import { extractManagedBlock, renderManagedBlock } from '../lib/render.js'
import { readTextFile } from '../lib/util.js'
import {
  baseManifest,
  makeHome,
  makeInstallation,
  makeProfile,
  writePackage,
  writeTextFile,
} from './helpers.js'

const BASE_BUNDLE = {
  '@deepseek-ai/dsh-base': {
    version: '0.1.0',
    patch: '- insert:\n    - id: base-row\n    - id: web\n      name: "@deepseek-ai/dsh-web"\n',
  },
}

/** Read states for every manifest profile as a Map. */
function readStates(home, install, profiles) {
  const states = new Map()
  for (const profile of profiles) {
    states.set(profile, readProfileState(home, profile, { installAnchor: install }))
  }
  return states
}

test('buildPlan reports missing blocks, bundle changes and pending installs', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, BASE_BUNDLE)
  makeProfile(home, 'web', { bundles: ['@deepseek-ai/dsh-base'] })
  makeProfile(home, 'desktop', { bundles: ['@deepseek-ai/dsh-base'] })
  const manifest = baseManifest({
    profiles: ['web', 'desktop'],
    bundles: [{ name: 'dsh-mnemon', spec: 'dsh-mnemon@1.0.0', scope: ['all'] }],
    items: [{ id: 'web', name: '@deepseek-ai/dsh-web', scope: ['web'], config: { searchProvider: 'ddg' } }],
  })
  const known = manifest.profiles
  const states = readStates(home, install, known)

  const plan = buildPlan({ manifest, knownProfiles: known, states, capabilities: () => 'cli' })
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.pendingInstalls, [
    { profile: 'web', bundle: 'dsh-mnemon', spec: 'dsh-mnemon@1.0.0', capability: 'cli' },
    { profile: 'desktop', bundle: 'dsh-mnemon', spec: 'dsh-mnemon@1.0.0', capability: 'cli' },
  ])
  const kinds = (profile) => plan.changes.filter((change) => change.profile === profile).map((change) => change.kind)
  assert.deepEqual(kinds('web').sort(), ['bundles', 'install', 'patch'])
  assert.deepEqual(kinds('desktop').sort(), ['bundles', 'install', 'patch'])
  const patchChange = plan.changes.find((change) => change.profile === 'web' && change.kind === 'patch')
  assert.equal(patchChange.detail, 'managed block is missing')
})

test('buildPlan never writes to disk', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, BASE_BUNDLE)
  const dir = makeProfile(home, 'web', { bundles: ['@deepseek-ai/dsh-base'], patchText: '# keep me\n' })
  const manifest = baseManifest({ profiles: ['web'], items: [{ id: 'web', scope: ['web'], config: {} }] })
  const states = readStates(home, install, manifest.profiles)
  buildPlan({ manifest, knownProfiles: manifest.profiles, states })
  assert.equal(readTextFile(join(dir, 'cordis.patch.yml')), '# keep me\n')
})

test('buildPlan reports an unknown profile', () => {
  const manifest = baseManifest({
    profiles: ['web', 'staging'],
    items: [],
  })
  const plan = buildPlan({
    manifest,
    knownProfiles: ['web'],
    states: new Map([['web', { name: 'web', dir: '/tmp/web', present: true, bundles: [], dependencies: {}, patchText: '', installed: new Set(), rowIds: new Set() }]]),
  })
  assert.ok(plan.errors.some((error) => /unknown profile "staging"/.test(error)))
})

test('buildPlan surfaces manifest validation errors', () => {
  const manifest = baseManifest({
    profiles: ['web'],
    providers: [{ key: 'openmodel', scope: ['all'], config: {} }],
    items: [
      { id: 'agent-default-model', scope: ['all'], config: { provider: 'ghost-provider' } },
      { id: 'other', scope: ['all'], config: {}, requires: ['ghost-bundle'] },
    ],
  })
  const plan = buildPlan({
    manifest,
    knownProfiles: ['web'],
    states: new Map([['web', { name: 'web', dir: '/tmp/web', present: true, bundles: [], dependencies: {}, patchText: '', installed: new Set(), rowIds: new Set() }]]),
  })
  assert.ok(plan.errors.some((error) => /is not a provider in this manifest/.test(error)))
  assert.ok(plan.errors.some((error) => /"ghost-bundle" is not a bundle/.test(error)))
  assert.ok(plan.errors.some((error) => /must declare the "llm-pi-ai" item/.test(error)))
})

test('buildPlan accepts states as a Map, a name-keyed object or an array', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, BASE_BUNDLE)
  makeProfile(home, 'web', { bundles: ['@deepseek-ai/dsh-base'] })
  const manifest = baseManifest({ profiles: ['web'], items: [{ id: 'web', scope: ['web'], config: {} }] })
  const states = readStates(home, install, ['web'])
  const state = states.get('web')
  const expected = JSON.stringify(buildPlan({ manifest, knownProfiles: ['web'], states }).changes)
  assert.equal(JSON.stringify(buildPlan({ manifest, knownProfiles: ['web'], states: { web: state } }).changes), expected)
  assert.equal(JSON.stringify(buildPlan({ manifest, knownProfiles: ['web'], states: [state] }).changes), expected)
})

test('buildPlan flags an incomplete managed block', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, BASE_BUNDLE)
  const patchText = '# >>> dsh-fleet v1 sha256:abc —— generated from ~/.dsh/fleet.yml, do not edit\n- id: stale\n'
  makeProfile(home, 'web', { bundles: ['@deepseek-ai/dsh-base'], patchText })
  const manifest = baseManifest({ profiles: ['web'], items: [{ id: 'web', scope: ['web'], config: {} }] })
  const plan = buildPlan({ manifest, knownProfiles: ['web'], states: readStates(home, install, ['web']) })
  const patchChange = plan.changes.find((change) => change.kind === 'patch')
  assert.match(patchChange.detail, /incomplete/)
})

test('buildPlan marks a profile with no state as skipped', () => {
  const manifest = baseManifest({ profiles: ['web'], items: [] })
  const plan = buildPlan({ manifest, knownProfiles: ['web'], states: new Map() })
  const change = plan.changes.find((item) => item.profile === 'web')
  assert.equal(change.kind, 'manifest')
  assert.match(change.detail, /state is unavailable/)
})

test('buildPlan rejects a missing manifest', () => {
  const plan = buildPlan({ manifest: null, knownProfiles: ['web'], states: new Map() })
  assert.deepEqual(plan.changes, [])
  assert.match(plan.errors[0], /manifest: missing/)
})

test('plan -> apply -> plan reaches an idempotent in-sync state', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, BASE_BUNDLE)
  const userPatch = '# my own layer\n- id: base-row\n  disabled: false\n'
  makeProfile(home, 'web', {
    bundles: ['@deepseek-ai/dsh-base'],
    dependencies: { 'dsh-mnemon': '1.0.0' },
    patchText: userPatch,
  })
  const manifest = baseManifest({
    profiles: ['web'],
    bundles: [{ name: 'dsh-mnemon', spec: 'dsh-mnemon@1.0.0', scope: ['web'] }],
    items: [{ id: 'web', name: '@deepseek-ai/dsh-web', scope: ['web'], config: { searchProvider: 'ddg' } }],
  })
  const known = manifest.profiles
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')

  let states = readStates(home, install, known)
  const first = buildPlan({ manifest, knownProfiles: known, states, capabilities: () => 'service' })
  assert.deepEqual(first.errors, [])
  assert.equal(first.pendingInstalls.length, 1)
  assert.deepEqual(first.pendingInstalls[0], {
    profile: 'web',
    bundle: 'dsh-mnemon',
    spec: 'dsh-mnemon@1.0.0',
    capability: 'service',
  })

  // Simulate the install that precedes apply; the plan is recomputed after it.
  writePackage(join(home, 'profiles', 'web', 'node_modules'), 'dsh-mnemon', {
    version: '1.0.0',
    patch: '- insert:\n    - id: mnemon\n',
  })
  states = readStates(home, install, known)
  const second = buildPlan({ manifest, knownProfiles: known, states, capabilities: () => 'service' })
  assert.deepEqual(second.errors, [])
  assert.deepEqual(second.pendingInstalls, [])
  assert.equal(readTextFile(patchPath), userPatch, 'planning must not write')

  const applied = applyPlan({ manifest, knownProfiles: known, states, plan: second })
  assert.deepEqual(applied.errors, [])
  assert.equal(applied.written.length, 1)
  assert.deepEqual(applied.written[0].bundles, ['@deepseek-ai/dsh-base', 'dsh-mnemon'])
  assert.equal(applied.backups.length, 2)
  assert.ok(applied.backups.every((path) => path.includes('.bak-fleet-')))

  const patchAfter = readTextFile(patchPath)
  assert.ok(patchAfter.startsWith(userPatch), 'text outside the managed block stays untouched')
  const block = extractManagedBlock(patchAfter)
  assert.notEqual(block, null)
  assert.equal(block.complete, true)
  const rendered = renderManagedBlock({
    manifest,
    profile: 'web',
    knownProfiles: known,
    rowExists: (_profile, rowId) => states.get('web').rowIds.has(rowId),
  })
  assert.equal(block.hash, rendered.hash)
  assert.deepEqual(YAML.parse(block.text), rendered.entries)
  assert.ok(patchAfter.includes('- id: web'))

  const manifestAfter = JSON.parse(readTextFile(join(home, 'profiles', 'web', 'package.json')))
  assert.deepEqual(manifestAfter.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-mnemon'])
  assert.deepEqual(manifestAfter.dependencies, { 'dsh-mnemon': '1.0.0' })

  states = readStates(home, install, known)
  const third = buildPlan({ manifest, knownProfiles: known, states })
  assert.deepEqual(third.changes, [])
  const reapplied = applyPlan({ manifest, knownProfiles: known, states, plan: third })
  assert.deepEqual(reapplied.written, [])
  assert.deepEqual(reapplied.backups, [])
  assert.equal(readTextFile(patchPath), patchAfter)
})

test('applyPlan replaces only the managed block and keeps surrounding comments', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, BASE_BUNDLE)
  makeProfile(home, 'web', { bundles: ['@deepseek-ai/dsh-base'], patchText: '# head\n- id: base-row\n  disabled: false\n' })
  const known = ['web']
  const baseManifestObject = baseManifest({
    profiles: known,
    items: [{ id: 'web', name: '@deepseek-ai/dsh-web', scope: ['web'], config: { searchProvider: 'ddg' } }],
  })
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')

  let states = readStates(home, install, known)
  applyPlan({ manifest: baseManifestObject, knownProfiles: known, states, plan: buildPlan({ manifest: baseManifestObject, knownProfiles: known, states }) })
  const firstText = readTextFile(patchPath)
  assert.ok(firstText.startsWith('# head\n- id: base-row\n  disabled: false'))

  writeTextFile(patchPath, `${firstText}# trailing note\n`)
  const expanded = baseManifest({
    profiles: known,
    items: [
      { id: 'web', name: '@deepseek-ai/dsh-web', scope: ['web'], config: { searchProvider: 'ddg' } },
      { id: 'ui-theme', scope: ['web'], config: { fontSize: 16 } },
    ],
  })
  states = readStates(home, install, known)
  const plan = buildPlan({ manifest: expanded, knownProfiles: known, states })
  assert.ok(plan.changes.some((change) => change.kind === 'patch'))
  applyPlan({ manifest: expanded, knownProfiles: known, states, plan })
  const after = readTextFile(patchPath)
  assert.ok(after.startsWith('# head\n- id: base-row\n  disabled: false'))
  assert.ok(after.endsWith('# trailing note\n'))
  assert.ok(after.includes('- id: ui-theme'))
  assert.equal(after.split('# >>> dsh-fleet').length - 1, 1, 'exactly one managed block')
})

test('applyPlan writes only the profiles named by plan.changes', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, BASE_BUNDLE)
  makeProfile(home, 'web', { bundles: ['@deepseek-ai/dsh-base'] })
  makeProfile(home, 'desktop', { bundles: ['@deepseek-ai/dsh-base'] })
  const manifest = baseManifest({ profiles: ['web', 'desktop'], items: [{ id: 'web', scope: ['all'], config: {} }] })
  const known = manifest.profiles
  const states = readStates(home, install, known)
  const plan = buildPlan({ manifest, knownProfiles: known, states })
  const webOnly = { ...plan, changes: plan.changes.filter((change) => change.profile === 'web') }
  const applied = applyPlan({ manifest, knownProfiles: known, states, plan: webOnly })
  assert.deepEqual(applied.errors, [])
  assert.equal(applied.written.length, 1)
  assert.equal(applied.written[0].profile, 'web')
  assert.ok(readTextFile(join(home, 'profiles', 'web', 'cordis.patch.yml')).includes('# >>> dsh-fleet'))
  assert.equal(readTextFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml')), null)
})

test('applyPlan refuses a plan with errors and writes nothing', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, BASE_BUNDLE)
  makeProfile(home, 'web', { bundles: ['@deepseek-ai/dsh-base'], patchText: '# untouched\n' })
  const known = ['web']
  const manifest = baseManifest({ profiles: known, items: [{ id: 'web', scope: ['all'], config: {} }] })
  const states = readStates(home, install, known)
  const plan = { changes: [{ profile: 'web', kind: 'patch', detail: 'x' }], errors: ['manifest: broken'] }
  const result = applyPlan({ manifest, knownProfiles: known, states, plan })
  assert.deepEqual(result.errors, ['manifest: broken'])
  assert.deepEqual(result.written, [])
  assert.deepEqual(result.backups, [])
  assert.equal(readTextFile(join(home, 'profiles', 'web', 'cordis.patch.yml')), '# untouched\n')
})

test('applyPlan reports a profile that has no directory', (t) => {
  const home = makeHome(t)
  const manifest = baseManifest({ profiles: ['web'], items: [] })
  const plan = { changes: [{ profile: 'web', kind: 'manifest', detail: 'x' }], errors: [] }
  const states = new Map([['web', {
    name: 'web',
    dir: join(home, 'profiles', 'web'),
    present: false,
    bundles: [],
    dependencies: {},
    patchText: '',
    installed: new Set(),
    rowIds: new Set(),
  }]])
  const result = applyPlan({ manifest, knownProfiles: ['web'], states, plan })
  assert.match(result.errors[0], /does not exist/)
  assert.deepEqual(result.written, [])
})

test('applyPlan reports missing state and missing plan', (t) => {
  const home = makeHome(t)
  const manifest = baseManifest({ profiles: ['web'], items: [] })
  const plan = { changes: [{ profile: 'web', kind: 'patch', detail: 'x' }], errors: [] }
  const noState = applyPlan({ manifest, knownProfiles: ['web'], states: new Map(), plan })
  assert.match(noState.errors[0], /state is unavailable/)

  const noPlan = applyPlan({ manifest, knownProfiles: ['web'], states: new Map() })
  assert.match(noPlan.errors[0], /plan: missing/)

  const noManifest = applyPlan({ manifest: null, knownProfiles: ['web'], states: new Map(), plan })
  assert.match(noManifest.errors[0], /manifest: missing/)
})

test('enforce out-of-scope cleanup is applied and stays stable', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, BASE_BUNDLE)
  makeProfile(home, 'web', {
    bundles: ['@deepseek-ai/dsh-base'],
    patchText: '- insert:\n    - id: tui-row\n',
  })
  makeProfile(home, 'dsh-tui', { bundles: ['@deepseek-ai/dsh-base'] })
  const manifest = baseManifest({
    profiles: ['web', 'dsh-tui'],
    items: [{ id: 'tui-row', scope: ['dsh-tui'], enforce: true, config: { a: 1 } }],
  })
  const known = manifest.profiles
  let states = readStates(home, install, known)
  const plan = buildPlan({ manifest, knownProfiles: known, states })
  assert.deepEqual(plan.errors, [])
  assert.ok(plan.changes.some((change) => change.profile === 'web' && change.kind === 'patch'))
  applyPlan({ manifest, knownProfiles: known, states, plan })

  const webBlock = extractManagedBlock(readTextFile(join(home, 'profiles', 'web', 'cordis.patch.yml')))
  assert.deepEqual(YAML.parse(webBlock.text), [{ id: 'tui-row', disabled: true }])
  const tuiBlock = extractManagedBlock(readTextFile(join(home, 'profiles', 'dsh-tui', 'cordis.patch.yml')))
  assert.deepEqual(YAML.parse(tuiBlock.text), [{ id: 'tui-row', config: { a: 1 } }])

  states = readStates(home, install, known)
  const after = buildPlan({ manifest, knownProfiles: known, states })
  assert.deepEqual(after.changes, [])
})

test('writeProfileFiles leaves freshly created files without backups', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, BASE_BUNDLE)
  makeProfile(home, 'web', { bundles: ['@deepseek-ai/dsh-base'] })
  const known = ['web']
  const manifest = baseManifest({ profiles: known, items: [{ id: 'web', scope: ['all'], config: {} }] })
  let states = readStates(home, install, known)
  const plan = buildPlan({ manifest, knownProfiles: known, states })
  const first = applyPlan({ manifest, knownProfiles: known, states, plan })
  assert.deepEqual(first.errors, [])
  // The patch file is new and the manifest already lists the right bundles: nothing to back up.
  assert.deepEqual(first.backups, [])
  assert.ok(readTextFile(join(home, 'profiles', 'web', 'cordis.patch.yml')).includes('# >>> dsh-fleet'))

  states = readStates(home, install, known)
  const secondPlan = buildPlan({ manifest, knownProfiles: known, states })
  const second = applyPlan({ manifest, knownProfiles: known, states, plan: secondPlan })
  assert.deepEqual(second.backups, [])
  assert.deepEqual(second.errors, [])
})
