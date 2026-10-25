import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  capabilityFor,
  installInCurrentProfile,
  installViaCli,
} from '../lib/install.js'
import { readTextFile } from '../lib/util.js'
import { makeTempDir, writeScript } from './helpers.js'

test('capabilityFor picks the narrowest installation surface', () => {
  assert.equal(capabilityFor({ currentProfile: 'web', targetProfile: 'web' }), 'service')
  assert.equal(capabilityFor({ currentProfile: 'web', targetProfile: 'desktop' }), 'manual')
  assert.equal(capabilityFor({ currentProfile: 'web', targetProfile: 'dsh-tui' }), 'cli')
  assert.equal(capabilityFor({ currentProfile: 'web', targetProfile: '  web  ' }), 'service')
  assert.equal(capabilityFor({ currentProfile: '', targetProfile: 'web' }), 'cli')
  assert.equal(capabilityFor({ currentProfile: null, targetProfile: null }), 'manual')
  assert.equal(capabilityFor({}), 'manual')
  assert.equal(capabilityFor(), 'manual')
})

test('installInCurrentProfile forwards to the plugin manager and reports success', async () => {
  const calls = []
  const pluginManager = {
    installBundle: async (spec, options) => {
      calls.push([spec, options])
      return {
        changed: true,
        application: 'applied',
        stage: 'install',
        target: spec,
        bundle: 'dsh-mnemon',
        version: '0.5.34',
      }
    },
  }
  const result = await installInCurrentProfile(pluginManager, 'dsh-mnemon@0.5.34')
  assert.equal(result.ok, true)
  assert.equal(result.restartRequired, false)
  assert.match(result.detail, /installed dsh-mnemon@0\.5\.34/)
  assert.match(result.detail, /application: applied/)
  assert.deepEqual(calls, [['dsh-mnemon@0.5.34', {}]])

  const withOptions = await installInCurrentProfile(pluginManager, 'dsh-x@1.0.0', { approvedBuilds: ['x'] })
  assert.equal(withOptions.ok, true)
  assert.deepEqual(calls[1], ['dsh-x@1.0.0', { approvedBuilds: ['x'] }])
})

test('installInCurrentProfile flags a restart-required application', async () => {
  const pluginManager = {
    installBundle: async () => ({ changed: true, application: 'restart-required', bundle: 'dsh-x', version: '1.0.0' }),
  }
  const result = await installInCurrentProfile(pluginManager, 'dsh-x@1.0.0')
  assert.equal(result.ok, true)
  assert.equal(result.restartRequired, true)
  assert.match(result.detail, /restart-required/)
})

test('installInCurrentProfile reports a failed change with its error code', async () => {
  const pluginManager = {
    installBundle: async () => ({
      changed: false,
      application: 'failed',
      error: { code: 'BUNDLE_SPEC_UNRESOLVED', diagnostic: 'cannot resolve dsh-ghost' },
    }),
  }
  const result = await installInCurrentProfile(pluginManager, 'dsh-ghost@1.0.0')
  assert.equal(result.ok, false)
  assert.equal(result.restartRequired, false)
  assert.match(result.detail, /BUNDLE_SPEC_UNRESOLVED/)
  assert.match(result.detail, /cannot resolve dsh-ghost/)
})

test('installInCurrentProfile tolerates an overridden application and thrown errors', async () => {
  const overridden = await installInCurrentProfile({
    installBundle: async () => ({ changed: true, application: 'overridden', bundle: 'dsh-x' }),
  }, 'dsh-x')
  assert.equal(overridden.ok, true)

  const thrown = await installInCurrentProfile({
    installBundle: async () => {
      throw new Error('service exploded')
    },
  }, 'dsh-x')
  assert.equal(thrown.ok, false)
  assert.equal(thrown.restartRequired, false)
  assert.match(thrown.detail, /service exploded/)
})

test('installInCurrentProfile rejects a missing service or spec', async () => {
  const noService = await installInCurrentProfile(null, 'dsh-x')
  assert.equal(noService.ok, false)
  assert.match(noService.detail, /pluginManager service is unavailable/)
  const noMethod = await installInCurrentProfile({}, 'dsh-x')
  assert.equal(noMethod.ok, false)
  const noSpec = await installInCurrentProfile({ installBundle: async () => ({}) }, '')
  assert.equal(noSpec.ok, false)
  assert.match(noSpec.detail, /spec is required/)
})

test('installViaCli runs the documented dsh plugin command', async (t) => {
  const dir = makeTempDir(t)
  const argvPath = join(dir, 'argv.json')
  const bin = writeScript(join(dir, 'dsh-ok'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))`,
    'process.stdout.write("added bundle\\n")',
    'process.exit(0)',
    '',
  ].join('\n'))
  const result = await installViaCli({ dshBin: bin, profile: 'dsh-tui', spec: 'dsh-mnemon@0.5.34' })
  assert.equal(result.ok, true)
  assert.match(result.detail, /installed dsh-mnemon@0\.5\.34/)
  assert.equal(result.code, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.stdout, 'added bundle\n')
  assert.deepEqual(JSON.parse(readTextFile(argvPath)), ['plugin', '--profile', 'dsh-tui', 'add', 'dsh-mnemon@0.5.34'])
})

test('installViaCli returns the failure diagnostic and exit code', async (t) => {
  const dir = makeTempDir(t)
  const bin = writeScript(join(dir, 'dsh-fail'), [
    '#!/usr/bin/env node',
    'process.stderr.write("ERR_PNPM_NO_MATCHING_VERSION boom\\n")',
    'process.exit(3)',
    '',
  ].join('\n'))
  const result = await installViaCli({ dshBin: bin, profile: 'web', spec: 'dsh-ghost@9.9.9' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 3)
  assert.match(result.detail, /exited with code 3/)
  assert.match(result.detail, /ERR_PNPM_NO_MATCHING_VERSION/)
  assert.equal(result.stderr, 'ERR_PNPM_NO_MATCHING_VERSION boom\n')
})

test('installViaCli enforces its timeout', async (t) => {
  const dir = makeTempDir(t)
  const bin = writeScript(join(dir, 'dsh-hang'), '#!/usr/bin/env node\nsetTimeout(() => {}, 60_000)\n')
  const result = await installViaCli({ dshBin: bin, profile: 'web', spec: 'dsh-x@1.0.0', timeoutMs: 150 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.match(result.detail, /timed out after 150ms/)
})

test('installViaCli runs a .js CLI through the current node binary', async (t) => {
  const dir = makeTempDir(t)
  const bin = writeScript(join(dir, 'dsh.js'), 'process.stdout.write("via node\\n")\n', 0o644)
  const result = await installViaCli({ dshBin: bin, profile: 'web', spec: 'dsh-x@1.0.0' })
  assert.equal(result.ok, true)
  assert.equal(result.stdout, 'via node\n')
})

test('installViaCli reports a missing binary and missing arguments', async () => {
  const missing = await installViaCli({ dshBin: '/definitely/not/a/dsh', profile: 'web', spec: 'dsh-x' })
  assert.equal(missing.ok, false)
  assert.match(missing.detail, /cannot run/)
  assert.equal(missing.code, null)

  const noBin = await installViaCli({ profile: 'web', spec: 'dsh-x' })
  assert.equal(noBin.ok, false)
  assert.match(noBin.detail, /CLI path is required/)

  const noArgs = await installViaCli({ dshBin: '/usr/bin/dsh' })
  assert.equal(noArgs.ok, false)
  assert.match(noArgs.detail, /profile and spec are required/)
})
