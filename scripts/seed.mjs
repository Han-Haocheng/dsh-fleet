#!/usr/bin/env node
/**
 * One-time bootstrap: derive `~/.dsh/fleet.yml` from the current web / dsh-tui /
 * desktop profiles. The scope table below is a design decision, not a dump:
 * each entry records which profiles may carry it. Re-run only when adopting an
 * existing hand-managed setup; afterwards the manifest is the source of truth.
 *
 * Usage: node scripts/seed.mjs [--home <dir>] [--dry-run]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const homeFlag = process.argv.includes('--home') ? process.argv[process.argv.indexOf('--home') + 1] : null
const home = homeFlag ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sourceProfiles = ['web', 'desktop', 'dsh-tui']

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function rowsOf(profile) {
  const dir = join(home, 'profiles', profile)
  const text = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
  const entries = YAML.parse(text) ?? []
  const map = new Map()
  for (const group of entries) {
    if (Array.isArray(group?.insert)) {
      for (const row of group.insert) if (row?.id) map.set(row.id, row)
      continue
    }
    if (group?.id && !group.insert) {
      const previous = map.get(group.id) ?? {}
      map.set(group.id, { ...previous, ...group })
    }
  }
  return map
}

const rows = Object.fromEntries(await Promise.all(sourceProfiles.map(async (p) => [p, await rowsOf(p)])))
const packages = Object.fromEntries(await Promise.all(sourceProfiles.map(async (p) => [
  p, await readJson(join(home, 'profiles', p, 'package.json'), {}),
])))

function row(profile, id) {
  const found = rows[profile]?.get(id)
  if (!found) throw new Error(`seed: row ${id} not found in profile ${profile}`)
  return found
}
function configOf(profile, id) { return row(profile, id).config ?? {} }
function versionOf(profile, packageName) {
  return packages[profile]?.dependencies?.[packageName]?.replace(/^[^0-9]*/, '') || null
}
async function installedVersion(profile, packageName) {
  const path = join(home, 'profiles', profile, 'node_modules', packageName, 'package.json')
  const pkg = await readJson(path, null)
  return pkg?.version ?? null
}

const webAllVersion = await installedVersion('web', '@linxin666/dsh-web-all')
const dropCaretVersion = await installedVersion('web', 'dsh-drop-caret')
const opencodeSessionVersion = await installedVersion('web', 'dsh-opencode-session')
const freeSearchVersion = await installedVersion('web', 'dsh-free-search')
const mnemonVersion = await installedVersion('web', 'dsh-mnemon')
const opsSpec = packages.web?.dependencies?.['dsh-ops'] ?? 'github:T-Auto/dsh-ops#v0.3.1'
const tuiVersion = await installedVersion('dsh-tui', '@deepseek-harness-tui/dsh-tui')

// ---------------------------------------------------------------------------
// Scope table: bundles
// ---------------------------------------------------------------------------
const EXPERIMENTAL_ALL = [
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-auto-review',
]
const EXPERIMENTAL_WEB_DESKTOP = [
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-tool-worktree',
]

const bundles = [
  { name: '@linxin666/dsh-web-all', spec: `@linxin666/dsh-web-all@${webAllVersion ?? '0.4.8'}`, scope: ['web', 'desktop'] },
  { name: 'dsh-drop-caret', spec: `dsh-drop-caret@${dropCaretVersion ?? '0.2.3'}`, scope: ['web', 'desktop'] },
  { name: 'dsh-opencode-session', spec: `dsh-opencode-session@${opencodeSessionVersion ?? '0.1.1'}`, scope: ['web', 'desktop'] },
  { name: 'dsh-free-search', spec: `dsh-free-search@${freeSearchVersion ?? '0.9.15'}`, scope: ['all'], provides: ['ddg', 'fs-quality-fetch'] },
  { name: 'dsh-mnemon', spec: `dsh-mnemon@${mnemonVersion ?? '0.5.34'}`, scope: ['all'] },
  { name: 'dsh-ops', spec: opsSpec, scope: ['all'] },
  ...EXPERIMENTAL_ALL.map((name) => ({ name, spec: name, scope: ['all'] })),
  ...EXPERIMENTAL_WEB_DESKTOP.map((name) => ({ name, spec: name, scope: ['web', 'desktop'] })),
  { name: '@deepseek-harness-tui/dsh-tui', spec: `@deepseek-harness-tui/dsh-tui@${tuiVersion ?? '0.17.0'}`, scope: ['dsh-tui'] },
]

// ---------------------------------------------------------------------------
// Scope table: model providers (base = web catalog, TUI adds retry policy)
// ---------------------------------------------------------------------------
const providersConfig = configOf('web', 'llm-pi-ai').providers ?? {}
const tuiProviders = configOf('dsh-tui', 'llm-pi-ai').providers ?? {}
const providers = Object.entries(providersConfig).map(([key, config]) => {
  const entry = { key, scope: ['all'], config }
  const retryPolicy = tuiProviders[key]?.retryPolicy
  if (retryPolicy !== undefined) {
    entry.overrides = { 'dsh-tui': { config: { retryPolicy } } }
  }
  return entry
})

// ---------------------------------------------------------------------------
// Scope table: config rows
// ---------------------------------------------------------------------------
const fromWeb = (id, extra = {}) => ({ id, scope: ['web', 'desktop'], config: configOf('web', id), ...extra })
const fromDesktop = (id, extra = {}) => ({ id, scope: ['desktop'], config: configOf('desktop', id), ...extra })
const toggle = (id, scope = ['web', 'desktop']) => ({ id, scope, disabled: false })

const items = [
  { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', scope: ['all'], config: {} },
  {
    id: 'web',
    name: '@deepseek-ai/dsh-web',
    scope: ['all'],
    config: configOf('web', 'web'),
    overrides: { 'dsh-tui': { config: configOf('dsh-tui', 'web') } },
    requires: ['dsh-free-search'],
  },
  {
    id: 'agent-default-model',
    name: '@deepseek-ai/dsh-agent-default-model',
    scope: ['web', 'desktop'],
    config: configOf('web', 'agent-default-model'),
    overrides: { desktop: { config: configOf('desktop', 'agent-default-model') } },
  },
  { id: 'subagent', name: '@deepseek-ai/dsh-subagent', scope: ['all'], config: configOf('web', 'subagent') },
  fromWeb('permission'),
  fromWeb('ui-theme'),
  fromWeb('ui-settings-general'),
  {
    id: 'ui-chat',
    name: '@deepseek-ai/dsh-client-ui-chat',
    scope: ['web', 'desktop'],
    config: configOf('web', 'ui-chat'),
    overrides: { desktop: { config: configOf('desktop', 'ui-chat') } },
  },
  fromWeb('web-search-free'),
  {
    id: 'mnemon',
    name: 'dsh-mnemon',
    scope: ['web', 'desktop'],
    config: configOf('web', 'mnemon'),
    overrides: { desktop: { config: configOf('desktop', 'mnemon') } },
  },
  toggle('mnemon-strategy-auto-capture'),
  toggle('mnemon-strategy-light-context'),
  toggle('mnemon-strategy-scoped'),
  toggle('dsh-ops-background'),
  toggle('dsh-ops-ptc'),
  toggle('web-ui-ssh'),
  toggle('web-ui-liangshen'),
  toggle('web-ui-skill-explorer'),
  fromWeb('web-ui-session-archive'),
  fromWeb('web-ui-pet'),
  fromWeb('web-ui-skin-center'),
  { id: 'optional-terminal-pwsh', scope: ['web', 'desktop'], disabled: true, config: {} },
  fromDesktop('ui-settings-account'),
  fromDesktop('ui-settings'),
  fromDesktop('agent-preset-registry'),
  fromDesktop('plugin-market'),
  toggle('dsh-ops-panel', ['desktop']),
  toggle('dsh-ops-hide-official', ['desktop']),
]

const manifest = {
  version: 1,
  profiles: ['web', 'dsh-tui', 'desktop'],
  providers,
  bundles,
  items,
}

const text = [
  '# dsh-fleet manifest — 唯一真源。web / dsh-tui / desktop 三个 profile 的受管插件、',
  '# 模型 provider 与配置行都从这里渲染；每个条目的 scope 就是它的适用范围锁。',
  '# 由 scripts/seed.mjs 从既有 profile 生成，之后请直接编辑本文件。',
  YAML.stringify(manifest, { lineWidth: 0, aliasDuplicateObjects: false }),
].join('\n')

if (dryRun) {
  console.log(text)
  process.exit(0)
}
const target = join(home, 'fleet.yml')
if (existsSync(target)) {
  const backup = `${target}.bak-seed-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`
  await writeFile(backup, await readFile(target, 'utf8'))
  console.log(`backup: ${backup}`)
}
await writeFile(target, text)
console.log(`wrote ${target} (${bundles.length} bundles, ${providers.length} providers, ${items.length} items)`)
