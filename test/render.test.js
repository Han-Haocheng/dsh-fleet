import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractManagedBlock,
  hashEntries,
  reconcileBundles,
  renderManagedBlock,
  upsertManagedBlock,
} from '../lib/render.js'
import { baseManifest } from './helpers.js'

const MANIFEST = baseManifest({
  profiles: ['web', 'desktop'],
  providers: [
    { key: 'openmodel', scope: ['web'], config: { displayName: 'OpenModel' } },
  ],
  items: [
    { id: 'web', name: '@deepseek-ai/dsh-web', scope: ['web'], config: { searchProvider: 'ddg' } },
    {
      id: 'llm-pi-ai',
      scope: ['all'],
      config: { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } },
    },
  ],
})

const EXPECTED_ENTRIES = [
  { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'ddg' } },
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
        openmodel: { displayName: 'OpenModel' },
      },
    },
  },
]

test('renderManagedBlock renders the contract block byte for byte', () => {
  const rendered = renderManagedBlock({ manifest: MANIFEST, profile: 'web' })
  assert.deepEqual(rendered.entries, EXPECTED_ENTRIES)
  assert.equal(rendered.hash, hashEntries(EXPECTED_ENTRIES))
  const body = [
    '- id: web',
    '  name: "@deepseek-ai/dsh-web"',
    '  config:',
    '    searchProvider: ddg',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      opencode-go:',
    '        apiKeyEnv: OPENCODE_GO_API_KEY',
    '      openmodel:',
    '        displayName: OpenModel',
    '',
  ].join('\n')
  const expected = `# >>> dsh-fleet v1 sha256:${rendered.hash} —— generated from ~/.dsh/fleet.yml, do not edit\n${body}# <<< dsh-fleet\n`
  assert.equal(rendered.text, expected)
})

test('renderManagedBlock is byte-stable across calls', () => {
  const first = renderManagedBlock({ manifest: MANIFEST, profile: 'web' })
  const second = renderManagedBlock({ manifest: MANIFEST, profile: 'web' })
  assert.equal(first.text, second.text)
  assert.equal(first.hash, second.hash)
  assert.deepEqual(first.entries, second.entries)
})

test('renderManagedBlock records the entry hash in the header only', () => {
  const rendered = renderManagedBlock({ manifest: MANIFEST, profile: 'web' })
  assert.match(rendered.text.split('\n')[0], new RegExp(`sha256:${rendered.hash}`))
  const block = extractManagedBlock(rendered.text)
  assert.equal(block.hash, rendered.hash)
})

test('renderManagedBlock keeps the documented key order', () => {
  const rendered = renderManagedBlock({
    manifest: baseManifest({
      items: [{ id: 'x', name: '@scope/x', scope: ['all'], config: { a: 1 }, disabled: true }],
    }),
    profile: 'web',
  })
  assert.deepEqual(Object.keys(rendered.entries[0]), ['id', 'name', 'config', 'disabled'])
  assert.deepEqual(rendered.entries[0], { id: 'x', name: '@scope/x', config: { a: 1 }, disabled: true })
})

test('renderManagedBlock writes an empty list when nothing is in scope', () => {
  const rendered = renderManagedBlock({ manifest: baseManifest({ items: [] }), profile: 'web' })
  assert.deepEqual(rendered.entries, [])
  assert.match(rendered.text, /\n\[\]\n# <<< dsh-fleet\n$/)
})

test('out-of-scope items are skipped by default (they are not applied)', () => {
  const manifest = baseManifest({
    items: [{ id: 'tui-only', scope: ['dsh-tui'], config: { x: 1 } }],
  })
  const rendered = renderManagedBlock({
    manifest,
    profile: 'web',
    rowExists: () => true,
  })
  assert.deepEqual(rendered.entries, [])
})

test('enforce: true writes disabled:true only when the row exists', () => {
  const manifest = baseManifest({
    items: [{ id: 'tui-only', scope: ['dsh-tui'], config: { x: 1 }, enforce: true }],
  })
  const missing = renderManagedBlock({
    manifest,
    profile: 'web',
    rowExists: (_profile, rowId) => rowId === 'other-row',
  })
  assert.deepEqual(missing.entries, [])

  const exists = renderManagedBlock({
    manifest,
    profile: 'web',
    rowExists: (profile, rowId) => profile === 'web' && rowId === 'tui-only',
  })
  assert.deepEqual(exists.entries, [{ id: 'tui-only', disabled: true }])
})

test('in-scope items carry name, config and disabled markers', () => {
  const manifest = baseManifest({
    items: [
      { id: 'kept', scope: ['web'], config: { a: 1 }, disabled: true },
      { id: 'plain', scope: ['web'], config: {} },
    ],
  })
  const rendered = renderManagedBlock({ manifest, profile: 'web' })
  assert.deepEqual(rendered.entries, [
    { id: 'kept', config: { a: 1 }, disabled: true },
    { id: 'plain', config: {} },
  ])
})

test('provider overrides are applied per profile and merged shallowly', () => {
  const manifest = baseManifest({
    profiles: ['web', 'dsh-tui'],
    providers: [{
      key: 'openmodel',
      scope: ['all'],
      config: { displayName: 'OpenModel', models: [{ id: 'a' }] },
      overrides: {
        'dsh-tui': { config: { retryPolicy: { maxRetries: 5 } } },
      },
    }],
    items: [{ id: 'llm-pi-ai', scope: ['all'], config: {} }],
  })
  const webEntries = renderManagedBlock({ manifest, profile: 'web' }).entries
  const tuiEntries = renderManagedBlock({ manifest, profile: 'dsh-tui' }).entries
  assert.deepEqual(webEntries[0].config.providers.openmodel, {
    displayName: 'OpenModel',
    models: [{ id: 'a' }],
  })
  assert.deepEqual(tuiEntries[0].config.providers.openmodel, {
    displayName: 'OpenModel',
    models: [{ id: 'a' }],
    retryPolicy: { maxRetries: 5 },
  })
  assert.notEqual(hashEntries(webEntries), hashEntries(tuiEntries))
})

test('disabled providers are omitted from the llm-pi-ai aggregation', () => {
  const manifest = baseManifest({
    profiles: ['web', 'desktop'],
    providers: [
      { key: 'base', scope: ['all'], config: { apiKeyEnv: 'BASE_KEY' } },
      {
        key: 'extra',
        scope: ['all'],
        config: { apiKeyEnv: 'EXTRA_KEY' },
        overrides: { desktop: { disabled: true } },
      },
      { key: 'always-off', scope: ['all'], config: {}, disabled: true },
    ],
    items: [{ id: 'llm-pi-ai', scope: ['all'], config: { providers: { legacy: { apiKeyEnv: 'LEGACY' } } } }],
  })
  const webProviders = renderManagedBlock({ manifest, profile: 'web' }).entries[0].config.providers
  assert.deepEqual(Object.keys(webProviders), ['legacy', 'base', 'extra'])
  const desktopProviders = renderManagedBlock({ manifest, profile: 'desktop' }).entries[0].config.providers
  assert.deepEqual(Object.keys(desktopProviders), ['legacy', 'base'])
})

test('item overrides replace config keys for that profile', () => {
  const manifest = baseManifest({
    profiles: ['web', 'desktop'],
    items: [
      {
        id: 'agent-default-model',
        scope: ['all'],
        config: { provider: 'web-provider', model: 'm1' },
        overrides: {
          desktop: { config: { provider: 'desktop-provider', model: 'm2' } },
        },
      },
    ],
  })
  const webEntries = renderManagedBlock({ manifest, profile: 'web' }).entries
  const desktopEntries = renderManagedBlock({ manifest, profile: 'desktop' }).entries
  assert.deepEqual(webEntries[0].config, { provider: 'web-provider', model: 'm1' })
  assert.deepEqual(desktopEntries[0].config, { provider: 'desktop-provider', model: 'm2' })
})

test('item override disabled turns the row off for that profile only', () => {
  const manifest = baseManifest({
    profiles: ['web', 'dsh-tui'],
    items: [{
      id: 'row',
      scope: ['all'],
      config: { a: 1 },
      overrides: { 'dsh-tui': { disabled: true } },
    }],
  })
  const web = renderManagedBlock({ manifest, profile: 'web' }).entries
  const tui = renderManagedBlock({ manifest, profile: 'dsh-tui' }).entries
  assert.deepEqual(web, [{ id: 'row', config: { a: 1 } }])
  assert.deepEqual(tui, [{ id: 'row', config: { a: 1 }, disabled: true }])
})

test('upsertManagedBlock appends the block when no marker exists', () => {
  const block = renderManagedBlock({ manifest: MANIFEST, profile: 'web' }).text
  assert.equal(upsertManagedBlock('', block), block)
  assert.equal(upsertManagedBlock('\n\n', block), block)
  const existing = '# user patch\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n'
  assert.equal(upsertManagedBlock(existing, block), `${existing}\n${block}`)
})

test('upsertManagedBlock replaces an existing block and keeps surrounding bytes', () => {
  const first = renderManagedBlock({ manifest: MANIFEST, profile: 'web' })
  const second = renderManagedBlock({ manifest: MANIFEST, profile: 'desktop' })
  const prefix = '# user patch\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n\n'
  const suffix = '\n# trailing user comment\n'
  const patchText = `${prefix}${first.text}${suffix}`
  const next = upsertManagedBlock(patchText, second.text)
  assert.equal(next, `${prefix}${second.text}${suffix}`)
})

test('upsertManagedBlock is idempotent', () => {
  const block = renderManagedBlock({ manifest: MANIFEST, profile: 'web' }).text
  const once = upsertManagedBlock('# head\n', block)
  assert.equal(upsertManagedBlock(once, block), once)
})

test('upsertManagedBlock recovers a block missing its footer', () => {
  const block = renderManagedBlock({ manifest: MANIFEST, profile: 'web' }).text
  const broken = '# head\n# >>> dsh-fleet v1 sha256:deadbeef —— generated from ~/.dsh/fleet.yml, do not edit\n- id: old\n'
  const fixed = upsertManagedBlock(broken, block)
  assert.equal(fixed, `# head\n${block}`)
})

test('extractManagedBlock returns null without markers', () => {
  assert.equal(extractManagedBlock(''), null)
  assert.equal(extractManagedBlock('version: 1\n'), null)
})

test('extractManagedBlock returns the hash and a parseable body', async () => {
  const rendered = renderManagedBlock({ manifest: MANIFEST, profile: 'web' })
  const block = extractManagedBlock(`# head\n${rendered.text}`)
  assert.equal(block.present, true)
  assert.equal(block.complete, true)
  assert.equal(block.hash, rendered.hash)
  assert.match(block.text, /^# >>> dsh-fleet/)
  assert.match(block.text, /# <<< dsh-fleet\n$/)
  const { default: YAML } = await import('yaml')
  assert.deepEqual(YAML.parse(block.text), rendered.entries)
})

test('extractManagedBlock reports an incomplete block', () => {
  const block = extractManagedBlock('# >>> dsh-fleet v1 sha256:abc\n- id: a\n')
  assert.equal(block.present, true)
  assert.equal(block.complete, false)
  assert.equal(block.hash, null)
  assert.match(block.text, /- id: a/)
})

test('reconcileBundles keeps non-managed bundles first and re-appends managed ones in manifest order', () => {
  const manifest = baseManifest({
    bundles: [
      { name: 'managed-b', spec: 'managed-b@1', scope: ['all'] },
      { name: 'managed-a', spec: 'managed-a@1', scope: ['all'] },
    ],
  })
  const result = reconcileBundles({
    manifest,
    profile: 'web',
    knownProfiles: ['web'],
    currentBundles: ['@deepseek-ai/dsh-base', 'managed-a', 'dsh-other', 'managed-b'],
  })
  assert.deepEqual(result.bundles, ['@deepseek-ai/dsh-base', 'dsh-other', 'managed-b', 'managed-a'])
  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [])
})

test('reconcileBundles adds in-scope bundles and removes out-of-scope selections', () => {
  const manifest = baseManifest({
    bundles: [
      { name: 'for-web', spec: 'for-web@1', scope: ['web'] },
      { name: 'for-tui', spec: 'for-tui@1', scope: ['dsh-tui'] },
    ],
  })
  const result = reconcileBundles({
    manifest,
    profile: 'web',
    knownProfiles: ['web', 'dsh-tui'],
    currentBundles: ['@deepseek-ai/dsh-base', 'for-tui'],
  })
  assert.deepEqual(result.bundles, ['@deepseek-ai/dsh-base', 'for-web'])
  assert.deepEqual(result.added, ['for-web'])
  assert.deepEqual(result.removed, ['for-tui'])
})

test('reconcileBundles honours per-profile bundle disabled overrides', () => {
  const manifest = baseManifest({
    profiles: ['web', 'dsh-tui'],
    bundles: [{
      name: 'optional-layer',
      spec: 'optional-layer@1',
      scope: ['all'],
      overrides: { 'dsh-tui': { disabled: true } },
    }],
  })
  const web = reconcileBundles({ manifest, profile: 'web', knownProfiles: ['web', 'dsh-tui'], currentBundles: [] })
  assert.deepEqual(web.bundles, ['optional-layer'])
  const tui = reconcileBundles({
    manifest,
    profile: 'dsh-tui',
    knownProfiles: ['web', 'dsh-tui'],
    currentBundles: ['@deepseek-ai/dsh-base', 'optional-layer'],
  })
  assert.deepEqual(tui.bundles, ['@deepseek-ai/dsh-base'])
  assert.deepEqual(tui.removed, ['optional-layer'])
})

test('reconcileBundles deduplicates the current selection', () => {
  const manifest = baseManifest({ bundles: [{ name: 'managed', spec: 'managed@1', scope: ['all'] }] })
  const result = reconcileBundles({
    manifest,
    profile: 'web',
    knownProfiles: ['web'],
    currentBundles: ['dup', 'dup', 'managed'],
  })
  assert.deepEqual(result.bundles, ['dup', 'managed'])
})
