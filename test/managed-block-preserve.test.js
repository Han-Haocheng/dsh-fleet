/**
 * A settings edit on a row that lives inside the managed block must not be
 * silently reverted by the next `apply`.
 *
 * The settings service persists by appending to the profile patch, and fleet's
 * block is the last thing in that file, so the row lands *inside* the block.
 * `upsertManagedBlock` carries such rows out of the block — but only rows the
 * manifest never names: a manifest item that left scope is fleet's to delete.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractManagedBlock, upsertManagedBlock } from '../lib/render.js'
import { parseYamlTolerant } from '../lib/util.js'

const HEADER = '# >>> dsh-fleet v1 sha256:0000000000000000000000000000000000000000000000000000000000000000 —— generated from ~/.dsh/fleet.yml, do not edit'
const FOOTER = '# <<< dsh-fleet'

function blockOf(body) {
  return `${HEADER}\n${body}${FOOTER}\n`
}

const MANAGED_ROW = '- id: llm-pi-ai\n  config:\n    providers: {}\n'
const SETTINGS_ROW = '- id: dsh-fleet\n  name: dsh-fleet\n  config:\n    manifestPath: fleet.yml\n    autoInstall: false\n'

test('a settings row written into the block is carried out of it', () => {
  const patch = `# user patch\n${blockOf(MANAGED_ROW + SETTINGS_ROW)}\n# trailing comment\n`
  const nextBlock = blockOf('- id: llm-pi-ai\n  config:\n    providers:\n      openmodel: {}\n')
  const out = upsertManagedBlock(patch, nextBlock, { managedIds: new Set(['llm-pi-ai']) })

  const block = extractManagedBlock(out)
  assert.ok(block?.complete)
  const blockIds = (parseYamlTolerant(block.text) ?? []).map((entry) => entry?.id)
  assert.deepEqual(blockIds, ['llm-pi-ai'], 'the foreign row leaves the block')
  assert.match(out, /# preserved by dsh-fleet/u)
  assert.match(out, /- id: dsh-fleet\n  name: dsh-fleet\n  config:\n    manifestPath: fleet\.yml\n    autoInstall: false/u)
  assert.match(out, /# trailing comment/u, 'surrounding bytes stay put')
  // The settings value is still in force: it sits after the block.
  assert.ok(out.indexOf('autoInstall: false') > out.indexOf(FOOTER))
})

test('carrying the row out is idempotent', () => {
  const patch = `# user patch\n${blockOf(MANAGED_ROW + SETTINGS_ROW)}`
  const nextBlock = blockOf(MANAGED_ROW)
  const once = upsertManagedBlock(patch, nextBlock, { managedIds: new Set(['llm-pi-ai']) })
  const twice = upsertManagedBlock(once, nextBlock, { managedIds: new Set(['llm-pi-ai']) })
  assert.equal(twice.match(/- id: dsh-fleet/gu)?.length, 1, 'exactly one copy survives')
  assert.equal(once, twice, 'a second apply is byte-identical')
})

test('a manifest item that left scope is dropped, not carried', () => {
  const patch = `${blockOf(MANAGED_ROW + '- id: web\n  config:\n    searchProvider: ddg\n')}`
  const nextBlock = blockOf(MANAGED_ROW)
  const out = upsertManagedBlock(patch, nextBlock, { managedIds: new Set(['llm-pi-ai', 'web']) })
  assert.ok(!out.includes('- id: web'), 'an out-of-scope item is still removed')
  assert.ok(!out.includes('# preserved by dsh-fleet'), 'nothing is carried')
})

test('an incomplete block is never harvested', () => {
  const patch = `${HEADER}\n${SETTINGS_ROW}` // no footer: extent unknown
  const out = upsertManagedBlock(patch, blockOf(MANAGED_ROW), { managedIds: new Set(['llm-pi-ai']) })
  assert.ok(!out.includes('# preserved by dsh-fleet'))
})

test('without managedIds nothing is carried (render-only callers keep the old contract)', () => {
  const patch = `${blockOf(MANAGED_ROW + SETTINGS_ROW)}`
  const out = upsertManagedBlock(patch, blockOf(MANAGED_ROW))
  assert.equal(out, blockOf(MANAGED_ROW), 'the block is simply replaced')
})
