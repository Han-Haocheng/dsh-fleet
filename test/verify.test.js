import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { renderManagedBlock } from '../lib/render.js'
import { dumpProfileConfig, verifyManagedBlock } from '../lib/verify.js'
import { baseManifest, makeTempDir, writeScript } from './helpers.js'

const MANIFEST = baseManifest({
  profiles: ['web'],
  items: [{ id: 'web', name: '@deepseek-ai/dsh-web', scope: ['web'], config: { searchProvider: 'ddg' } }],
})

const RENDERED = renderManagedBlock({ manifest: MANIFEST, profile: 'web' })

test('verifyManagedBlock accepts a freshly rendered block', () => {
  assert.deepEqual(verifyManagedBlock({ entries: RENDERED.entries, patchText: RENDERED.text }), [])
  assert.deepEqual(
    verifyManagedBlock({ entries: RENDERED.entries, patchText: `# user patch\n${RENDERED.text}` }),
    [],
  )
})

test('verifyManagedBlock reports a missing block', () => {
  const warnings = verifyManagedBlock({ entries: RENDERED.entries, patchText: '# user patch\n' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /missing/)
})

test('verifyManagedBlock reports an incomplete block', () => {
  const broken = RENDERED.text.split('\n').filter((line) => !line.includes('# <<< dsh-fleet')).join('\n')
  const warnings = verifyManagedBlock({ entries: RENDERED.entries, patchText: broken })
  assert.ok(warnings.some((warning) => /closing "# <<< dsh-fleet" line is missing/.test(warning)))
})

test('verifyManagedBlock reports a header without a digest', () => {
  const text = RENDERED.text.replace(/sha256:[0-9a-f]{64}/, 'v1')
  const warnings = verifyManagedBlock({ entries: RENDERED.entries, patchText: text })
  assert.ok(warnings.some((warning) => /no sha256 digest/.test(warning)))
})

test('verifyManagedBlock detects a tampered header hash', () => {
  const tampered = RENDERED.text.replace(/sha256:[0-9a-f]{64}/, `sha256:${'0'.repeat(64)}`)
  const warnings = verifyManagedBlock({ entries: RENDERED.entries, patchText: tampered })
  assert.ok(warnings.some((warning) => /hash mismatch/.test(warning)))
  assert.ok(!warnings.some((warning) => /differ from the manifest rendering/.test(warning)))
})

test('verifyManagedBlock detects drifted entries', () => {
  const other = renderManagedBlock({
    manifest: baseManifest({ profiles: ['web'], items: [{ id: 'web', scope: ['web'], config: { searchProvider: 'exa' } }] }),
    profile: 'web',
  })
  const warnings = verifyManagedBlock({ entries: other.entries, patchText: RENDERED.text })
  assert.ok(warnings.some((warning) => /differ from the manifest rendering/.test(warning)))
})

test('verifyManagedBlock reports a body that is not a YAML list', () => {
  const text = [
    `# >>> dsh-fleet v1 sha256:${'a'.repeat(64)} —— generated from ~/.dsh/fleet.yml, do not edit`,
    'id: only-a-mapping',
    '# <<< dsh-fleet',
    '',
  ].join('\n')
  const warnings = verifyManagedBlock({ entries: [], patchText: text })
  assert.ok(warnings.some((warning) => /must be a YAML list/.test(warning)))
})

test('verifyManagedBlock reports invalid YAML in the body', () => {
  const text = [
    `# >>> dsh-fleet v1 sha256:${'a'.repeat(64)} —— generated from ~/.dsh/fleet.yml, do not edit`,
    '- id: [unclosed',
    '# <<< dsh-fleet',
    '',
  ].join('\n')
  const warnings = verifyManagedBlock({ entries: [], patchText: text })
  assert.ok(warnings.some((warning) => /not valid YAML/.test(warning)))
})

test('verifyManagedBlock warns about duplicated blocks', () => {
  const warnings = verifyManagedBlock({
    entries: RENDERED.entries,
    patchText: `${RENDERED.text}${RENDERED.text}`,
  })
  assert.ok(warnings.some((warning) => /multiple managed-block headers/.test(warning)))
})

test('dumpProfileConfig returns the CLI output', async (t) => {
  const dir = makeTempDir(t)
  const bin = writeScript(join(dir, 'dsh-dump'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    `fs.writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)))`,
    'process.stdout.write("plugins:\\n  - id: web\\n")',
    'process.exit(0)',
    '',
  ].join('\n'))
  const result = await dumpProfileConfig({ dshBin: bin, profile: 'web' })
  assert.equal(result.ok, true)
  assert.equal(result.error, null)
  assert.match(result.text, /plugins:/)
})

test('dumpProfileConfig reports a failing CLI', async (t) => {
  const dir = makeTempDir(t)
  const bin = writeScript(join(dir, 'dsh-bad'), [
    '#!/usr/bin/env node',
    'process.stderr.write("no such profile\\n")',
    'process.exit(1)',
    '',
  ].join('\n'))
  const result = await dumpProfileConfig({ dshBin: bin, profile: 'desktop' })
  assert.equal(result.ok, false)
  assert.match(result.error, /exited with code 1/)
  assert.match(result.error, /no such profile/)
})

test('dumpProfileConfig reports empty output, timeouts and missing arguments', async (t) => {
  const dir = makeTempDir(t)
  const silent = writeScript(join(dir, 'dsh-silent'), '#!/usr/bin/env node\nprocess.exit(0)\n')
  const empty = await dumpProfileConfig({ dshBin: silent, profile: 'web' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /printed nothing/)

  const hang = writeScript(join(dir, 'dsh-hang'), '#!/usr/bin/env node\nsetTimeout(() => {}, 60_000)\n')
  const timedOut = await dumpProfileConfig({ dshBin: hang, profile: 'web', timeoutMs: 150 })
  assert.equal(timedOut.ok, false)
  assert.match(timedOut.error, /timed out after 150ms/)

  const noBin = await dumpProfileConfig({ profile: 'web' })
  assert.equal(noBin.ok, false)
  assert.match(noBin.error, /CLI path is required/)

  const noProfile = await dumpProfileConfig({ dshBin: silent })
  assert.equal(noProfile.ok, false)
  assert.match(noProfile.error, /profile name is required/)
})
