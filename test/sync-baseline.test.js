/**
 * The sync baseline file: reading, merging and clearing the common ancestor a
 * three-way push compares against.
 *
 * Every fixture is a throwaway directory, so the tests double as the contract
 * for the on-disk location (`$DSH_HOME/fleet.sync.json`) and shape
 * (`{ version, updatedAt, rows }`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BASELINE_FILENAME,
  BASELINE_VERSION,
  baselinePath,
  clearBaseline,
  emptyBaseline,
  readBaseline,
  recordBaseline,
} from '../lib/sync-baseline.js'
import { fileExists } from '../lib/util.js'
import { makeTempDir } from './helpers.js'

test('a missing baseline is an empty first-sync baseline, not an error', (t) => {
  const home = makeTempDir(t)
  assert.equal(baselinePath(home), join(home, 'fleet.sync.json'))
  assert.equal(BASELINE_FILENAME, 'fleet.sync.json')

  const result = readBaseline({ home })
  assert.equal(result.ok, true)
  assert.equal(result.error, null)
  assert.deepEqual(result.baseline, { version: BASELINE_VERSION, updatedAt: null, rows: {} })
  assert.deepEqual(emptyBaseline(), result.baseline)
})

test('recordBaseline writes the documented shape and a parseable timestamp', (t) => {
  const home = makeTempDir(t)
  const config = { mode: 'fast', nested: { retries: 2 } }

  const result = recordBaseline({ home, entries: [{ id: 'row-a', profile: 'desktop', config }] })
  assert.deepEqual(result, { ok: true, error: null })

  const path = baselinePath(home)
  assert.equal(fileExists(path), true)
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.version, 1)
  assert.equal(typeof written.updatedAt, 'string')
  assert.equal(Number.isNaN(Date.parse(written.updatedAt)), false)
  assert.deepEqual(written.rows, { 'row-a': { desktop: config } })
})

test('recordBaseline merges rows and profiles instead of replacing the file', (t) => {
  const home = makeTempDir(t)
  recordBaseline({
    home,
    entries: [
      { id: 'row-a', profile: 'desktop', config: { a: 1 } },
      { id: 'row-a', profile: 'laptop', config: { a: 2 } },
      { id: 'row-b', profile: 'desktop', config: { b: 1 } },
    ],
  })
  recordBaseline({ home, entries: [{ id: 'row-a', profile: 'desktop', config: { a: 9 } }] })

  assert.deepEqual(readBaseline({ home }).baseline.rows, {
    'row-a': { desktop: { a: 9 }, laptop: { a: 2 } },
    'row-b': { desktop: { b: 1 } },
  })
})

test('recordBaseline ignores unusable entries and writes nothing when none remain', (t) => {
  const home = makeTempDir(t)
  const result = recordBaseline({
    home,
    entries: [null, { id: '', profile: 'desktop', config: {} }, { id: 'row-a', config: {} }, { id: 'row-a', profile: '' }],
  })
  assert.deepEqual(result, { ok: true, error: null })
  assert.equal(fileExists(baselinePath(home)), false)
})

test('a corrupt baseline is reported but still yields an empty baseline', (t) => {
  const home = makeTempDir(t)
  const path = baselinePath(home)
  writeFileSync(path, '{ this is not json\n')

  const result = readBaseline({ home })
  assert.equal(result.ok, false)
  assert.match(result.error, /cannot parse/)
  assert.deepEqual(result.baseline.rows, {})

  // Recording must not replace a file whose comparison state is now unreadable.
  const before = readFileSync(path, 'utf8')
  const recorded = recordBaseline({ home, entries: [{ id: 'row-a', profile: 'desktop', config: {} }] })
  assert.equal(recorded.ok, false)
  assert.match(recorded.error, /cannot parse/)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('an empty baseline file is treated as an empty baseline', (t) => {
  const home = makeTempDir(t)
  writeFileSync(baselinePath(home), '   \n')
  const result = readBaseline({ home })
  assert.equal(result.ok, true)
  assert.deepEqual(result.baseline.rows, {})
})

test('unknown baseline shapes are normalized away', (t) => {
  const home = makeTempDir(t)
  writeFileSync(
    baselinePath(home),
    JSON.stringify({ version: 7, updatedAt: 'whenever', rows: { 'row-a': { desktop: { a: 1 }, '': { x: 1 } }, '': {} } }),
  )
  const result = readBaseline({ home })
  assert.equal(result.ok, true)
  assert.equal(result.baseline.version, 7)
  assert.deepEqual(result.baseline.rows, { 'row-a': { desktop: { a: 1 } } })
})

test('clearBaseline drops the named rows, or every row without ids', (t) => {
  const home = makeTempDir(t)
  recordBaseline({
    home,
    entries: [
      { id: 'row-a', profile: 'desktop', config: { a: 1 } },
      { id: 'row-b', profile: 'desktop', config: { b: 1 } },
    ],
  })

  assert.deepEqual(clearBaseline({ home, ids: new Set(['row-a']) }), { ok: true, error: null })
  assert.deepEqual(Object.keys(readBaseline({ home }).baseline.rows), ['row-b'])

  assert.deepEqual(clearBaseline({ home }), { ok: true, error: null })
  assert.deepEqual(readBaseline({ home }).baseline.rows, {})
})

test('a write failure is returned, never thrown, and leaves the old baseline intact', { skip: process.getuid?.() === 0 }, (t) => {
  const home = makeTempDir(t)
  recordBaseline({ home, entries: [{ id: 'row-a', profile: 'desktop', config: { a: 1 } }] })
  const path = baselinePath(home)
  const before = readFileSync(path, 'utf8')

  chmodSync(home, 0o500)
  try {
    const result = recordBaseline({ home, entries: [{ id: 'row-b', profile: 'desktop', config: { b: 1 } }] })
    assert.equal(result.ok, false)
    assert.match(result.error, /cannot write/)
  } finally {
    chmodSync(home, 0o700)
  }
  assert.equal(readFileSync(path, 'utf8'), before, 'the atomic write never replaced the file')
})

test('readBaseline reports a non-directory home instead of throwing', (t) => {
  const home = makeTempDir(t)
  mkdirSync(baselinePath(home))
  const result = readBaseline({ home })
  assert.equal(result.ok, false)
  assert.match(result.error, /cannot read/)
  assert.deepEqual(result.baseline.rows, {})
})
