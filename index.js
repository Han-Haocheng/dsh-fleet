/**
 * dsh-fleet Host half.
 *
 * One manifest (`$DSH_HOME/fleet.yml`) describes which bundles, model providers
 * and config rows belong to which profiles. This plugin renders that manifest
 * into per-profile managed blocks, reconciles `dsh.profile.bundles`, installs
 * missing packages through the official plugin-manager service (current
 * profile) or the official CLI (other CLI profiles), and exposes the same
 * capability to the browser page (`/api/fleet/*`) and to agents (`fleet` tool).
 *
 * Nothing here trusts the manifest: lib/plan.js validates every reference
 * before any file is written.
 */
import { appendFile, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'

import {
  MANIFEST_VERSION,
  parseManifest,
  validateManifest,
  resolveScope,
  isInScope,
  serializeManifest,
} from './lib/manifest.js'
import {
  renderManagedBlock,
  upsertManagedBlock,
  extractManagedBlock,
  reconcileBundles,
} from './lib/render.js'
import {
  homeFrom,
  discoverProfiles,
  readProfileState,
  readManifestFile,
  writeManifestFile,
  atomicWriteFile,
  acquireLock,
} from './lib/profile.js'
import { buildPlan, applyPlan } from './lib/plan.js'
import { capabilityFor, installInCurrentProfile, installViaCli } from './lib/install.js'

export const name = 'dsh-fleet'

/** No hard service dependencies: TUI has no webServer, and pluginManager/tools
 *  are resolved opportunistically so the page and the tool degrade separately. */
export const inject = []

const DEFAULTS = {
  manifestPath: 'fleet.yml',
  dshCommand: 'dsh',
  autoInstall: true,
}

const API_PREFIX = '/api/fleet'

/**
 * Resolve the manifest path. `~` means the DSH home (not the OS home), a
 * relative path resolves under it, and an absolute path is used as-is.
 */
function resolveManifestPath(configValue, home) {
  const raw = configValue || DEFAULTS.manifestPath
  if (raw === '~') return home
  if (raw.startsWith('~/')) return join(home, raw.slice(2))
  if (isAbsolute(raw)) return raw
  return join(home, raw)
}

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function nowIso() {
  return new Date().toISOString()
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function resolveEnv(ctx, config) {
  const profileContext = ctx.get('profileContext')
  const home = profileContext?.home ? expandHome(profileContext.home) : homeFrom()
  return {
    home,
    currentProfile: profileContext?.name ?? process.env.DSH_PROFILE ?? null,
    installAnchor: profileContext?.installAnchor ?? null,
    profileDir: profileContext?.dir ?? null,
    manifestPath: resolveManifestPath(config?.manifestPath, home),
    dshCommand: config?.dshCommand || process.env.DSH_FLEET_DSH || DEFAULTS.dshCommand,
    autoInstall: config?.autoInstall !== false,
    statePath: join(home, 'fleet.state.json'),
    lockPath: join(home, 'fleet.lock'),
  }
}

// ---------------------------------------------------------------------------
// Manifest IO
// ---------------------------------------------------------------------------

async function loadManifest(env) {
  try {
    const found = await readManifestFile(env.home)
    const text = found?.text ?? ''
    if (text.trim() === '') {
      return { manifest: null, errors: [`manifest not found: ${env.manifestPath}`] }
    }
    const parsed = parseManifest(text)
    return { manifest: parsed.manifest, errors: parsed.errors }
  } catch (error) {
    return { manifest: null, errors: [`cannot read manifest ${env.manifestPath}: ${errorText(error)}`] }
  }
}

async function saveManifest(env, manifest) {
  const text = serializeManifest(manifest)
  await writeManifestFile(env.home, text)
}

// ---------------------------------------------------------------------------
// Snapshot: profiles, states, live rows, plan
// ---------------------------------------------------------------------------

async function readCachedLastApplied(env) {
  try {
    const raw = await readFile(env.statePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed?.lastApplied ?? null
  } catch {
    return null
  }
}

async function readLockStatus(env) {
  try {
    const raw = await readFile(env.lockPath, 'utf8')
    const parsed = JSON.parse(raw)
    return { held: true, owner: parsed?.owner ?? parsed?.pid ?? null }
  } catch {
    return { held: false, owner: null }
  }
}

async function readStates(env, knownProfiles) {
  const states = new Map()
  for (const profile of knownProfiles) {
    try {
      states.set(profile, await readProfileState(env.home, profile, { installAnchor: env.installAnchor }))
    } catch (error) {
      states.set(profile, {
        name: profile,
        dir: join(env.home, 'profiles', profile),
        present: false,
        bundles: [],
        dependencies: {},
        patchText: '',
        installed: new Set(),
        rowIds: new Set(),
        error: errorText(error),
      })
    }
  }
  return states
}

/** Best-effort augmentation with the live loader rows of the current profile. */
async function augmentLiveRows(ctx, env, states) {
  const pluginManager = ctx.get('pluginManager')
  const state = states.get(env.currentProfile)
  if (!pluginManager?.listPlugins || state === undefined) return
  try {
    const rows = await pluginManager.listPlugins()
    for (const row of rows ?? []) {
      if (typeof row?.id === 'string') state.rowIds.add(row.id)
    }
  } catch {
    // Live rows are an optimization; patch replay remains the baseline.
  }
}

async function buildSnapshot(ctx, env) {
  const loaded = await loadManifest(env)
  const knownProfiles = loaded.manifest?.profiles?.length
    ? loaded.manifest.profiles
    : await discoverProfiles(env.home)
  const states = await readStates(env, knownProfiles)
  await augmentLiveRows(ctx, env, states)
  const snapshot = {
    manifest: loaded.manifest,
    manifestErrors: loaded.errors,
    knownProfiles,
    states,
    lastApplied: await readCachedLastApplied(env),
  }
  if (loaded.manifest !== null && loaded.errors.length === 0) {
    snapshot.plan = buildPlan({
      manifest: loaded.manifest,
      knownProfiles,
      states,
      capabilities: (target) => capabilityFor({ currentProfile: env.currentProfile, targetProfile: target }),
    })
  } else {
    snapshot.plan = { changes: [], errors: loaded.errors, pendingInstalls: [] }
  }
  return snapshot
}

// ---------------------------------------------------------------------------
// Status projection (what the page and the tool read)
// ---------------------------------------------------------------------------

function expectedEntries(snapshot, profile) {
  const { manifest, knownProfiles, states } = snapshot
  const state = states.get(profile)
  if (!manifest || !state) return null
  try {
    return renderManagedBlock({
      manifest,
      profile,
      knownProfiles,
      rowExists: (_profile, rowId) => state.rowIds.has(rowId),
    }).entries
  } catch {
    return null
  }
}

function currentBlockEntries(state) {
  if (!state?.patchText) return []
  const block = extractManagedBlock(state.patchText)
  if (!block?.present || !block.text) return []
  try {
    const parsed = YAML.parse(block.text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function itemEntryStatus(state, expected, current) {
  if (!state.present || expected === undefined || expected === null) return 'unknown'
  const actual = current.find((row) => row?.id === expected.id)
  if (actual === undefined) return expected.disabled === true ? 'in-sync' : 'drift'
  return sameValue(actual, expected) ? 'in-sync' : 'drift'
}

/** Base config shallow-merged with this profile's override, exactly like render.js. */
function effectiveConfig(entry, profile) {
  return { ...(entry.config ?? {}), ...(entry.overrides?.[profile]?.config ?? {}) }
}

function providerEntryStatus(state, manifest, provider, profile, knownProfiles) {
  if (!state.present) return 'unknown'
  // Providers are only materialized through the llm-pi-ai row. When that row
  // is not in this profile's scope, the profile keeps its own local provider
  // catalog and there is nothing for fleet to compare against.
  const carriers = (manifest.items ?? []).filter((item) => item?.id === 'llm-pi-ai')
  if (carriers.length === 0) return 'unknown'
  if (!carriers.some((item) => isInScope(item, profile, knownProfiles))) return 'out-of-scope'
  if (!isInScope(provider, profile, knownProfiles)) return 'out-of-scope'
  const override = provider.overrides?.[profile]
  if (override?.disabled === true || provider.disabled === true) return 'in-sync'
  const block = currentBlockEntries(state)
  const row = block.find((entry) => entry?.id === 'llm-pi-ai')
  const providers = row?.config?.providers
  if (providers === undefined || providers === null) return 'drift'
  return sameValue(providers[provider.key], effectiveConfig(provider, profile)) ? 'in-sync' : 'drift'
}

/** Optional manifest description, surfaced by the settings page hover card. */
function entryDescription(entry) {
  return typeof entry?.description === 'string' ? entry.description : undefined
}

/** Small, non-secret facts about one manifest entry for the hover card. */
function entryDetails(kind, entry) {
  if (kind === 'bundle') {
    return {
      spec: entry.spec,
      provides: Array.isArray(entry.provides) ? entry.provides : undefined,
      prune: entry.prune === true ? true : undefined,
    }
  }
  if (kind === 'provider') {
    const config = entry.config && typeof entry.config === 'object' ? entry.config : {}
    return {
      displayName: typeof config.displayName === 'string' ? config.displayName : undefined,
      api: typeof config.api === 'string' ? config.api : undefined,
      baseURL: typeof config.baseURL === 'string' ? config.baseURL : undefined,
      apiKeyEnv: typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv : undefined,
      models: Array.isArray(config.models) ? config.models.length : undefined,
    }
  }
  const config = entry.config && typeof entry.config === 'object' ? entry.config : undefined
  return {
    name: typeof entry.name === 'string' ? entry.name : undefined,
    configKeys: config ? Object.keys(config) : [],
    requires: Array.isArray(entry.requires) ? entry.requires : undefined,
  }
}

function buildItemList(snapshot) {
  const { manifest, knownProfiles, states } = snapshot
  if (!manifest) return []
  const expectedByProfile = new Map()
  const currentByProfile = new Map()
  for (const profile of knownProfiles) {
    expectedByProfile.set(profile, expectedEntries(snapshot, profile))
    currentByProfile.set(profile, currentBlockEntries(states.get(profile)))
  }
  const items = []

  for (const bundle of manifest.bundles) {
    const status = {}
    for (const profile of knownProfiles) {
      const state = states.get(profile)
      if (!state?.present) status[profile] = 'unknown'
      else if (!isInScope(bundle, profile, knownProfiles)) status[profile] = 'out-of-scope'
      else if (!state.installed.has(bundle.name)) status[profile] = 'missing'
      else status[profile] = state.bundles.includes(bundle.name) ? 'in-sync' : 'drift'
    }
    items.push({
      key: `bundle:${bundle.name}`,
      kind: 'bundle',
      label: bundle.name,
      spec: bundle.spec,
      scope: resolveScope(bundle, knownProfiles),
      status,
      description: entryDescription(bundle),
      details: entryDetails('bundle', bundle),
    })
  }

  for (const provider of manifest.providers) {
    const status = {}
    for (const profile of knownProfiles) {
      status[profile] = providerEntryStatus(states.get(profile), manifest, provider, profile, knownProfiles)
    }
    items.push({
      key: `provider:${provider.key}`,
      kind: 'provider',
      label: provider.key,
      spec: provider.config?.displayName ?? provider.key,
      scope: resolveScope(provider, knownProfiles),
      status,
      description: entryDescription(provider),
      details: entryDetails('provider', provider),
    })
  }

  for (const item of manifest.items) {
    const status = {}
    for (const profile of knownProfiles) {
      const state = states.get(profile)
      if (!state?.present) { status[profile] = 'unknown'; continue }
      if (!isInScope(item, profile, knownProfiles)) { status[profile] = 'out-of-scope'; continue }
      const expected = (expectedByProfile.get(profile) ?? []).find((entry) => entry.id === item.id) ?? null
      status[profile] = itemEntryStatus(state, expected, currentByProfile.get(profile) ?? [])
    }
    items.push({
      key: `item:${item.id}`,
      kind: 'item',
      label: item.id,
      spec: item.name ?? '',
      scope: resolveScope(item, knownProfiles),
      status,
      description: entryDescription(item),
      details: entryDetails('item', item),
    })
  }
  return items
}

function buildProfileList(snapshot) {
  const { knownProfiles, states, plan } = snapshot
  const changesByProfile = new Map()
  for (const change of plan.changes ?? []) {
    if (change.kind === 'install') continue
    changesByProfile.set(change.profile, (changesByProfile.get(change.profile) ?? 0) + 1)
  }
  const installsByProfile = new Map()
  for (const install of plan.pendingInstalls ?? []) {
    installsByProfile.set(install.profile, (installsByProfile.get(install.profile) ?? 0) + 1)
  }
  return knownProfiles.map((profile) => {
    const state = states.get(profile)
    return {
      name: profile,
      present: Boolean(state?.present),
      bundles: state?.bundles ?? [],
      inSync: (changesByProfile.get(profile) ?? 0) === 0 && (installsByProfile.get(profile) ?? 0) === 0,
      pendingChanges: (changesByProfile.get(profile) ?? 0) + (installsByProfile.get(profile) ?? 0),
      warnings: state?.error ? [state.error] : [],
    }
  })
}

function fileChanges(changes) {
  return (changes ?? []).filter((change) => change.kind !== 'install')
}

async function statusPayload(ctx, env, snapshotArg) {
  const snapshot = snapshotArg ?? (await buildSnapshot(ctx, env))
  return {
    manifestPath: env.manifestPath,
    manifestErrors: snapshot.manifestErrors,
    profiles: buildProfileList(snapshot),
    items: buildItemList(snapshot),
    lock: await readLockStatus(env),
    lastApplied: snapshot.lastApplied,
    currentProfile: env.currentProfile,
    plan: {
      changes: fileChanges(snapshot.plan.changes),
      errors: snapshot.plan.errors,
      pendingInstalls: snapshot.plan.pendingInstalls,
    },
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function targetProfiles(snapshot, requested) {
  const known = snapshot.knownProfiles
  if (Array.isArray(requested) && requested.length > 0) {
    return requested.filter((profile) => known.includes(profile))
  }
  return known.filter((profile) => snapshot.states.get(profile)?.present)
}

function filterPlan(plan, targets) {
  const wanted = new Set(targets)
  return {
    changes: plan.changes.filter((change) => wanted.has(change.profile)),
    errors: plan.errors,
    pendingInstalls: plan.pendingInstalls.filter((install) => wanted.has(install.profile)),
  }
}

async function planAction(ctx, env, { profiles } = {}) {
  const snapshot = await buildSnapshot(ctx, env)
  if (snapshot.manifestErrors.length > 0) {
    return { ok: false, errors: snapshot.manifestErrors, changes: [], pendingInstalls: [] }
  }
  const targets = targetProfiles(snapshot, profiles)
  const plan = filterPlan(snapshot.plan, targets)
  return { ok: plan.errors.length === 0, changes: fileChanges(plan.changes), errors: plan.errors, pendingInstalls: plan.pendingInstalls }
}

async function runInstalls(ctx, env, pendingInstalls) {
  const results = []
  for (const pending of pendingInstalls) {
    const capability = capabilityFor({ currentProfile: env.currentProfile, targetProfile: pending.profile })
    if (capability === 'service') {
      const pluginManager = ctx.get('pluginManager')
      if (!pluginManager?.installBundle) {
        results.push({ ...pending, status: 'failed', detail: 'pluginManager service is unavailable in this profile' })
        continue
      }
      try {
        const outcome = await installInCurrentProfile(pluginManager, pending.spec, {})
        results.push({
          ...pending,
          status: outcome.ok ? 'installed' : 'failed',
          detail: outcome.detail ?? '',
          restartRequired: Boolean(outcome.restartRequired),
        })
      } catch (error) {
        results.push({ ...pending, status: 'failed', detail: errorText(error) })
      }
      continue
    }
    if (capability === 'cli') {
      try {
        const outcome = await installViaCli({ dshBin: env.dshCommand, profile: pending.profile, spec: pending.spec })
        results.push({
          ...pending,
          status: outcome.ok ? 'installed' : 'failed',
          detail: outcome.detail ?? (outcome.ok ? '' : `${outcome.stderr ?? ''}`.slice(0, 2000)),
        })
      } catch (error) {
        results.push({ ...pending, status: 'failed', detail: errorText(error) })
      }
      continue
    }
    results.push({
      ...pending,
      status: 'manual',
      detail: 'desktop is a reserved profile: run the install from a dsh-fleet instance inside desktop (plugin_manager install_bundle)',
    })
  }
  return results
}

async function applyAction(ctx, env, { profiles, dryRun = false } = {}) {
  const lock = await acquireLock(env.home, { owner: `dsh-fleet:${env.currentProfile ?? 'unknown'}` })
  if (!lock.ok) {
    return { ok: false, errors: [`another dsh-fleet apply holds ${env.lockPath} (owner: ${lock.owner ?? 'unknown'})`] }
  }
  try {
    let snapshot = await buildSnapshot(ctx, env)
    if (snapshot.manifestErrors.length > 0) {
      return { ok: false, errors: snapshot.manifestErrors }
    }
    const targets = targetProfiles(snapshot, profiles)
    if (targets.length === 0) return { ok: false, errors: ['no target profile selected or present'] }
    let plan = filterPlan(snapshot.plan, targets)

    if (dryRun) {
      return { ok: plan.errors.length === 0, dryRun: true, targets, ...plan }
    }
    if (plan.errors.length > 0) {
      return { ok: false, errors: plan.errors, changes: plan.changes }
    }

    let installResults = []
    if (plan.pendingInstalls.length > 0) {
      if (!env.autoInstall) {
        return {
          ok: false,
          errors: ['missing packages and autoInstall is disabled'],
          pendingInstalls: plan.pendingInstalls,
        }
      }
      installResults = await runInstalls(ctx, env, plan.pendingInstalls)
      const failed = installResults.filter((result) => result.status === 'failed')
      if (failed.length > 0) {
        return {
          ok: false,
          errors: [`${failed.length} package installation(s) failed; no profile files were changed`],
          installResults,
          changes: plan.changes,
        }
      }
      const manual = installResults.filter((result) => result.status === 'manual')
      if (manual.length > 0) {
        return {
          ok: false,
          errors: manual.map((entry) => `${entry.profile}: ${entry.detail} (${entry.spec ?? entry.bundle})`),
          installResults,
          changes: plan.changes,
        }
      }
      snapshot = await buildSnapshot(ctx, env)
      plan = filterPlan(snapshot.plan, targets)
      if (plan.errors.length > 0) {
        return { ok: false, errors: plan.errors, installResults }
      }
    }

    const writeResult = await applyPlan({
      manifest: snapshot.manifest,
      knownProfiles: snapshot.knownProfiles,
      states: snapshot.states,
      plan,
      ctx,
    })
    if (writeResult.errors?.length > 0) {
      return { ok: false, errors: writeResult.errors, installResults }
    }

    const lastApplied = nowIso()
    try {
      await atomicWriteFile(
        env.statePath,
        JSON.stringify({ lastApplied, targets, changes: plan.changes.length, backups: writeResult.backups ?? [] }, null, 2),
      )
    } catch {
      // The state file is informational; a write failure must not fail the apply.
    }

    return {
      ok: true,
      applied: plan.changes,
      installResults,
      backups: writeResult.backups ?? [],
      restartRequired: installResults.filter((entry) => entry.restartRequired).map((entry) => entry.profile),
      lastApplied,
    }
  } finally {
    await lock.release()
  }
}

async function installAction(ctx, env, { profiles } = {}) {
  const snapshot = await buildSnapshot(ctx, env)
  if (snapshot.manifestErrors.length > 0) return { ok: false, errors: snapshot.manifestErrors }
  const targets = targetProfiles(snapshot, profiles)
  const plan = filterPlan(snapshot.plan, targets)
  if (plan.pendingInstalls.length === 0) {
    return { ok: true, results: [], errors: [], message: 'nothing to install' }
  }
  const results = await runInstalls(ctx, env, plan.pendingInstalls)
  const failed = results.filter((result) => result.status === 'failed')
  return { ok: failed.length === 0, results, errors: failed.map((entry) => `${entry.profile}: ${entry.detail}`) }
}

function findManifestEntry(manifest, key) {
  const separator = key.indexOf(':')
  if (separator < 0) return null
  const kind = key.slice(0, separator)
  const id = key.slice(separator + 1)
  if (kind === 'bundle') return manifest.bundles.find((bundle) => bundle.name === id) ?? null
  if (kind === 'provider') return manifest.providers.find((provider) => provider.key === id) ?? null
  if (kind === 'item') return manifest.items.find((item) => item.id === id) ?? null
  return null
}

async function scopeAction(ctx, env, { key, scope } = {}) {
  if (typeof key !== 'string' || key.trim() === '') {
    return { ok: false, errors: ['key is required, e.g. "bundle:dsh-mnemon" or "item:web"'] }
  }
  if (!Array.isArray(scope) || scope.some((entry) => typeof entry !== 'string')) {
    return { ok: false, errors: ['scope must be an array of profile names'] }
  }
  const lock = await acquireLock(env.home, { owner: `dsh-fleet:scope:${env.currentProfile ?? 'unknown'}` })
  if (!lock.ok) return { ok: false, errors: [`manifest is busy (owner: ${lock.owner ?? 'unknown'})`] }
  try {
    const loaded = await loadManifest(env)
    if (loaded.manifest === null) return { ok: false, errors: loaded.errors }
    const entry = findManifestEntry(loaded.manifest, key)
    if (entry === null) return { ok: false, errors: [`unknown entry: ${key}`] }
    const knownProfiles = loaded.manifest.profiles
    const normalized = scope.filter((profile) => knownProfiles.includes(profile))
    if (normalized.length !== scope.length) {
      return { ok: false, errors: [`unknown profile name(s): ${scope.filter((p) => !knownProfiles.includes(p)).join(', ')}`] }
    }
    entry.scope = normalized.length === knownProfiles.length ? ['all'] : normalized
    const errors = validateManifest(loaded.manifest, { knownProfiles })
    if (errors.length > 0) {
      return { ok: false, errors }
    }
    await saveManifest(env, loaded.manifest)
    return { ok: true, state: await statusPayload(ctx, env) }
  } catch (error) {
    return { ok: false, errors: [errorText(error)] }
  } finally {
    await lock.release()
  }
}

// ---------------------------------------------------------------------------
// HTTP surface (browser page)
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const GUARD_VERSION = '2'
const AUTH_COOKIE_MARK = 'dsh-auth-'

function isLoopback(req) {
  let address = req.socket?.remoteAddress ?? ''
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length)
  return LOOPBACK.has(address) || LOOPBACK.has(req.socket?.remoteAddress ?? '')
}

function authorityPort(authority) {
  try {
    const url = new URL(`http://${authority}`)
    return url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  } catch {
    return ''
  }
}

function isLoopbackAuthority(authority) {
  try {
    const name = new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, '')
    return name === '127.0.0.1' || name === 'localhost' || name === '::1'
  } catch {
    return false
  }
}

/**
 * Same-origin gate for mutations. Accepted when the browser proves it:
 *  - Origin matches the request Host (loopback aliases on one port count as
 *    the same local service: 127.0.0.1 == localhost == [::1]);
 *  - or the browser marks the request `Sec-Fetch-Site: same-origin|none`;
 *  - or an authenticated DSH browser session cookie is present.
 * GET/HEAD stay readable for diagnostics. Everything else is refused.
 */
function isSameOrigin(req) {
  const host = req.headers?.host ?? ''
  const origin = req.headers?.origin
  if (origin !== undefined && origin !== '') {
    try {
      const url = new URL(origin)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
      if (url.host === host) return true
      return (
        isLoopbackAuthority(url.host) &&
        isLoopbackAuthority(host) &&
        authorityPort(url.host) === authorityPort(host)
      )
    } catch {
      return false
    }
  }
  const site = req.headers?.['sec-fetch-site']
  if (site === 'same-origin' || site === 'none') return true
  const cookie = req.headers?.cookie
  if (typeof cookie === 'string' && cookie.includes(AUTH_COOKIE_MARK)) return true
  return req.method === 'GET' || req.method === 'HEAD'
}

/** Diagnostics for a refused request; cookie VALUE is never recorded. */
async function logRejection(env, req, reason) {
  try {
    const cookie = req.headers?.cookie
    const line = JSON.stringify({
      at: new Date().toISOString(),
      reason,
      method: req.method ?? null,
      url: req.url ?? null,
      host: req.headers?.host ?? null,
      origin: req.headers?.origin ?? null,
      secFetchSite: req.headers?.['sec-fetch-site'] ?? null,
      cookie: typeof cookie === 'string' && cookie.includes(AUTH_COOKIE_MARK) ? 'dsh-auth' : 'none',
      userAgent: req.headers?.['user-agent'] ?? null,
      remoteAddress: req.socket?.remoteAddress ?? null,
    })
    await appendFile(join(env.home, 'fleet.reject.log'), `${line}\n`)
  } catch {
    /* diagnostics never decide the request */
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-fleet-guard', GUARD_VERSION)
  res.end(payload)
}

async function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectPromise(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return resolvePromise({})
      try {
        return resolvePromise(JSON.parse(raw))
      } catch {
        return rejectPromise(new Error('invalid JSON body'))
      }
    })
    req.on('error', rejectPromise)
  })
}

function makeRoute(kind, path, method, handler, env) {
  return {
    kind,
    path,
    handler: async (req, res) => {
      try {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, errors: ['loopback only'] })
        if (!isSameOrigin(req)) {
          await logRejection(env, req, 'same-origin only')
          return sendJson(res, 403, { ok: false, errors: ['same-origin only'] })
        }
        const actual = (req.method ?? 'GET').toUpperCase()
        if (actual !== method) return sendJson(res, 405, { ok: false, errors: [`use ${method}`] })
        const body = method === 'POST' ? await readJsonBody(req) : {}
        const payload = await handler(body, req)
        if (payload !== undefined) return sendJson(res, 200, payload)
        return sendJson(res, 200, { ok: true })
      } catch (error) {
        return sendJson(res, 200, { ok: false, errors: [errorText(error)] })
      }
    },
  }
}

function makeRoutes(ctx, env) {
  return [
    makeRoute('exact', `${API_PREFIX}/state`, 'GET', async () => statusPayload(ctx, env), env),
    makeRoute('exact', `${API_PREFIX}/plan`, 'POST', async (body) => planAction(ctx, env, body), env),
    makeRoute('exact', `${API_PREFIX}/apply`, 'POST', async (body) => applyAction(ctx, env, body), env),
    makeRoute('exact', `${API_PREFIX}/install`, 'POST', async (body) => installAction(ctx, env, body), env),
    makeRoute('exact', `${API_PREFIX}/scope`, 'POST', async (body) => scopeAction(ctx, env, body), env),
  ]
}

// ---------------------------------------------------------------------------
// Agent tool
// ---------------------------------------------------------------------------

const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'plan', 'apply', 'scope', 'install'],
      description: 'status reads the matrix; plan is a dry run; apply writes managed blocks and bundle selections (installs missing packages first); scope changes one entry\'s profile lock; install only installs missing packages.',
    },
    profiles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Profile names to limit plan/apply/install to. Omit for every present profile.',
    },
    key: {
      type: 'string',
      description: 'For action=scope: entry key such as "bundle:dsh-mnemon", "provider:openmodel" or "item:web".',
    },
    scope: {
      type: 'array',
      items: { type: 'string' },
      description: 'For action=scope: allowed profile names; the entry is disabled everywhere else.',
    },
    dryRun: {
      type: 'boolean',
      description: 'For action=apply: report the plan without writing files or installing packages.',
    },
  },
  required: ['action'],
}

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

function makeTool(ctx, env) {
  return {
    name: 'fleet',
    description:
      'Manage this machine\'s DSH profiles from one manifest (~/.dsh/fleet.yml): which bundles, model providers and config rows belong to which profile, with scope locking. Use status first, then plan (dry run), then apply. Desktop package installs can only run from inside the desktop profile; other profiles install through the official dsh CLI.',
    parameters: TOOL_PARAMETERS,
    output: TOOL_OUTPUT,
    execute: async (args) => {
      const action = args?.action
      if (action === 'status') {
        return statusPayload(ctx, env)
      }
      if (action === 'plan') {
        const snapshot = await buildSnapshot(ctx, env)
        const targets = targetProfiles(snapshot, args?.profiles)
        const plan = filterPlan(snapshot.plan, targets)
        return { ok: plan.errors.length === 0, targets, ...plan, manifestErrors: snapshot.manifestErrors }
      }
      if (action === 'apply') {
        return applyAction(ctx, env, { profiles: args?.profiles, dryRun: args?.dryRun === true })
      }
      if (action === 'scope') {
        return scopeAction(ctx, env, { key: args?.key, scope: args?.scope })
      }
      if (action === 'install') {
        return installAction(ctx, env, { profiles: args?.profiles })
      }
      return { ok: false, errors: [`unknown action: ${String(action)}`] }
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const env = resolveEnv(ctx, config)

  ctx.inject(['webServer'], (webContext) => {
    for (const route of makeRoutes(ctx, env)) {
      webContext.effect(
        () => webContext.webServer.register(route),
        `dsh-fleet: route ${route.path}`,
      )
    }
  })

  ctx.inject(['tools'], (toolContext) => {
    toolContext.effect(
      () => toolContext.tools.register(makeTool(ctx, env)),
      'dsh-fleet: tool',
    )
  })
}
