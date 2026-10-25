import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { writeProfileFiles } from '../lib/profile.js'
import { listProfileBackups, restoreProfileBackups } from '../lib/restore.js'
import { readTextFile } from '../lib/util.js'
import { makeHome, makeProfile } from './helpers.js'

test('restoreProfileBackups puts back the files from before the last apply', (t) => {
  const home = makeHome(t)
  const dir = makeProfile(home, 'web', { bundles: ['dsh-mnemon'], patchText: '# original\n' })
  const originalPatch = readTextFile(join(dir, 'cordis.patch.yml'))
  const originalManifest = readTextFile(join(dir, 'package.json'))

  writeProfileFiles({
    home,
    name: 'web',
    patchText: '# rewritten\n',
    bundles: ['dsh-mnemon', 'dsh-ops'],
    dependencies: {},
  })
  assert.equal(readTextFile(join(dir, 'cordis.patch.yml')), '# rewritten\n')
  assert.notEqual(readTextFile(join(dir, 'package.json')), originalManifest)
  assert.ok(listProfileBackups(dir).length >= 2)

  const result = restoreProfileBackups(dir)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.restored.map((entry) => entry.file).sort(), ['cordis.patch.yml', 'package.json'])
  assert.equal(readTextFile(join(dir, 'cordis.patch.yml')), originalPatch)
  assert.equal(readTextFile(join(dir, 'package.json')), originalManifest)
})

test('restoreProfileBackups only restores files carrying the requested stamp', (t) => {
  const home = makeHome(t)
  const dir = makeProfile(home, 'web', { bundles: [], patchText: '# one\n' })
  writeProfileFiles({ home, name: 'web', patchText: '# two\n', bundles: [] })
  const stamp = listProfileBackups(dir)[0]?.stamp
  assert.ok(stamp)

  writeProfileFiles({ home, name: 'web', patchText: '# three\n', bundles: [] })
  const result = restoreProfileBackups(dir, { stamp })
  assert.deepEqual(result.errors, [])
  assert.ok(result.restored.length >= 1)
  assert.equal(readTextFile(join(dir, 'cordis.patch.yml')), '# one\n')
})

test('restoreProfileBackups reports a directory with no backups', (t) => {
  const home = makeHome(t)
  const dir = makeProfile(home, 'web', { bundles: [], patchText: '# only\n' })
  const result = restoreProfileBackups(dir)
  assert.deepEqual(result.restored, [])
  assert.ok(result.skipped.length > 0)
})
