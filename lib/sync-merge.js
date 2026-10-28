/**
 * Fold a sync plan into renderer-ready manifest items while keeping the rows a
 * profile already manages locally.
 *
 * `planSync` only knows the source profile's rows. Folding that plan straight
 * into a manifest (as `buildSyncedManifest` does) silently drops every row that
 * exists only in a target profile: the next apply rewrites that profile's
 * managed block from the new manifest and the missing ids disappear. This
 * module therefore takes the plan *and* the target profiles' current managed
 * blocks and produces one item list:
 *
 *   origin: 'sync'  - rows the plan pushes, scoped to their plan targets
 *   origin: 'local' - rows read from a profile's managed block whose id the
 *                     plan does not cover for *that* profile, scoped there
 *
 * Local rows with equal content are merged into one item scoped to every
 * profile carrying that copy; rows with the same id but different content stay
 * separate items with single-profile scopes. Either way the renderer emits
 * exactly one entry per profile, so a merge never makes one profile inherit
 * another profile's local config.
 *
 * Everything here is pure and total: unreadable profile state is reported in
 * `warnings` and skipped, never thrown.
 */
import { extractManagedBlock } from './render.js'
import {
  isNonEmptyString,
  isPlainObject,
  parseYamlTolerant,
  stableJson,
  uniqueStrings,
} from './util.js'

/** Look one profile's state out of the `states` map (plain object tolerated). */
function stateFor(states, profile) {
  if (states instanceof Map) return states.get(profile)
  if (isPlainObject(states) && Object.hasOwn(states, profile)) return states[profile]
  return undefined
}

/** Look one source row out of the id-keyed map (plain object tolerated). */
function sourceRowFor(sourceRows, id) {
  if (sourceRows instanceof Map) return sourceRows.get(id)
  if (isPlainObject(sourceRows) && Object.hasOwn(sourceRows, id)) return sourceRows[id]
  return undefined
}

/** Best-effort message for a thrown value. */
function errorText(error) {
  return isNonEmptyString(error?.message) ? error.message : String(error)
}

/**
 * Fold a sync plan plus the target profiles' current rows into one item list.
 *
 * The returned manifest keeps every original top-level field (`version`,
 * `profiles`, `providers`, `bundles`, `sync`, …) and replaces `items` with the
 * generated list. Absent fields are not invented.
 *
 * Coverage is per profile: a pushed id suppresses the local row for the
 * profiles in that item's `scope` only. A profile outside the scope keeps its
 * own copy as a `local` item, because the rewrite would otherwise delete it.
 *
 * @param {object} options
 * @param {object} [options.manifest] - original manifest; copied, never mutated.
 * @param {{ rows: Array<{ id: string, targets: string[], action: 'push' | 'skip', changes: object[] }> }} [options.plan]
 *        `planSync()` result; only `action: 'push'` rows become items.
 * @param {Map<string, { id: string, name?: string, config: object }>} [options.sourceRows]
 *        source profile rows, keyed by row id.
 * @param {Map<string, { patchText?: string }>} [options.states]
 *        profile name → `readProfileState()` result.
 * @param {string[]} [options.knownProfiles] - profiles whose blocks are read.
 * @returns {{
 *   manifest: object,
 *   items: Array<{ id: string, scope: string[], config: object, origin: 'sync' | 'local' }>,
 *   warnings: string[],
 * }}
 */
export function buildSyncTargets(options = {}) {
  const { manifest, plan, sourceRows, states, knownProfiles } = options ?? {}
  const source = isPlainObject(manifest) ? manifest : {}
  const warnings = []
  const items = []
  /** id → { item, covered: Set<profile> } for the sync items already emitted. */
  const syncById = new Map()

  // 1) Rows the plan pushes: scoped to the plan targets and configured from the
  // source row. A push with no target is skipped: an empty scope would mean
  // "every profile" to the renderer.
  const planRows = Array.isArray(plan?.rows) ? plan.rows : []
  for (const row of planRows) {
    if (!isPlainObject(row) || row.action !== 'push') continue
    const id = isNonEmptyString(row.id) ? row.id : ''
    if (id === '') {
      warnings.push('plan row without an id: sync item skipped')
      continue
    }
    const scope = uniqueStrings(Array.isArray(row.targets) ? row.targets.filter(isNonEmptyString) : [])
    if (scope.length === 0) {
      warnings.push(`plan row ${JSON.stringify(id)}: push has no targets; sync item skipped`)
      continue
    }
    const sourceRow = sourceRowFor(sourceRows, id)
    if (!isPlainObject(sourceRow)) {
      warnings.push(`plan row ${JSON.stringify(id)}: no source row; sync item skipped`)
      continue
    }
    const existing = syncById.get(id)
    if (existing !== undefined) {
      // A duplicated plan row widens the existing scope instead of producing a
      // second item with the same id.
      existing.item.scope = uniqueStrings([...existing.item.scope, ...scope])
      for (const profile of scope) existing.covered.add(profile)
      continue
    }
    const item = {
      id,
      scope: [...scope],
      config: isPlainObject(sourceRow.config) ? sourceRow.config : {},
      origin: 'sync',
    }
    items.push(item)
    syncById.set(id, { item, covered: new Set(scope) })
  }

  // 2) Rows that only live in a profile's managed block. Anything already
  // covered for that same profile is left to the sync item.
  const known = Array.isArray(knownProfiles) ? uniqueStrings(knownProfiles.filter(isNonEmptyString)) : []
  /** `${id}\u0000${content}` → local item, so equal copies share one scope. */
  const localByContent = new Map()

  for (const profile of known) {
    const state = stateFor(states, profile)
    const patchText = typeof state?.patchText === 'string' ? state.patchText : undefined
    if (patchText === undefined) {
      warnings.push(`profile ${JSON.stringify(profile)}: no patch text; local rows skipped`)
      continue
    }

    let parsed
    try {
      const block = extractManagedBlock(patchText)
      if (block === null || block.present !== true) {
        warnings.push(`profile ${JSON.stringify(profile)}: no managed block; local rows skipped`)
        continue
      }
      parsed = parseYamlTolerant(block.text)
    } catch (error) {
      warnings.push(
        `profile ${JSON.stringify(profile)}: managed block could not be read (${errorText(error)}); local rows skipped`,
      )
      continue
    }
    if (!Array.isArray(parsed)) {
      warnings.push(`profile ${JSON.stringify(profile)}: managed block is not a valid row list; local rows skipped`)
      continue
    }

    const seen = new Set()
    for (const row of parsed) {
      if (!isPlainObject(row) || !isNonEmptyString(row.id)) continue
      // A duplicated id inside one block is malformed; the first row wins so a
      // single profile never renders the same id twice.
      if (seen.has(row.id)) continue
      seen.add(row.id)
      const covered = syncById.get(row.id)
      if (covered !== undefined && covered.covered.has(profile)) continue

      const config = isPlainObject(row.config) ? row.config : {}
      const key = `${row.id}\u0000${stableJson(config)}`
      const existing = localByContent.get(key)
      if (existing !== undefined) {
        existing.scope = uniqueStrings([...existing.scope, profile])
        continue
      }
      const item = { id: row.id, scope: [profile], config, origin: 'local' }
      localByContent.set(key, item)
      items.push(item)
    }
  }

  return { manifest: { ...source, items }, items, warnings }
}
