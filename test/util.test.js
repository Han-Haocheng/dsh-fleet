import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  atomicWriteFileSync,
  backupFileSync,
  backupStamp,
  blockHashFromHeader,
  deepClone,
  expandHomePath,
  findBlockRange,
  isBlockFooterLine,
  isBlockHeaderLine,
  isNonEmptyString,
  isPlainObject,
  listBackupFiles,
  managedBlockBody,
  pruneBackups,
  readTextFile,
  runProcess,
  sha256,
  shortText,
  sortKeysDeep,
  stableJson,
  uniqueStrings,
} from '../lib/util.js'
import { makeTempDir, writeTextFile } from './helpers.js'

test('sha256 matches known vectors', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('stableJson sorts object keys recursively but keeps array order', () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: [3, 1] } }), '{"a":{"c":[3,1],"d":2},"b":1}')
  assert.equal(stableJson([{ z: 1, a: 2 }]), '[{"a":2,"z":1}]')
  assert.equal(stableJson({ a: 1 }), stableJson({ a: 1 }))
})

test('sortKeysDeep does not mutate its input', () => {
  const input = { b: 1, a: 2 }
  const sorted = sortKeysDeep(input)
  assert.deepEqual(sorted, { a: 2, b: 1 })
  assert.deepEqual(Object.keys(input), ['b', 'a'])
})

test('deepClone copies nested plain data and keeps undefined', () => {
  const source = { a: { b: [1, { c: 2 }] }, d: undefined }
  const copy = deepClone(source)
  assert.deepEqual(copy, source)
  copy.a.b[1].c = 9
  assert.equal(source.a.b[1].c, 2)
  assert.equal(deepClone(undefined), undefined)
})

test('small predicates behave', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isNonEmptyString(' x '), true)
  assert.equal(isNonEmptyString('   '), false)
  assert.equal(isNonEmptyString(1), false)
  assert.deepEqual(uniqueStrings(['b', 'a', 'b', 3, null]), ['b', 'a'])
})

test('expandHomePath handles tilde forms and plain paths', () => {
  const home = process.env.HOME
  if (typeof home === 'string' && home.startsWith('/')) {
    assert.equal(expandHomePath('~'), home)
    assert.equal(expandHomePath('~/x'), join(home, 'x'))
  }
  assert.equal(expandHomePath('/absolute/path'), '/absolute/path')
  assert.equal(expandHomePath('relative/path'), 'relative/path')
})

test('readTextFile returns null for missing files', () => {
  assert.equal(readTextFile('/definitely/not/here/x.txt'), null)
})

test('atomicWriteFileSync creates parents, replaces content and preserves mode', (t) => {
  const dir = makeTempDir(t)
  const path = join(dir, 'nested', 'file.yml')
  atomicWriteFileSync(path, 'one\n')
  assert.equal(readTextFile(path), 'one\n')
  chmodSync(path, 0o640)
  atomicWriteFileSync(path, 'two\n')
  assert.equal(readTextFile(path), 'two\n')
  assert.equal(statSync(path).mode & 0o777, 0o640)
})

test('backupFileSync copies, timestamps and keeps the newest five', (t) => {
  const dir = makeTempDir(t)
  const path = join(dir, 'cordis.patch.yml')
  assert.equal(backupFileSync(path), null)
  writeTextFile(path, 'v1\n')
  const backup = backupFileSync(path)
  assert.notEqual(backup, null)
  assert.equal(readTextFile(backup), 'v1\n')
  assert.match(basename(backup), /\.bak-fleet-\d{8}-\d{9}$/)
  for (let index = 0; index < 8; index += 1) {
    writeTextFile(path, `v${index + 2}\n`)
    backupFileSync(path)
  }
  assert.equal(listBackupFiles(path).length, 5)
  assert.equal(pruneBackups(path, 5).length, 0)
})

test('backupStamp uses a sortable timestamp', () => {
  assert.match(backupStamp(new Date(2026, 9, 25, 1, 2, 3, 4)), /^20261025-010203004$/)
})

test('managed-block markers are recognized', () => {
  const header = '# >>> dsh-fleet v1 sha256:'.concat('a'.repeat(64), ' —— generated from ~/.dsh/fleet.yml, do not edit')
  assert.equal(isBlockHeaderLine(header), true)
  assert.equal(isBlockHeaderLine('  # >>> dsh-fleet'), false)
  assert.equal(isBlockFooterLine('# <<< dsh-fleet'), true)
  assert.equal(isBlockFooterLine('# <<< not-this'), false)
  assert.equal(blockHashFromHeader(header), 'a'.repeat(64))
  assert.equal(blockHashFromHeader('# no hash'), null)
})

test('findBlockRange locates complete and incomplete blocks', () => {
  const complete = '# a\n# >>> dsh-fleet v1 sha256:abc\n- id: x\n# <<< dsh-fleet\n# b\n'
  assert.deepEqual(findBlockRange(complete), { startLine: 1, endLine: 3, complete: true })
  const incomplete = '# a\n# >>> dsh-fleet v1\n- id: x\n'
  assert.deepEqual(findBlockRange(incomplete), { startLine: 1, endLine: 3, complete: false })
  assert.equal(findBlockRange('# a\n- id: x\n'), null)
})

test('managedBlockBody strips markers and trailing blank lines', () => {
  const block = '# >>> dsh-fleet v1 sha256:abc\n- id: x\n  config:\n    a: 1\n# <<< dsh-fleet\n'
  assert.equal(managedBlockBody(block), '- id: x\n  config:\n    a: 1')
})

test('shortText flattens whitespace and truncates', () => {
  assert.equal(shortText(' a\n\n b '), 'a b')
  assert.match(shortText('x'.repeat(50), 10), /^x{10}…$/)
})

test('runProcess captures stdout, stderr and the exit status', async () => {
  const ok = await runProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.code, 0)
  assert.equal(ok.stdout, 'out')
  assert.equal(ok.stderr, 'err')

  const failed = await runProcess({ command: process.execPath, args: ['-e', 'process.exit(3)'] })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 3)
  assert.equal(failed.timedOut, false)

  const missing = await runProcess({ command: '/definitely/not/a/binary', args: [] })
  assert.equal(missing.ok, false)
  assert.notEqual(missing.error, null)
})

test('runProcess kills a hanging child after its timeout', async () => {
  const started = Date.now()
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60_000)'],
    timeoutMs: 100,
  })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 20_000)
})
