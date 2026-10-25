import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MANIFEST_VERSION,
  effectiveEntry,
  isInScope,
  parseManifest,
  resolveScope,
  serializeManifest,
  validateManifest,
} from '../lib/manifest.js'
import { baseManifest } from './helpers.js'

const SAMPLE = `# fleet manifest
version: 1
profiles: [web, desktop, dsh-tui]
providers:
  - key: openmodel
    scope: [web, desktop]
    config:
      displayName: OpenModel
      apiKeyEnv: OPENMODEL_API_KEY
    overrides:
      desktop:
        config:
          retryPolicy:
            maxRetries: 2
  - key: opencode-go
    scope: [all]
    config:
      apiKeyEnv: OPENCODE_GO_API_KEY
bundles:
  - name: dsh-mnemon
    spec: dsh-mnemon@0.5.34
    scope: [all]
    provides: [ddg, fs-quality-fetch]
    prune: false
  - name: dsh-free-search
    spec: dsh-free-search@0.9.15
    scope: [web, dsh-tui]
items:
  - id: web
    name: "@deepseek-ai/dsh-web"
    scope: [web, desktop]
    config:
      searchProvider: ddg
    requires: [dsh-free-search]
  - id: llm-pi-ai
    scope: [all]
    config:
      providers:
        opencode-go:
          apiKeyEnv: OPENCODE_GO_API_KEY
  - id: agent-default-model
    scope: [all]
    config:
      provider: openmodel
      model: deepseek-v4.1-flash
  - id: tui-only
    scope: [dsh-tui]
    enforce: true
    disabled: false
    config: {}
`

test('MANIFEST_VERSION is 1', () => {
  assert.equal(MANIFEST_VERSION, 1)
})

test('parseManifest normalizes the documented shape', () => {
  const { manifest, errors } = parseManifest(SAMPLE)
  assert.deepEqual(errors, [])
  assert.equal(manifest.version, 1)
  assert.deepEqual(manifest.profiles, ['web', 'desktop', 'dsh-tui'])
  assert.equal(manifest.providers.length, 2)
  assert.deepEqual(manifest.providers[0], {
    key: 'openmodel',
    scope: ['web', 'desktop'],
    config: { displayName: 'OpenModel', apiKeyEnv: 'OPENMODEL_API_KEY' },
    overrides: { desktop: { config: { retryPolicy: { maxRetries: 2 } } } },
  })
  assert.deepEqual(manifest.bundles[0], {
    name: 'dsh-mnemon',
    spec: 'dsh-mnemon@0.5.34',
    scope: ['all'],
    provides: ['ddg', 'fs-quality-fetch'],
    prune: false,
  })
  assert.deepEqual(manifest.items[0], {
    id: 'web',
    name: '@deepseek-ai/dsh-web',
    scope: ['web', 'desktop'],
    config: { searchProvider: 'ddg' },
    requires: ['dsh-free-search'],
  })
})

test('parseManifest keeps every optional entry field', () => {
  const { manifest } = parseManifest(SAMPLE)
  const tuiItem = manifest.items.find((item) => item.id === 'tui-only')
  assert.equal(tuiItem.enforce, true)
  assert.equal(tuiItem.disabled, false)
  assert.deepEqual(tuiItem.config, {})
  assert.deepEqual(Object.keys(tuiItem), ['id', 'scope', 'config', 'disabled', 'enforce'])
  const bundle = manifest.bundles[0]
  assert.deepEqual(bundle.provides, ['ddg', 'fs-quality-fetch'])
  assert.equal(bundle.prune, false)
  assert.deepEqual(manifest.providers[0].overrides.desktop.config.retryPolicy, { maxRetries: 2 })
})

test('parseManifest defaults a missing scope to ["all"]', () => {
  const { manifest, errors } = parseManifest('version: 1\nprofiles: [web]\nitems:\n  - id: x\n')
  assert.deepEqual(errors, [])
  assert.deepEqual(manifest.items[0].scope, ['all'])
})

test('parseManifest reports invalid YAML', () => {
  const { manifest, errors } = parseManifest('version: 1\n  bad indent: [\n')
  assert.equal(manifest, null)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /not valid YAML/)
})

test('parseManifest reports an empty document', () => {
  assert.equal(parseManifest('').manifest, null)
  assert.match(parseManifest('').errors[0], /empty/)
  assert.equal(parseManifest('# only a comment\n').manifest, null)
})

test('parseManifest rejects a non-mapping root', () => {
  const parsed = parseManifest('- one\n- two\n')
  assert.equal(parsed.manifest, null)
  assert.match(parsed.errors[0], /root must be a YAML mapping/)
})

test('parseManifest reports non-list sections and non-mapping entries', () => {
  const parsed = parseManifest('version: 1\nprofiles: [web]\nproviders:\n  key: nope\nitems:\n  - 42\n')
  assert.notEqual(parsed.manifest, null)
  assert.ok(parsed.errors.some((error) => /providers: must be a list/.test(error)))
  assert.ok(parsed.errors.some((error) => /items\[0\]: must be a mapping/.test(error)))
})

test('parseManifest warns about unknown fields without failing', () => {
  const parsed = parseManifest('version: 1\nprofiles: [web]\nextras: 1\nitems:\n  - id: x\n    config: {}\n    typo: true\n')
  assert.deepEqual(parsed.errors, [])
  assert.ok(parsed.warnings.some((warning) => /unknown top-level field "extras"/.test(warning)))
  assert.ok(parsed.warnings.some((warning) => /items\[0\]: unknown field "typo"/.test(warning)))
  assert.equal(parsed.manifest.items[0].typo, undefined)
})

test('validateManifest accepts a fully populated manifest', () => {
  const { manifest } = parseManifest(SAMPLE)
  assert.deepEqual(validateManifest(manifest, { knownProfiles: ['web', 'desktop', 'dsh-tui'] }), [])
})

test('validateManifest reports the schema version', () => {
  const errors = validateManifest(baseManifest({ version: 2 }), {})
  assert.ok(errors.some((error) => /version: expected 1, got 2/.test(error)))
  const missing = validateManifest({ profiles: ['web'], providers: [], bundles: [], items: [] }, {})
  assert.ok(missing.some((error) => /version: expected 1/.test(error)))
})

test('validateManifest requires a non-empty, unique profile list', () => {
  assert.ok(validateManifest(baseManifest({ profiles: [] }), {}).some((error) => /profiles: must be a non-empty/.test(error)))
  const duplicates = validateManifest(baseManifest({ profiles: ['web', 'web'] }), {})
  assert.ok(duplicates.some((error) => /duplicate profile "web"/.test(error)))
  const nonStrings = validateManifest(baseManifest({ profiles: ['web', 3] }), {})
  assert.ok(nonStrings.some((error) => /profiles\[1\]: must be a non-empty string/.test(error)))
})

test('validateManifest rejects unknown scope names and malformed scopes', () => {
  const known = { knownProfiles: ['web', 'desktop', 'dsh-tui'] }
  const unknown = baseManifest({ items: [{ id: 'x', scope: ['web', 'staging'], config: {} }] })
  assert.ok(validateManifest(unknown, known).some((error) => /items\[0\]\.scope: unknown profile "staging"/.test(error)))
  const notList = baseManifest({ items: [{ id: 'x', scope: 'web', config: {} }] })
  assert.ok(validateManifest(notList, known).some((error) => /must be a list of profile names/.test(error)))
  const empty = baseManifest({ items: [{ id: 'x', scope: [], config: {} }] })
  assert.ok(validateManifest(empty, known).some((error) => /must not be empty/.test(error)))
  const mixedAll = baseManifest({ items: [{ id: 'x', scope: ['all', 'web'], config: {} }] })
  assert.ok(validateManifest(mixedAll, known).some((error) => /"all" must be the only value/.test(error)))
})

test('validateManifest checks provider keys, config and disabled/enforce booleans', () => {
  const errors = validateManifest(baseManifest({
    items: [{ id: 'llm-pi-ai', scope: ['all'], config: {} }],
    providers: [
      { key: 'a', scope: ['all'], config: {} },
      { key: 'a', scope: ['all'], config: {} },
      { key: '', scope: ['all'], config: [] },
      { key: 'b', scope: ['all'], config: {}, disabled: 'yes', enforce: 1 },
    ],
  }), { knownProfiles: ['web', 'desktop', 'dsh-tui'] })
  assert.ok(errors.some((error) => /providers\[1\]\.key: duplicate provider key "a"/.test(error)))
  assert.ok(errors.some((error) => /providers\[2\]\.key: must be a non-empty string/.test(error)))
  assert.ok(errors.some((error) => /providers\[2\]\.config: must be a mapping/.test(error)))
  assert.ok(errors.some((error) => /providers\[3\]\.disabled: must be a boolean/.test(error)))
  assert.ok(errors.some((error) => /providers\[3\]\.enforce: must be a boolean/.test(error)))
})

test('validateManifest requires unique bundle names and specs', () => {
  const errors = validateManifest(baseManifest({
    bundles: [
      { name: 'a', spec: 'a@1', scope: ['all'] },
      { name: 'a', spec: 'a@1', scope: ['all'] },
      { name: 'b', spec: '', scope: ['all'], provides: 'x', prune: 'no' },
    ],
  }), { knownProfiles: ['web'] })
  assert.ok(errors.some((error) => /bundles\[1\]\.name: duplicate bundle "a"/.test(error)))
  assert.ok(errors.some((error) => /bundles\[1\]\.spec: duplicate bundle spec "a@1"/.test(error)))
  assert.ok(errors.some((error) => /bundles\[2\]\.spec: must be a non-empty package spec/.test(error)))
  assert.ok(errors.some((error) => /bundles\[2\]\.provides: must be a list/.test(error)))
  assert.ok(errors.some((error) => /bundles\[2\]\.prune: must be a boolean/.test(error)))
})

test('validateManifest requires unique item ids and resolvable requires', () => {
  const errors = validateManifest(baseManifest({
    bundles: [{ name: 'dsh-free-search', spec: 'dsh-free-search@1', scope: ['all'] }],
    items: [
      { id: 'web', scope: ['all'], config: {}, requires: ['dsh-free-search'] },
      { id: 'web', scope: ['all'], config: {}, requires: ['ghost-bundle'] },
    ],
  }), { knownProfiles: ['web'] })
  assert.ok(errors.some((error) => /items\[1\]\.id: duplicate item id "web"/.test(error)))
  assert.ok(errors.some((error) => /items\[1\]\.requires: "ghost-bundle" is not a bundle in this manifest/.test(error)))
})

test('validateManifest checks the agent-default-model provider reference', () => {
  const errors = validateManifest(baseManifest({
    providers: [{ key: 'openmodel', scope: ['all'], config: {} }],
    items: [
      { id: 'llm-pi-ai', scope: ['all'], config: {} },
      { id: 'agent-default-model', scope: ['all'], config: { provider: 'missing-provider' } },
    ],
  }), { knownProfiles: ['web'] })
  assert.ok(errors.some((error) => /agent-default-model\.config\.provider "missing-provider" is not a provider/.test(error)))
})

test('validateManifest requires llm-pi-ai whenever providers exist', () => {
  const errors = validateManifest(baseManifest({
    providers: [{ key: 'openmodel', scope: ['all'], config: {} }],
    items: [],
  }), { knownProfiles: ['web'] })
  assert.ok(errors.some((error) => /must declare the "llm-pi-ai" item/.test(error)))
})

test('validateManifest validates the overrides mapping', () => {
  const known = { knownProfiles: ['web', 'desktop', 'dsh-tui'] }
  const outOfScope = baseManifest({
    items: [{ id: 'x', scope: ['web'], config: {}, overrides: { desktop: { config: {} } } }],
  })
  assert.ok(validateManifest(outOfScope, known).some((error) => /overrides\.desktop: profile "desktop" is outside this entry's scope/.test(error)))

  const badTypes = baseManifest({
    items: [{
      id: 'x',
      scope: ['all'],
      config: {},
      overrides: { web: { config: 'nope', disabled: 'yes' } },
    }],
  })
  const typeErrors = validateManifest(badTypes, known)
  assert.ok(typeErrors.some((error) => /overrides\.web\.config: must be a mapping/.test(error)))
  assert.ok(typeErrors.some((error) => /overrides\.web\.disabled: must be a boolean/.test(error)))

  const notMapping = baseManifest({ items: [{ id: 'x', scope: ['all'], config: {}, overrides: [] }] })
  assert.ok(validateManifest(notMapping, known).some((error) => /overrides: must be a mapping/.test(error)))
})

test('resolveScope expands "all" and preserves declared order', () => {
  const known = ['web', 'desktop', 'dsh-tui']
  assert.deepEqual(resolveScope({ scope: ['all'] }, known), ['web', 'desktop', 'dsh-tui'])
  assert.deepEqual(resolveScope({ scope: ['desktop', 'web'] }, known), ['desktop', 'web'])
  assert.deepEqual(resolveScope({}, known), ['web', 'desktop', 'dsh-tui'])
  assert.deepEqual(resolveScope({ scope: [] }, known), ['web', 'desktop', 'dsh-tui'])
  assert.deepEqual(resolveScope({ scope: ['web', 'web'] }, known), ['web'])
})

test('isInScope follows scope membership', () => {
  const known = ['web', 'desktop', 'dsh-tui']
  assert.equal(isInScope({ scope: ['all'] }, 'web', known), true)
  assert.equal(isInScope({ scope: ['web', 'desktop'] }, 'web', known), true)
  assert.equal(isInScope({ scope: ['web', 'desktop'] }, 'dsh-tui', known), false)
  assert.equal(isInScope({}, 'dsh-tui', known), true)
  assert.equal(isInScope({ scope: ['web'] }, '', known), false)
})

test('effectiveEntry shallow-merges override config and disabled', () => {
  const entry = {
    config: { a: 1, nested: { deep: true } },
    disabled: false,
    overrides: {
      desktop: { config: { b: 2, nested: { shallow: true } }, disabled: true },
      web: { config: { a: 9 } },
    },
  }
  assert.deepEqual(effectiveEntry(entry, 'web').config, { a: 9, nested: { deep: true } })
  assert.equal(effectiveEntry(entry, 'web').disabled, false)
  assert.deepEqual(effectiveEntry(entry, 'desktop').config, { a: 1, nested: { shallow: true }, b: 2 })
  assert.equal(effectiveEntry(entry, 'desktop').disabled, true)
  assert.deepEqual(effectiveEntry(entry, 'dsh-tui').config, { a: 1, nested: { deep: true } })
  assert.equal(effectiveEntry({ disabled: true }, 'web').disabled, true)
  assert.equal(effectiveEntry({}, 'web').config, undefined)
})

test('serializeManifest is stable across round trips', () => {
  const first = parseManifest(SAMPLE).manifest
  const text = serializeManifest(first)
  const second = parseManifest(text).manifest
  assert.equal(serializeManifest(second), text)
  assert.equal(serializeManifest(first), text)
})

test('serializeManifest preserves overrides and optional entry fields', () => {
  const manifest = parseManifest(SAMPLE).manifest
  const text = serializeManifest(manifest)
  assert.match(text, /overrides:/)
  assert.match(text, /retryPolicy:/)
  assert.match(text, /provides:/)
  assert.match(text, /prune: false/)
  assert.match(text, /requires:/)
  assert.match(text, /enforce: true/)
  assert.match(text, /name: "@deepseek-ai\/dsh-web"/)

  const reparsed = parseManifest(text).manifest
  assert.deepEqual(reparsed.items.find((item) => item.id === 'web').requires, ['dsh-free-search'])
  assert.deepEqual(reparsed.providers[0].overrides.desktop.config.retryPolicy, { maxRetries: 2 })
  assert.equal(reparsed.items.find((item) => item.id === 'tui-only').enforce, true)
})

test('serializeManifest documents the manifest version first', () => {
  const text = serializeManifest(baseManifest())
  assert.match(text, /^version: 1\n/)
})
