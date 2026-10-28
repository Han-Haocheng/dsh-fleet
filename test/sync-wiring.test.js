/**
 * P2 wiring: a real `apply` through the plugin's `fleet` tool records the sync
 * baseline only after a successful write, a dry run records nothing, a failed
 * apply leaves the previous baseline untouched, and `restore` clears it.
 *
 * The Host half is exercised with a fake Cordis context: only `profileContext`
 * and `configEditor` are services, `tools.register` captures the tool, and a
 * deliberately missing `dsh` binary makes target dumps fall back to the managed
 * block without ever spawning anything.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { apply } from '../index.js'
import { baselinePath, readBaseline, recordBaseline } from '../lib/sync-baseline.js'
import { BLOCK_FOOTER, BLOCK_HEADER_PREFIX, fileExists, stringifyYaml } from '../lib/util.js'
import { makeHome, makeProfile, writeTextFile } from './helpers.js'

const HEADER = `${BLOCK_HEADER_PREFIX} v1 sha256:${'0'.repeat(64)} —— generated from ~/.dsh/fleet.yml, do not edit`

/** A patch file whose managed block carries `rows`. */
function blockOf(rows) {
  return `${HEADER}\n${stringifyYaml(rows)}${BLOCK_FOOTER}\n`
}

/** The manifest the wiring tests apply: sync from web to desktop. */
const MANIFEST = {
  version: 1,
  profiles: ['web', 'desktop'],
  providers: [],
  bundles: [],
  items: [{ id: 'demo', scope: ['all'], config: { mode: 'slow' } }],
  sync: { enabled: true, targets: ['all'] },
}

/**
 * A fake Host context with a captured `fleet` tool. `configuration()` is the
 * live source rows; the target side always falls back to its managed block
 * because `dshCommand` points at a path that does not exist.
 */
function makeToolContext(home, { configuration = [] } = {}) {
  let tool
  const ctx = {
    get(name) {
      if (name === 'profileContext') {
        return { home, name: 'web', installAnchor: null, dir: join(home, 'profiles', 'web') }
      }
      if (name === 'configEditor') {
        // Accept either an array or a thunk, so each apply reads fresh rows.
        return { configuration: async () => (typeof configuration === 'function' ? configuration() : configuration) }
      }
      return undefined
    },
    inject(names, callback) {
      if (!names.includes('tools')) return
      callback({
        tools: {
          register(candidate) {
            tool = candidate
            return () => {}
          },
        },
        effect(run) {
          return run()
        },
      })
    },
    effect(run) {
      return run()
    },
    on() {},
    emit() {},
    logger: { warn() {} },
  }
  apply(ctx, {
    manifestPath: 'fleet.yml',
    dshCommand: '/nonexistent/dsh-binary',
    autoInstall: false,
    notifyOnDrift: false,
  })
  assert.ok(tool, 'the tools service received the fleet tool')
  return tool
}

/** Write the manifest at the location `resolveEnv()` reads. */
function writeManifest(home, manifest = MANIFEST) {
  writeTextFile(join(home, 'fleet.yml'), stringifyYaml(manifest))
}

/** One live runtime configuration row. */
function rowOf(id, config) {
  return { entry: { options: { id }, fiber: { config } } }
}

/** The default fixture: web is the source, desktop starts with a local value. */
function setupProfiles(t) {
  const home = makeHome(t)
  makeProfile(home, 'web', { patchText: blockOf([{ id: 'demo', config: { mode: 'fast' } }]) })
  makeProfile(home, 'desktop', { patchText: blockOf([{ id: 'demo', config: { mode: 'slow' } }]) })
  return home
}

test('apply records the pushed source config, dryRun and failures do not', async (t) => {
  const home = setupProfiles(t)
  writeManifest(home)
  const tool = makeToolContext(home, {
    configuration: () => [rowOf('demo', { mode: 'fast' })],
  })

  const preview = await tool.execute({ action: 'apply', profiles: ['desktop'], dryRun: true })
  assert.equal(preview.ok, true, JSON.stringify(preview.errors))
  assert.equal(preview.dryRun, true)
  assert.equal(fileExists(baselinePath(home)), false, 'a dry run never writes the baseline')

  const applied = await tool.execute({ action: 'apply', profiles: ['desktop'] })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.match(readFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), /mode: fast/)

  const recorded = readBaseline({ home })
  assert.equal(recorded.ok, true)
  assert.deepEqual(recorded.baseline.rows, {
    demo: { desktop: { mode: 'fast' } },
  })

  // A failed apply (desktop has no profile directory) returns before writing;
  // the baseline written above must still be the same object.
  const before = readFileSync(baselinePath(home), 'utf8')
  const broken = makeHome(t)
  writeManifest(broken)
  makeProfile(broken, 'web', { patchText: blockOf([{ id: 'demo', config: { mode: 'fast' } }]) })
  const brokenTool = makeToolContext(broken, {
    configuration: () => [rowOf('demo', { mode: 'fast' })],
  })
  const failed = await brokenTool.execute({ action: 'apply', profiles: ['desktop'] })
  assert.equal(failed.ok, false)
  assert.equal(fileExists(baselinePath(broken)), false, 'a failed apply must not create a baseline')
  assert.equal(readFileSync(baselinePath(home), 'utf8'), before)
})

test('restore clears the sync baseline after rolling the profiles back', async (t) => {
  const home = setupProfiles(t)
  writeManifest(home)
  const tool = makeToolContext(home, {
    configuration: () => [rowOf('demo', { mode: 'fast' })],
  })

  const applied = await tool.execute({ action: 'apply', profiles: ['desktop'] })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.equal(Object.keys(readBaseline({ home }).baseline.rows).length, 1)

  const restored = await tool.execute({ action: 'restore', profiles: ['desktop'] })
  assert.equal(restored.ok, true, JSON.stringify(restored.errors))
  assert.match(
    readFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'),
    /mode: slow/,
    'the pre-apply managed block is back',
  )
  assert.deepEqual(readBaseline({ home }).baseline.rows, {}, 'the ancestor no longer describes the profile')
})

test('a corrupt baseline aborts apply instead of planning every row as new', async (t) => {
  const home = setupProfiles(t)
  writeManifest(home)
  writeTextFile(baselinePath(home), '{ broken json')
  const tool = makeToolContext(home, {
    configuration: () => [rowOf('demo', { mode: 'fast' })],
  })

  const result = await tool.execute({ action: 'apply', profiles: ['desktop'] })
  assert.equal(result.ok, false)
  assert.match(result.errors[0], /sync baseline is unreadable/)
  assert.match(
    readFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'),
    /mode: slow/,
    'the target profile was not rewritten',
  )
})


test('apply writes only the changed fields and keeps each target local value', async (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', { patchText: blockOf([{ id: 'demo', config: { mode: 'fast', token: 'secret' } }]) })
  makeProfile(home, 'desktop', { patchText: blockOf([{ id: 'demo', config: { mode: 'slow', token: 'desktop' } }]) })
  makeProfile(home, 'laptop', { patchText: blockOf([{ id: 'demo', config: { mode: 'slow', token: 'laptop' } }]) })
  writeManifest(home, {
    ...MANIFEST,
    profiles: ['web', 'desktop', 'laptop'],
  })
  const sourceConfig = { mode: 'fast', token: 'secret' }
  const baseConfig = { mode: 'slow', token: 'secret' }
  recordBaseline({
    home,
    entries: [
      { id: 'demo', profile: 'desktop', config: baseConfig },
      { id: 'demo', profile: 'laptop', config: baseConfig },
    ],
  })

  const tool = makeToolContext(home, {
    configuration: () => [rowOf('demo', sourceConfig)],
  })
  const applied = await tool.execute({ action: 'apply', profiles: ['desktop', 'laptop'] })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))

  const desktopPatch = readFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
  const laptopPatch = readFileSync(join(home, 'profiles', 'laptop', 'cordis.patch.yml'), 'utf8')
  assert.match(desktopPatch, /mode: fast/)
  assert.match(desktopPatch, /token: desktop/, 'the target-local token survives the push')
  assert.match(laptopPatch, /mode: fast/)
  assert.match(laptopPatch, /token: laptop/)

  assert.deepEqual(readBaseline({ home }).baseline.rows, {
    demo: { desktop: sourceConfig, laptop: sourceConfig },
  })
})
