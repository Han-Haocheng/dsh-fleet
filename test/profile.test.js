import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  LOCK_STALE_MS,
  acquireLock,
  atomicWriteFile,
  backupFile,
  collectRowIds,
  discoverProfiles,
  homeFrom,
  readManifestFile,
  readProfileState,
  resolveBundlePackage,
  writeManifestFile,
  writeProfileFiles,
} from '../lib/profile.js'
import { listBackupFiles, readTextFile } from '../lib/util.js'
import {
  makeHome,
  makeInstallation,
  makeProfile,
  makeTempDir,
  writeJsonFile,
  writeTextFile,
} from './helpers.js'

test('homeFrom prefers $DSH_HOME and falls back to ~/.dsh', (t) => {
  const home = makeTempDir(t)
  assert.equal(homeFrom({}), join(homedir(), '.dsh'))
  assert.equal(homeFrom({ DSH_HOME: '' }), join(homedir(), '.dsh'))
  assert.equal(homeFrom({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
  assert.equal(homeFrom({ DSH_HOME: home }), home)
  assert.equal(homeFrom({ DSH_HOME: '~/custom-home' }), join(homedir(), 'custom-home'))
  assert.equal(homeFrom({ DSH_HOME: 'relative-home' }), join(process.cwd(), 'relative-home'))
})

test('discoverProfiles lists only initialized profiles, sorted', (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', { bundles: [] })
  makeProfile(home, 'dsh-tui', { bundles: [] })
  mkdirSync(join(home, 'profiles', 'node_modules', 'x'), { recursive: true })
  writeJsonFile(join(home, 'profiles', 'node_modules', 'x', 'package.json'), { name: 'x' })
  mkdirSync(join(home, 'profiles', 'half-made'))
  writeTextFile(join(home, 'profiles', 'half-made', 'cordis.patch.yml'), '[]\n')
  mkdirSync(join(home, 'profiles', '.hidden'))
  writeJsonFile(join(home, 'profiles', '.hidden', 'package.json'), { name: 'hidden' })
  assert.deepEqual(discoverProfiles(home), ['dsh-tui', 'web'])
  assert.deepEqual(discoverProfiles(join(home, 'does-not-exist')), [])
})

test('resolveBundlePackage prefers the installation and falls back to the profile', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, {
    '@deepseek-ai/dsh-base': { version: '9.9.9', patch: '- insert: []\n' },
  })
  const dir = makeProfile(home, 'web', {
    packages: {
      '@deepseek-ai/dsh-base': { version: '1.1.1', patch: '' },
      'local-bundle': { version: '2.2.2', patch: '' },
    },
  })
  assert.deepEqual(resolveBundlePackage('@deepseek-ai/dsh-base', dir, install), {
    installed: true,
    from: 'installation',
    version: '9.9.9',
  })
  assert.deepEqual(resolveBundlePackage('local-bundle', dir, install), {
    installed: true,
    from: 'profile',
    version: '2.2.2',
  })
  assert.deepEqual(resolveBundlePackage('missing-bundle', dir, install), {
    installed: false,
    from: null,
    version: null,
  })
  assert.deepEqual(resolveBundlePackage('@deepseek-ai/dsh-base', dir, null), {
    installed: true,
    from: 'profile',
    version: '1.1.1',
  })
  assert.equal(resolveBundlePackage('@deepseek-ai/dsh-base', dir, join(install, 'package.json')).from, 'installation')
})

test('readProfileState reads bundles, dependencies, patch text, installed packages and row ids', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, {
    '@deepseek-ai/dsh-base': {
      version: '0.1.0',
      patch: [
        '- insert:',
        '    - id: base-row',
        '    - id: base-group',
        '      group: true',
        '      config:',
        '        - id: base-child',
        '',
      ].join('\n'),
    },
  })
  const userPatch = [
    '# user layer',
    '- insert:',
    '    - id: user-row',
    '- id: base-row',
    '  name: "@deepseek-ai/dsh-web"',
    '',
  ].join('\n')
  const dir = makeProfile(home, 'web', {
    bundles: ['@deepseek-ai/dsh-base', 'dsh-mnemon', 'not-installed'],
    dependencies: { 'dsh-mnemon': '1.0.0', 'plain-dep': '2.0.0' },
    patchText: userPatch,
    packages: {
      'dsh-mnemon': {
        version: '1.0.0',
        patch: [
          '- insert:',
          '    - id: mnemon',
          '    - id: mnemon-bundle',
          '      group: true',
          '      config:',
          '        - id: mnemon-source',
          '',
        ].join('\n'),
      },
      'plain-dep': { version: '2.0.0' },
    },
  })

  const state = readProfileState(home, 'web', { installAnchor: install })
  assert.equal(state.name, 'web')
  assert.equal(state.dir, dir)
  assert.equal(state.present, true)
  assert.deepEqual(state.bundles, ['@deepseek-ai/dsh-base', 'dsh-mnemon', 'not-installed'])
  assert.deepEqual(state.dependencies, { 'dsh-mnemon': '1.0.0', 'plain-dep': '2.0.0' })
  assert.equal(state.patchText, userPatch)
  assert.ok(state.installed instanceof Set)
  assert.deepEqual([...state.installed].sort(), ['@deepseek-ai/dsh-base', 'dsh-mnemon', 'plain-dep'])
  assert.deepEqual(
    [...state.versions.entries()].sort(),
    [['@deepseek-ai/dsh-base', '0.1.0'], ['dsh-mnemon', '1.0.0'], ['plain-dep', '2.0.0']],
  )
  assert.ok(state.rowIds instanceof Set)
  for (const id of ['base-row', 'base-child', 'mnemon', 'mnemon-source', 'user-row']) {
    assert.ok(state.rowIds.has(id), `expected row id ${id}`)
  }
  assert.equal(state.error, undefined)
})

test('readProfileState reports a missing profile', (t) => {
  const home = makeHome(t)
  const state = readProfileState(home, 'ghost')
  assert.equal(state.present, false)
  assert.deepEqual(state.bundles, [])
  assert.deepEqual(state.dependencies, {})
  assert.equal(state.patchText, '')
  assert.equal(state.installed.size, 0)
  assert.equal(state.rowIds.size, 0)
})

test('readProfileState records an invalid manifest without throwing', (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', { bundles: [] })
  writeTextFile(join(home, 'profiles', 'web', 'package.json'), '{ not json')
  const state = readProfileState(home, 'web')
  assert.equal(state.present, true)
  assert.match(state.error, /invalid profile manifest/)
})

test('readProfileState rejects path traversal profile names', (t) => {
  const home = makeHome(t)
  assert.throws(() => readProfileState(home, '../escape'), /invalid profile name/)
})

test('collectRowIds replays inserts, groups, top-level insert objects and js-tagged rows', (t) => {
  const home = makeHome(t)
  const install = makeInstallation(t, {
    'bundle-a': {
      patch: [
        '- insert:',
        '    - id: a1',
        '      disabled: !!js "!ctx.get(\'profileContext\')"',
        '    - id: a-group',
        '      group: true',
        '      config:',
        '        - id: a-child',
        '',
      ].join('\n'),
    },
    'bundle-object': { patch: 'insert:\n  - id: obj-row\n' },
  })
  const dir = makeProfile(home, 'web', { bundles: [] })
  const patchText = [
    '- insert:',
    '    - id: patch-row',
    '- id: override-row',
    '  name: "@deepseek-ai/dsh-web"',
    '',
  ].join('\n')
  const ids = collectRowIds({
    bundles: ['bundle-a', 'bundle-object'],
    profileDir: dir,
    installAnchor: install,
    patchText,
  })
  assert.deepEqual([...ids].sort(), [
    'a-child',
    'a-group',
    'a1',
    'obj-row',
    'override-row',
    'patch-row',
  ])
})

test('collectRowIds skips patch files it cannot replay instead of throwing', (t) => {
  const install = makeInstallation(t, {
    'with-include': {
      patch: [
        '- insert:',
        '    - id: before',
        '    - id: include-row',
        '      name: "@deepseek-ai/cordis-plugin-include"',
        '',
      ].join('\n'),
    },
    unparsable: { patch: '- insert: [\n' },
  })
  const ids = collectRowIds({
    bundles: ['with-include', 'unparsable'],
    profileDir: join(makeTempDir(t), 'none'),
    installAnchor: install,
  })
  assert.deepEqual([...ids], [])
})

test('writeProfileFiles creates a fresh profile', (t) => {
  const home = makeHome(t)
  const result = writeProfileFiles({
    home,
    name: 'fresh',
    patchText: '# patch\n',
    bundles: ['bundle-a'],
    dependencies: {},
  })
  const manifest = JSON.parse(readTextFile(join(home, 'profiles', 'fresh', 'package.json')))
  assert.deepEqual(manifest.dsh.profile.bundles, ['bundle-a'])
  assert.equal(manifest.name, 'dsh-profile-fresh')
  assert.equal(readTextFile(join(home, 'profiles', 'fresh', 'cordis.patch.yml')), '# patch\n')
  assert.equal(result.files.length, 2)
  assert.deepEqual(result.backups, [])
})

test('writeProfileFiles preserves unrelated fields, merges dependencies and leaves the patch alone when unchanged', (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', {
    bundles: ['old'],
    dependencies: { keep: '1.0.0' },
    patchText: '# user layer\n- id: x\n',
    extraManifest: { scripts: { fleet: 'node scripts/fleet.mjs' }, pnpm: { onlyBuiltDependencies: ['a'] } },
  })
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
  const before = readTextFile(patchPath)

  const result = writeProfileFiles({
    home,
    name: 'web',
    patchText: before,
    bundles: ['new-a', 'new-b'],
    dependencies: { keep: '1.0.0', added: '2.0.0' },
  })
  const manifest = JSON.parse(readTextFile(join(home, 'profiles', 'web', 'package.json')))
  assert.deepEqual(manifest.dsh.profile.bundles, ['new-a', 'new-b'])
  assert.deepEqual(manifest.dependencies, { keep: '1.0.0', added: '2.0.0' })
  assert.deepEqual(manifest.scripts, { fleet: 'node scripts/fleet.mjs' })
  assert.deepEqual(manifest.pnpm, { onlyBuiltDependencies: ['a'] })
  assert.equal(manifest.name, 'dsh-profile-web')
  assert.equal(readTextFile(patchPath), before)
  assert.equal(result.files.length, 1)
  assert.equal(result.backups.length, 1)
  assert.match(result.backups[0], /package\.json\.bak-fleet-/)
})

test('writeProfileFiles is a no-op when nothing changes', (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', { bundles: ['a'], dependencies: { d: '1.0.0' }, patchText: '# p\n' })
  const first = writeProfileFiles({ home, name: 'web', patchText: '# p\n', bundles: ['a'] })
  assert.deepEqual(first.files, [])
  assert.deepEqual(first.backups, [])
  const manifest = JSON.parse(readTextFile(join(home, 'profiles', 'web', 'package.json')))
  assert.deepEqual(manifest.dependencies, { d: '1.0.0' })
})

test('writeProfileFiles keeps at most five backups per file', (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', { bundles: [], patchText: 'v0\n' })
  for (let index = 1; index <= 7; index += 1) {
    writeProfileFiles({ home, name: 'web', patchText: `v${index}\n`, bundles: [] })
  }
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
  assert.equal(readTextFile(patchPath), 'v7\n')
  assert.equal(listBackupFiles(patchPath).length, 5)
})

test('writeProfileFiles refuses an invalid existing manifest', (t) => {
  const home = makeHome(t)
  makeProfile(home, 'web', { bundles: [] })
  writeTextFile(join(home, 'profiles', 'web', 'package.json'), '{ nope')
  assert.throws(
    () => writeProfileFiles({ home, name: 'web', patchText: '', bundles: [] }),
    /invalid profile manifest/,
  )
})

test('readManifestFile returns text:null for a missing manifest', (t) => {
  const home = makeHome(t)
  const result = readManifestFile(home)
  assert.equal(result.text, null)
  assert.equal(result.path, join(home, 'fleet.yml'))
})

test('writeManifestFile writes atomically and backs the previous version up', (t) => {
  const home = makeHome(t)
  const first = writeManifestFile(home, 'version: 1\n')
  assert.equal(first.backup, null)
  assert.equal(readManifestFile(home).text, 'version: 1\n')
  const second = writeManifestFile(home, 'version: 2\n')
  assert.notEqual(second.backup, null)
  assert.equal(readTextFile(second.backup), 'version: 1\n')
  assert.equal(readManifestFile(home).text, 'version: 2\n')
})

test('acquireLock grants one owner and releases idempotently', (t) => {
  const home = makeHome(t)
  const lockPath = join(home, 'fleet.lock')
  const first = acquireLock(home, { owner: 'fleet-cli:123' })
  assert.equal(first.ok, true)
  assert.equal(first.owner, 'fleet-cli:123')
  const record = JSON.parse(readTextFile(lockPath))
  assert.equal(record.owner, 'fleet-cli:123')
  assert.equal(record.pid, process.pid)
  assert.match(record.startedAt, /^\d{4}-\d{2}-\d{2}T/)

  const second = acquireLock(home, { owner: 'other' })
  assert.equal(second.ok, false)
  assert.equal(second.owner, 'fleet-cli:123')
  second.release()

  first.release()
  first.release()
  assert.equal(existsSync(lockPath), false)

  const again = acquireLock(home, { owner: 'again' })
  assert.equal(again.ok, true)
  again.release()
})

test('acquireLock defaults its owner label to the pid', (t) => {
  const home = makeHome(t)
  const lock = acquireLock(home)
  assert.equal(lock.ok, true)
  assert.equal(lock.owner, `pid:${process.pid}`)
  lock.release()
})

test('acquireLock takes over an abandoned lock', (t) => {
  const home = makeHome(t)
  const lockPath = join(home, 'fleet.lock')
  writeJsonFile(lockPath, {
    owner: 'dead-holder',
    pid: process.pid,
    startedAt: new Date(Date.now() - LOCK_STALE_MS - 1_000).toISOString(),
    nonce: 'old',
  })
  const lock = acquireLock(home, { owner: 'live-holder' })
  assert.equal(lock.ok, true)
  assert.equal(lock.owner, 'live-holder')
  lock.release()
})

test('acquireLock takes over a malformed or pid-less lock record', (t) => {
  const home = makeHome(t)
  const lockPath = join(home, 'fleet.lock')
  writeTextFile(lockPath, 'not json\n')
  const first = acquireLock(home, { owner: 'first' })
  assert.equal(first.ok, true)
  first.release()

  writeJsonFile(lockPath, { pid: 2147483646, startedAt: new Date().toISOString() })
  const second = acquireLock(home, { owner: 'second' })
  assert.equal(second.ok, true)
  second.release()
})

test('profile re-exports atomicWriteFile and backupFile', (t) => {
  const dir = makeTempDir(t)
  const path = join(dir, 'file.txt')
  atomicWriteFile(path, 'one\n')
  assert.equal(readTextFile(path), 'one\n')
  const backupPath = backupFile(path)
  assert.notEqual(backupPath, null)
  assert.equal(readTextFile(backupPath), 'one\n')
})
