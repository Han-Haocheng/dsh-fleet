import test from 'node:test'
import assert from 'node:assert/strict'

import { parseManifest, serializeManifest, validateManifest } from '../lib/manifest.js'

const TEXT = `version: 1
profiles:
  - web
bundles: []
providers: []
items:
  - id: web
    name: "@deepseek-ai/dsh-web"
    scope:
      - web
    title: "Web 配置"
    description: "web 搜索与抓取配置"
    config:
      searchProvider: ddg
`

test('entries keep an optional title/description through parse and serialize', () => {
  const { manifest, errors, warnings } = parseManifest(TEXT)
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
  assert.equal(manifest.items[0].title, 'Web 配置')
  assert.equal(manifest.items[0].description, 'web 搜索与抓取配置')
  assert.deepEqual(validateManifest(manifest, { knownProfiles: ['web'] }), [])
  const out = serializeManifest(manifest)
  assert.match(out, /title: Web 配置/)
  assert.match(out, /description: web 搜索与抓取配置/)
})

test('a non-string description is rejected', () => {
  const bad = TEXT.replace('"web 搜索与抓取配置"', '42')
  const { manifest } = parseManifest(bad)
  const errors = validateManifest(manifest, { knownProfiles: ['web'] })
  assert.ok(errors.some((error) => error.includes('.description: must be a string')))
})

test('a non-string title is rejected', () => {
  const bad = TEXT.replace('"Web 配置"', '7')
  const { manifest } = parseManifest(bad)
  const errors = validateManifest(manifest, { knownProfiles: ['web'] })
  assert.ok(errors.some((error) => error.includes('.title: must be a string')))
})
