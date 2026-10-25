#!/usr/bin/env node
/**
 * dsh-fleet offline CLI: plan/apply/status without mounting a DSH profile.
 *
 * This is the bootstrap and recovery path. Inside a running profile, prefer the
 * `fleet` agent tool or the Profiles settings page: they can install packages
 * through the official plugin-manager service, while this script uses the
 * official `dsh plugin --profile <name> add` CLI (and refuses desktop, which is
 * a reserved profile that only the desktop carrier may manage).
 */
import { readFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'

import {
  parseManifest,
  validateManifest,
  resolveScope,
} from '../lib/manifest.js'
import {
  homeFrom,
  discoverProfiles,
  readProfileState,
  readManifestFile,
  acquireLock,
} from '../lib/profile.js'
import { buildPlan, applyPlan } from '../lib/plan.js'
import { capabilityFor, installViaCli } from '../lib/install.js'

function usage() {
  return `dsh-fleet — manage DSH profiles from one manifest

Usage:
  node scripts/fleet.mjs <status|plan|apply> [options]

Options:
  --home <dir>             DSH home (default: $DSH_HOME or ~/.dsh)
  --manifest <file>        manifest path (default: <home>/fleet.yml)
  --install-anchor <dir>   dsh installation dir used to resolve @deepseek-ai bundles
  --dsh-bin <path>         CLI used for installs (default: dsh)
  --profiles a,b           limit to these profiles
  --dry-run                plan only
  --no-install             do not install missing packages; refuse apply if any are missing
  --json                   machine-readable output

Exit codes: 0 success/no drift, 1 drift or actionable result, 2 error.
`
}

function parseArgs(argv) {
  const args = { command: null, flags: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      args.command = args.command ?? value
      continue
    }
    const [flag, inline] = value.slice(2).split('=', 2)
    if (flag === 'dry-run' || flag === 'json' || flag === 'no-install' || flag === 'help') {
      args.flags[flag] = true
      continue
    }
    args.flags[flag] = inline ?? argv[index + 1]
    if (inline === undefined && flag !== 'dry-run') index += 1
  }
  return args
}

function expandHome(path) {
  if (!path) return path
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return resolve(path)
}

/** Resolve a bare command name through PATH (fs.realpath alone resolves against cwd). */
async function resolveCommand(command) {
  if (command.includes('/') || command.includes('\\')) return realpath(command)
  const candidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of candidates) {
    const candidate = join(dir, command)
    if (!existsSync(candidate)) continue
    try { return await realpath(candidate) } catch { /* keep looking */ }
  }
  return null
}

/** Walk up from the resolved CLI to the package root named @deepseek-ai/dsh. */
async function detectInstallAnchor(dshBin) {
  try {
    const resolved = await resolveCommand(dshBin)
    if (resolved === null) return null
    let current = dirname(resolved)
    for (let depth = 0; depth < 10; depth += 1) {
      const manifestPath = join(current, 'package.json')
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
          if (manifest?.name === '@deepseek-ai/dsh') return current
        } catch {
          // Keep walking.
        }
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  } catch {
    // Detection is best effort; lib/profile falls back to profile node_modules.
  }
  return null
}

async function loadManifestFile(manifestPath, home) {
  const fromHome = await readManifestFile(home)
  if (manifestPath && resolve(expandHome(manifestPath)) !== resolve(join(home, 'fleet.yml'))) {
    try {
      return { text: await readFile(expandHome(manifestPath), 'utf8'), path: expandHome(manifestPath) }
    } catch (error) {
      return { error: `cannot read manifest ${manifestPath}: ${error.message}` }
    }
  }
  return { ...fromHome }
}

async function buildContext(args) {
  const home = expandHome(args.flags.home || process.env.DSH_HOME || homeFrom())
  const dshBin = args.flags['dsh-bin'] || process.env.DSH_FLEET_DSH || 'dsh'
  const installAnchor = args.flags['install-anchor']
    ? resolve(expandHome(args.flags['install-anchor']))
    : await detectInstallAnchor(dshBin)
  const file = await loadManifestFile(args.flags.manifest, home)
  const errors = []
  let manifest = null
  if (file.error) {
    errors.push(file.error)
  } else if (!file.text || file.text.trim() === '') {
    errors.push(`manifest not found: ${join(home, 'fleet.yml')}`)
  } else {
    const parsed = parseManifest(file.text)
    manifest = parsed.manifest
    errors.push(...parsed.errors)
  }
  const knownProfiles = manifest?.profiles?.length ? manifest.profiles : await discoverProfiles(home)
  if (manifest) errors.push(...validateManifest(manifest, { knownProfiles }))

  const states = new Map()
  for (const profile of knownProfiles) {
    try {
      states.set(profile, await readProfileState(home, profile, { installAnchor }))
    } catch (error) {
      states.set(profile, {
        name: profile,
        dir: join(home, 'profiles', profile),
        present: false,
        bundles: [],
        dependencies: {},
        patchText: '',
        installed: new Set(),
        rowIds: new Set(),
        error: error.message,
      })
    }
  }
  return {
    home,
    dshBin,
    installAnchor,
    manifest,
    manifestErrors: errors,
    knownProfiles,
    states,
    capabilities: (profile) => capabilityFor({ currentProfile: null, targetProfile: profile }),
  }
}

function selectProfiles(context, requested) {
  if (requested) return requested.split(',').map((entry) => entry.trim()).filter(Boolean)
  return context.knownProfiles.filter((profile) => context.states.get(profile)?.present)
}

function printPlan(context, plan, targets) {
  if (plan.errors.length > 0) {
    console.error('plan errors:')
    for (const error of plan.errors) console.error(`  - ${error}`)
  }
  for (const change of plan.changes) {
    if (change.kind === 'install') continue
    console.log(`[${change.profile}] ${change.kind}: ${change.detail}`)
  }
  for (const install of plan.pendingInstalls) {
    const manual = install.capability === 'manual' ? ' (manual: run from inside desktop)' : ''
    console.log(`[${install.profile}] install: ${install.spec}${manual}`)
  }
  if (plan.changes.length === 0 && plan.pendingInstalls.length === 0 && plan.errors.length === 0) {
    console.log(`in sync: ${targets.join(', ')}`)
  }
}

function printStatus(context, plan, targets) {
  const manifest = context.manifest
  if (!manifest) {
    console.log('manifest: not loaded')
    for (const error of context.manifestErrors) console.log(`  - ${error}`)
    return
  }
  console.log(`manifest: ${join(context.home, 'fleet.yml')}`)
  console.log(`install anchor: ${context.installAnchor ?? '(not detected)'}`)
  for (const profile of context.knownProfiles) {
    const state = context.states.get(profile)
    const changes = plan.changes.filter((change) => change.profile === profile && change.kind !== 'install').length
    const installs = plan.pendingInstalls.filter((install) => install.profile === profile).length
    const flags = []
    if (!state.present) flags.push('missing')
    if (changes > 0) flags.push(`${changes} change(s)`)
    if (installs > 0) flags.push(`${installs} install(s)`)
    console.log(`  ${profile}: ${flags.length === 0 ? 'in sync' : flags.join(', ')}${targets.includes(profile) ? '' : ' (not targeted)'}`)
  }
  for (const entry of [...manifest.bundles, ...manifest.providers, ...manifest.items]) {
    const label = entry.name ?? entry.key ?? entry.id
    console.log(`  - ${resolveScope(entry, context.knownProfiles).join(',')}: ${label}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command || args.command === 'help' || args.flags.help) {
    console.log(usage())
    return 0
  }
  if (!['status', 'plan', 'apply'].includes(args.command)) {
    console.error(`unknown command: ${args.command}`)
    console.error(usage())
    return 2
  }
  const context = await buildContext(args)
  const targets = selectProfiles(context, args.flags.profiles)
  if (context.manifestErrors.length > 0) {
    if (args.flags.json) {
      console.log(JSON.stringify({ ok: false, errors: context.manifestErrors }, null, 2))
    } else {
      console.error('manifest errors:')
      for (const error of context.manifestErrors) console.error(`  - ${error}`)
    }
    return 2
  }
  const plan = buildPlan({
    manifest: context.manifest,
    knownProfiles: context.knownProfiles,
    states: context.states,
    capabilities: context.capabilities,
  })
  const filtered = {
    changes: plan.changes.filter((change) => targets.includes(change.profile)),
    errors: plan.errors,
    pendingInstalls: plan.pendingInstalls.filter((install) => targets.includes(install.profile)),
  }

  if (args.command === 'status' || args.command === 'plan' || args.flags['dry-run']) {
    if (args.flags.json) {
      console.log(JSON.stringify({ ok: filtered.errors.length === 0, targets, ...filtered }, null, 2))
    } else if (args.command === 'status') {
      printStatus(context, filtered, targets)
    } else {
      printPlan(context, filtered, targets)
    }
    return filtered.changes.length > 0 || filtered.pendingInstalls.length > 0 || filtered.errors.length > 0 ? 1 : 0
  }

  if (filtered.errors.length > 0) {
    for (const error of filtered.errors) console.error(`error: ${error}`)
    return 2
  }

  // Installs first: never write a bundle selection pointing at a missing package.
  const manual = filtered.pendingInstalls.filter((install) => install.capability === 'manual')
  if (manual.length > 0 && !args.flags['no-install']) {
    for (const install of manual) {
      console.error(`manual install required: [${install.profile}] ${install.spec}`)
      console.error('  run it from a dsh-fleet instance inside desktop (plugin_manager install_bundle), then apply --profiles ' + install.profile)
    }
    return 2
  }
  if (!args.flags['no-install']) {
    for (const install of filtered.pendingInstalls) {
      const outcome = await installViaCli({ dshBin: context.dshBin, profile: install.profile, spec: install.spec })
      if (!outcome.ok) {
        console.error(`install failed: [${install.profile}] ${install.spec}`)
        console.error(outcome.detail ?? outcome.stderr ?? '')
        return 2
      }
      console.log(`installed [${install.profile}] ${install.spec}`)
    }
  }

  // Re-read states after installs so installed() sees the new packages.
  const refreshed = await buildContext(args)
  const refreshedPlan = buildPlan({
    manifest: refreshed.manifest,
    knownProfiles: refreshed.knownProfiles,
    states: refreshed.states,
    capabilities: refreshed.capabilities,
  })
  const applyable = {
    changes: refreshedPlan.changes.filter((change) => targets.includes(change.profile)),
    errors: refreshedPlan.errors,
    pendingInstalls: [],
  }
  const lock = await acquireLock(context.home, { owner: `fleet-cli:${process.pid}` })
  if (!lock.ok) {
    console.error(`another apply is running (owner: ${lock.owner ?? 'unknown'})`)
    return 2
  }
  try {
    const result = await applyPlan({
      manifest: refreshed.manifest,
      knownProfiles: refreshed.knownProfiles,
      states: refreshed.states,
      plan: applyable,
    })
    if (result.errors?.length > 0) {
      for (const error of result.errors) console.error(`error: ${error}`)
      return 2
    }
    if (args.flags.json) {
      console.log(JSON.stringify({ ok: true, targets, applied: applyable.changes, backups: result.backups ?? [] }, null, 2))
    } else {
      for (const change of applyable.changes) console.log(`[${change.profile}] ${change.kind}: ${change.detail}`)
      console.log(`applied to: ${targets.join(', ')}`)
      for (const backup of result.backups ?? []) console.log(`backup: ${backup}`)
    }
    return 0
  } finally {
    await lock.release()
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error?.stack ?? String(error))
    process.exit(2)
  },
)
