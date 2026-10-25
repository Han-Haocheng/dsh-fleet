/**
 * Planning (pure) and applying (file writes only).
 *
 * `buildPlan` never writes and never throws on manifest content: it reports
 * validation errors, the changes each present profile needs, and the package
 * installs that must succeed before any file is rewritten. `applyPlan` performs
 * exactly the writes the plan implies — managed block, bundle selection, and
 * the out-of-scope `enforce` cleanup the renderer encodes — and nothing else.
 */
import { dirname, resolve } from 'node:path'
import { effectiveEntry, isInScope, validateManifest } from './manifest.js'
import { extractManagedBlock, hashEntries, reconcileBundles, renderManagedBlock, upsertManagedBlock } from './render.js'
import { writeProfileFiles } from './profile.js'
import { isNonEmptyString, isPlainObject, parseYaml } from './util.js'

/** Look a profile state up in a Map, array or name-keyed object. */
function stateFor(states, name) {
  if (states === null || states === undefined) return null
  if (states instanceof Map) return states.get(name) ?? null
  if (Array.isArray(states)) {
    for (const state of states) {
      if (isPlainObject(state) && state.name === name) return state
    }
    return null
  }
  if (isPlainObject(states)) {
    const state = states[name]
    return isPlainObject(state) ? state : null
  }
  return null
}

/** Normalize the profile universe a plan evaluates. */
function knownProfileList(manifest, knownProfiles) {
  if (Array.isArray(knownProfiles) && knownProfiles.length > 0) {
    return knownProfiles.filter(isNonEmptyString)
  }
  const declared = manifest?.profiles
  return Array.isArray(declared) ? declared.filter(isNonEmptyString) : []
}

/** Turn a bundle reconciliation into one human-readable detail line. */
function describeBundles(reconciliation) {
  const parts = []
  if (reconciliation.added.length > 0) parts.push(`add ${reconciliation.added.join(', ')}`)
  if (reconciliation.removed.length > 0) parts.push(`remove ${reconciliation.removed.join(', ')}`)
  return parts.length > 0 ? `bundle selection: ${parts.join('; ')}` : 'bundle selection is out of date'
}

/** Whether a state's `installed` field contains a name (Set or array). */
function stateHasInstalled(state, name) {
  if (state?.installed instanceof Set) return state.installed.has(name)
  if (Array.isArray(state?.installed)) return state.installed.includes(name)
  return false
}

/** Content hash of what a managed block actually contains (the header hash is advisory). */
function blockContentHash(blockText) {
  if (typeof blockText !== 'string') return null
  try {
    const parsed = parseYaml(blockText)
    return Array.isArray(parsed) ? hashEntries(parsed) : null
  } catch {
    return null
  }
}

/**
 * Build the changes one manifest implies for every declared profile.
 *
 * @param {object} options
 * @param {object} options.manifest - normalized manifest.
 * @param {string[]} options.knownProfiles - profile universe.
 * @param {Map<string, object> | object[] | Record<string, object>} options.states
 * @param {(profile: string) => 'service' | 'cli' | 'manual'} [options.capabilities]
 * @returns {{
 *   changes: { profile: string, kind: 'patch' | 'bundles' | 'manifest' | 'install', detail: string }[],
 *   errors: string[],
 *   pendingInstalls: { profile: string, bundle: string, spec: string, capability: string }[],
 * }}
 */
export function buildPlan({ manifest, knownProfiles, states, capabilities } = {}) {
  const changes = []
  const errors = []
  const pendingInstalls = []
  if (!isPlainObject(manifest)) {
    errors.push('manifest: missing or not a mapping')
    return { changes, errors, pendingInstalls }
  }

  const known = knownProfileList(manifest, knownProfiles)
  const declared = Array.isArray(manifest.profiles) ? manifest.profiles.filter(isNonEmptyString) : []
  const targets = declared.length > 0 ? declared : known
  const capability = typeof capabilities === 'function' ? capabilities : () => 'manual'
  const bundles = Array.isArray(manifest.bundles) ? manifest.bundles : []

  errors.push(...validateManifest(manifest, { knownProfiles: known }))

  for (const profile of targets) {
    const state = stateFor(states, profile)
    if (state === null) {
      if (Array.isArray(knownProfiles) && knownProfiles.length > 0 && !knownProfiles.includes(profile)) {
        errors.push(`unknown profile ${JSON.stringify(profile)}: not found under the Harness home's profiles/ directory`)
      }
      changes.push({ profile, kind: 'manifest', detail: 'profile state is unavailable; apply will skip it' })
      continue
    }
    if (state.present === false) {
      changes.push({ profile, kind: 'manifest', detail: 'profile directory does not exist yet; start that profile once, then plan again' })
      continue
    }

    const currentBundles = Array.isArray(state.bundles) ? state.bundles : []
    const reconciliation = reconcileBundles({ manifest, profile, knownProfiles: known, currentBundles })
    if (reconciliation.added.length > 0 || reconciliation.removed.length > 0) {
      changes.push({ profile, kind: 'bundles', detail: describeBundles(reconciliation) })
    }

    const rowExists = (_profile, rowId) => state.rowIds instanceof Set && state.rowIds.has(rowId)
    let rendered
    try {
      rendered = renderManagedBlock({ manifest, profile, knownProfiles: known, rowExists })
    } catch (renderError) {
      errors.push(`profile ${JSON.stringify(profile)}: cannot render the managed block: ${renderError?.message ?? renderError}`)
      continue
    }
    const patchText = typeof state.patchText === 'string' ? state.patchText : ''
    const block = extractManagedBlock(patchText)
    if (block === null || !block.complete) {
      changes.push({ profile, kind: 'patch', detail: block === null ? 'managed block is missing' : 'managed block is incomplete (missing its footer)' })
    } else if (block.hash !== rendered.hash || blockContentHash(block.text) !== rendered.hash) {
      changes.push({
        profile,
        kind: 'patch',
        detail: block.hash !== rendered.hash
          ? 'managed block is out of date'
          : 'managed block content was edited outside fleet; apply rewrites it',
      })
    }

    for (const bundle of bundles) {
      if (!isPlainObject(bundle)) continue
      if (!isInScope(bundle, profile, known)) continue
      if (effectiveEntry(bundle, profile).disabled) continue
      if (!isNonEmptyString(bundle.name) || !isNonEmptyString(bundle.spec)) continue
      if (stateHasInstalled(state, bundle.name)) continue
      const capabilityName = capability(profile) ?? 'manual'
      pendingInstalls.push({ profile, bundle: bundle.name, spec: bundle.spec, capability: capabilityName })
      changes.push({ profile, kind: 'install', detail: `install ${bundle.spec} (${capabilityName})` })
    }
  }

  return { changes, errors, pendingInstalls }
}

/**
 * Apply a plan to disk.
 *
 * Only profiles named by `plan.changes` are touched, so the Host can filter a
 * plan down to its target profiles (or to a profile subset) before calling
 * this. Each profile gets the managed block upserted and its bundle selection
 * reconciled; unchanged files are not rewritten.
 *
 * @returns {{
 *   written: { profile: string, dir: string, bundles: string[], patchChanged: boolean, bundlesChanged: boolean }[],
 *   backups: string[],
 *   errors: string[],
 * }}
 */
export function applyPlan({ manifest, knownProfiles, states, plan } = {}) {
  const written = []
  const backups = []
  const errors = []
  if (!isPlainObject(manifest)) {
    errors.push('manifest: missing or not a mapping')
    return { written, backups, errors }
  }
  if (!isPlainObject(plan)) {
    errors.push('plan: missing; run buildPlan first')
    return { written, backups, errors }
  }
  if (Array.isArray(plan.errors) && plan.errors.length > 0) {
    errors.push(...plan.errors)
    return { written, backups, errors }
  }

  const known = knownProfileList(manifest, knownProfiles)
  const declared = Array.isArray(manifest.profiles) ? manifest.profiles.filter(isNonEmptyString) : []
  const requested = new Set(
    (Array.isArray(plan.changes) ? plan.changes : [])
      .filter(isPlainObject)
      .map((change) => change.profile)
      .filter(isNonEmptyString),
  )
  const targets = declared.filter((profile) => requested.has(profile))

  for (const profile of targets) {
    const state = stateFor(states, profile)
    if (state === null) {
      errors.push(`profile ${JSON.stringify(profile)}: state is unavailable`)
      continue
    }
    if (state.present === false) {
      errors.push(`profile ${JSON.stringify(profile)}: directory does not exist; start that profile once, then apply again`)
      continue
    }
    if (!isNonEmptyString(state.dir)) {
      errors.push(`profile ${JSON.stringify(profile)}: state has no directory`)
      continue
    }
    const rowExists = (_profile, rowId) => state.rowIds instanceof Set && state.rowIds.has(rowId)
    const rendered = renderManagedBlock({ manifest, profile, knownProfiles: known, rowExists })
    const currentPatchText = typeof state.patchText === 'string' ? state.patchText : ''
    const nextPatchText = upsertManagedBlock(currentPatchText, rendered.text)
    const reconciliation = reconcileBundles({
      manifest,
      profile,
      knownProfiles: known,
      currentBundles: Array.isArray(state.bundles) ? state.bundles : [],
    })
    const profileDir = resolve(state.dir)
    const home = dirname(dirname(profileDir))
    try {
      const result = writeProfileFiles({
        home,
        name: profile,
        patchText: nextPatchText,
        bundles: reconciliation.bundles,
        dependencies: isPlainObject(state.dependencies) ? state.dependencies : {},
      })
      written.push({
        profile,
        dir: profileDir,
        bundles: reconciliation.bundles,
        patchChanged: nextPatchText !== currentPatchText,
        bundlesChanged: reconciliation.added.length > 0 || reconciliation.removed.length > 0,
      })
      backups.push(...(result.backups ?? []))
    } catch (writeError) {
      errors.push(`profile ${JSON.stringify(profile)}: ${writeError?.message ?? writeError}`)
    }
  }

  return { written, backups, errors }
}
