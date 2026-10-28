/**
 * The fleet browser half mounts as a sidebar panel, not as a settings section:
 * the settings page configures the control plugins, fleet controls sync, so its
 * entry point is the sidebar's global panel list and its body is a main panel.
 *
 * These checks stay static on purpose — client.js only runs inside the Harness
 * Web module loader, while the contract they pin is the registration shape plus
 * the sidebar package the client module must load first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the client no longer registers a settings section', () => {
  assert.doesNotMatch(CLIENT, /settings\.section/)
})

test('the client registers the fleet sidebar panel icon', () => {
  assert.match(CLIENT, /ctx\.slots\.inject\(\s*['"]sidebar\.panellist['"]/)
  assert.match(CLIENT, /name:\s*['"]sidebar\.panellist['"]/)
  assert.match(CLIENT, /id:\s*['"]fleet['"]/)
  assert.match(CLIENT, /order:\s*40/)
  assert.match(CLIENT, /label:\s*\(\)\s*=>\s*t\(\s*['"]title['"]\s*\)/)
})

test('the sidebar icon is an inline svg driven by size and active', () => {
  assert.match(CLIENT, /function FleetIcon\(\{\s*size,\s*active\s*\}\)/)
  assert.match(CLIENT, /viewBox:\s*['"]0 0 24 24['"]/)
  assert.match(CLIENT, /stroke:\s*['"]currentColor['"]/)
  assert.match(CLIENT, /strokeWidth:\s*active\s*\?/)
  assert.match(CLIENT, /width:\s*edge/)
  assert.match(CLIENT, /height:\s*edge/)
})

test('the client registers the fleet main panel by key', () => {
  assert.match(CLIENT, /ctx\.slots\.inject\(\s*['"]main['"]/)
  assert.match(CLIENT, /\{\s*name:\s*['"]main['"],\s*key:\s*['"]fleet['"]\s*\}/)
})

test('the client keeps its locale/slots injection', () => {
  assert.match(CLIENT, /inject:\s*\[\s*['"]locale['"]\s*,\s*['"]slots['"]\s*\]/)
})

test('package.json injects the sidebar client package', () => {
  const client = PACKAGE?.dsh?.client
  assert.equal(client?.platform, 'web')
  assert.equal(client?.immediately, true)
  assert.ok(Array.isArray(client?.inject), 'dsh.client.inject must be an array')
  assert.ok(client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  assert.ok(!client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
})
