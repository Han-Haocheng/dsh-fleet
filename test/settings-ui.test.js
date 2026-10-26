/**
 * The settings surfaces: the row config is a dsh settings namespace (plugin
 * `Config` schema) and the TUI settings screen only renders a section a plugin
 * registers through `tuiSettingsSections`.
 *
 * These tests pin both halves of that contract without a running Harness: the
 * schema's defaults/validation, the section shape the TUI consumes, the
 * namespace fallback, and the "no settings services mounted" path (web-only or
 * headless compositions must not break).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { apply, Config, name as pluginName } from '../index.js'
import { makeHome, makeProfile, writeTextFile } from './helpers.js'

const MANIFEST = `version: 1
profiles:
  - web
bundles: []
providers: []
items: []
`

/**
 * Minimal cordis-like context. `services` lists the optional services the way
 * the Host would resolve them; `inject` hands back an object shaped like the
 * real service.
 */
function makeContext(home, { tui = true, settings = true, status = true, profile = 'dsh-tui' } = {}) {
  const record = { sections: [], configured: [], tools: [], statusFields: [] }
  const serviceFor = (dep) => {
    if (dep === 'tools') {
      return { effect: (fn) => fn(), tools: { register: (definition) => record.tools.push(definition) } }
    }
    if (dep === 'webServer') {
      return { effect: (fn) => fn(), webServer: { register: () => () => {} } }
    }
    if (dep === 'tuiSettingsSections' && tui) {
      return {
        effect: (fn) => fn(),
        tuiSettingsSections: {
          register: (section) => {
            record.sections.push(section)
            return () => {}
          },
        },
      }
    }
    if (dep === 'tuiStatus' && status) {
      return {
        effect: (fn) => fn(),
        tuiStatus: {
          setField: (key, text, options) => {
            record.statusFields.push({ key, text, options })
            return () => {}
          },
        },
      }
    }
    if (dep === 'settings' && settings) {
      return {
        effect: (fn) => fn(),
        settings: {
          configure: (presentation) => {
            record.configured.push(presentation)
            return () => {}
          },
        },
      }
    }
    return undefined
  }
  const ctx = {
    get(service) {
      if (service === 'profileContext') {
        return { home, name: profile, installAnchor: null, dir: join(home, 'profiles', profile) }
      }
      return undefined
    },
    inject(deps, callback) {
      for (const dep of deps) {
        const scoped = serviceFor(dep)
        if (scoped !== undefined) {
          callback(scoped)
          return
        }
      }
    },
    effect: (fn) => fn(),
    on: () => () => {},
    emit: () => {},
    logger: { warn() {}, info() {}, error() {} },
  }
  return { ctx, record }
}

function makeHomeWithManifest(t) {
  const home = makeHome(t)
  writeTextFile(join(home, 'fleet.yml'), MANIFEST)
  makeProfile(home, 'dsh-tui', { bundles: [] })
  return home
}

test('Config declares the three row knobs with defaults', () => {
  const result = Config['~standard'].validate({})
  assert.equal(result.issues, undefined, 'an empty config must validate (all fields default)')
  const value = result.value
  // Volatile fields resolve to live wrappers — dsh-settings only projects the
  // volatile subtree into a namespace form, so this is what makes the row
  // settings-editable at all.
  assert.equal(typeof value.manifestPath.get, 'function')
  assert.deepEqual(
    {
      manifestPath: value.manifestPath.get(),
      dshCommand: value.dshCommand.get(),
      autoInstall: value.autoInstall.get(),
      notifyOnDrift: value.notifyOnDrift.get(),
    },
    {
      manifestPath: 'fleet.yml',
      dshCommand: 'dsh',
      autoInstall: true,
      notifyOnDrift: true,
    },
  )
})

test('Config rejects a wrong value type', () => {
  const result = Config['~standard'].validate({ autoInstall: 'yes please' })
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0)
})

test('the TUI section exposes the manifest knobs and declares its own page', (t) => {
  const home = makeHomeWithManifest(t)
  const { ctx, record } = makeContext(home)
  apply(ctx, { manifestPath: 'fleet.yml' })

  assert.equal(record.sections.length, 1, 'exactly one section is registered')
  const section = record.sections[0]
  // No loader in this stub → the namespace falls back to the plugin name.
  assert.equal(section.ns, pluginName)
  assert.equal(section.page.id, 'dsh-fleet')
  assert.equal(section.title, 'Profiles (Fleet)')
  assert.equal(section.descriptions.zh, '多 Profile 管理')

  const fields = section.fields
  assert.deepEqual(
    fields.map((field) => [field.path.join('.'), field.kind]),
    [
      ['manifestPath', 'text'],
      ['autoInstall', 'boolean'],
      ['notifyOnDrift', 'boolean'],
      ['dshCommand', 'text'],
    ],
  )
  for (const field of fields) {
    assert.equal(typeof field.label, 'string')
    assert.equal(typeof field.descriptions.zh, 'string')
  }
})

test('the auto-generated settings card is suppressed for this row', (t) => {
  const home = makeHomeWithManifest(t)
  const { ctx, record } = makeContext(home)
  apply(ctx, { manifestPath: 'fleet.yml' })
  assert.deepEqual(record.configured, [{ auto: false }])
})

test('a web/headless composition without the settings services still loads', (t) => {
  const home = makeHomeWithManifest(t)
  const { ctx, record } = makeContext(home, { tui: false, settings: false })
  assert.doesNotThrow(() => apply(ctx, { manifestPath: 'fleet.yml' }))
  assert.equal(record.sections.length, 0)
  assert.equal(record.configured.length, 0)
  assert.equal(record.tools.length, 1, 'the agent tool still registers')
})
