/**
 * Model metadata inheritance.
 *
 * Rendering writes the whole `llm-pi-ai` row, so a manifest provider entry that
 * lists model ids without the metadata the installed row carried
 * (`reasoningEfforts`, `contextWindow`, `maxTokens`, `input`) used to drop that
 * capability — a TUI model with no declared levels renders as "不支持".
 * These tests pin the fill-in rule: the manifest wins where it speaks, the
 * profile's own row supplies what it leaves out, and the managed block is never
 * used as a source.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { collectInheritedModelMeta, renderManagedBlock } from '../lib/render.js'
import { baseManifest } from './helpers.js'

const LOCAL_ROW = `- id: llm-pi-ai
  config:
    providers:
      openmodel:
        models:
          - id: m1
            reasoningEfforts:
              low: low
              high: high
            contextWindow: 1000
            maxTokens: 500
          - id: m2
            contextWindow: 2000
`

const MANAGED_BLOCK = `# >>> dsh-fleet v1 sha256:deadbeef —— generated from ~/.dsh/fleet.yml, do not edit
- id: llm-pi-ai
  config:
    providers:
      openmodel:
        models:
          - id: m1
            contextWindow: 999999
# <<< dsh-fleet
`

function manifestWith(models) {
  return baseManifest({
    profiles: ['web'],
    providers: [{ key: 'openmodel', scope: ['all'], config: { models } }],
    items: [{ id: 'llm-pi-ai', scope: ['all'], config: {} }],
  })
}

test('collectInheritedModelMeta reads the profile rows and ignores the managed block', () => {
  const meta = collectInheritedModelMeta(`${LOCAL_ROW}\n${MANAGED_BLOCK}`)
  assert.ok(meta, 'metadata is found')
  assert.deepEqual(meta.openmodel.m1, {
    reasoningEfforts: { low: 'low', high: 'high' },
    contextWindow: 1000,
    maxTokens: 500,
  })
  // 999999 lives only in the managed block: harvesting it would freeze our own
  // earlier output and hide a value the author removed from the manifest.
  assert.equal(meta.openmodel.m1.contextWindow, 1000)
  assert.deepEqual(meta.openmodel.m2, { contextWindow: 2000 })
})

test('collectInheritedModelMeta merges repeated rows, last definition winning', () => {
  const first = `- id: llm-pi-ai\n  config:\n    providers:\n      openmodel:\n        models:\n          - id: m1\n            contextWindow: 1\n            maxTokens: 2\n`
  const second = `- id: llm-pi-ai\n  config:\n    providers:\n      openmodel:\n        models:\n          - id: m1\n            contextWindow: 3\n`
  const meta = collectInheritedModelMeta(`${first}${second}`)
  assert.deepEqual(meta.openmodel.m1, { contextWindow: 3, maxTokens: 2 })
})

test('collectInheritedModelMeta returns undefined when nothing is available', () => {
  assert.equal(collectInheritedModelMeta(''), undefined)
  assert.equal(collectInheritedModelMeta('- id: web\n  config: {}\n'), undefined)
  assert.equal(collectInheritedModelMeta(MANAGED_BLOCK), undefined, 'the managed block alone is not a source')
})

test('rendering fills the fields the manifest leaves out', () => {
  const manifest = manifestWith([{ id: 'm1', name: 'm1' }, { id: 'm2', name: 'm2' }])
  const inheritModelMeta = collectInheritedModelMeta(`${LOCAL_ROW}\n${MANAGED_BLOCK}`)
  const { entries } = renderManagedBlock({ manifest, profile: 'web', inheritModelMeta })
  const models = entries[0].config.providers.openmodel.models
  assert.deepEqual(models[0], {
    id: 'm1',
    name: 'm1',
    reasoningEfforts: { low: 'low', high: 'high' },
    contextWindow: 1000,
    maxTokens: 500,
  })
  assert.deepEqual(models[1], { id: 'm2', name: 'm2', contextWindow: 2000 })
})

test('manifest-declared values win, and reasoningEfforts:false stays an opt-out', () => {
  const manifest = manifestWith([
    { id: 'm1', name: 'm1', contextWindow: 4096, reasoningEfforts: { low: 'low' } },
    { id: 'm2', name: 'm2', reasoningEfforts: false },
  ])
  const inheritModelMeta = collectInheritedModelMeta(LOCAL_ROW)
  const { entries } = renderManagedBlock({ manifest, profile: 'web', inheritModelMeta })
  const models = entries[0].config.providers.openmodel.models
  assert.equal(models[0].contextWindow, 4096, 'the manifest value is not overwritten')
  assert.deepEqual(models[0].reasoningEfforts, { low: 'low' })
  assert.equal(models[1].reasoningEfforts, false, 'an explicit false is never replaced by inherited levels')
})

test('without inherited metadata the render is unchanged', () => {
  const manifest = manifestWith([{ id: 'm1', name: 'm1' }])
  const plain = renderManagedBlock({ manifest, profile: 'web' })
  const empty = renderManagedBlock({ manifest, profile: 'web', inheritModelMeta: collectInheritedModelMeta('') })
  assert.equal(plain.text, empty.text)
})

test('an unknown provider key is left untouched', () => {
  const manifest = baseManifest({
    profiles: ['web'],
    providers: [{ key: 'other', scope: ['all'], config: { models: [{ id: 'm1', name: 'm1' }] } }],
    items: [{ id: 'llm-pi-ai', scope: ['all'], config: {} }],
  })
  const inheritModelMeta = collectInheritedModelMeta(LOCAL_ROW)
  const { entries } = renderManagedBlock({ manifest, profile: 'web', inheritModelMeta })
  assert.deepEqual(entries[0].config.providers.other.models, [{ id: 'm1', name: 'm1' }])
})
