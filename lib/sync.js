/**
 * Sync planning (pure): what to push from one profile's rows to the others,
 * and how to fold that plan into a manifest the existing renderer can eat.
 *
 * The Host layer owns everything impure: it reads the source profile's rows,
 * the target profiles' rows and the resolved `sync` policy, then hands them in
 * here. Both exports are total — malformed input yields a plan that records an
 * error (or a best-effort manifest) instead of throwing, so one bad manifest
 * cannot take down the settings page or the CLI.
 *
 * `rowTargets` intentionally mirrors `syncTargetsFor(resolved, rowId)` from the
 * sync-policy module. That module is implemented in parallel, so this file
 * duplicates the four rules instead of importing them: disabled policy, excluded
 * row, per-row disable, and per-row targets *replacing* the defaults. Keep the
 * two in step when either side changes.
 */
import { isNonEmptyString, isPlainObject, uniqueStrings } from './util.js'

/** Message used when the manifest carries no enabled sync policy. */
const SYNC_DISABLED = 'sync is not enabled in this manifest'

/**
 * Resolve the plan timestamp, tolerating a broken or missing clock.
 *
 * @param {(() => string) | undefined} now
 * @returns {string} caller-supplied timestamp, or the real clock.
 */
function timestamp(now) {
  if (typeof now === 'function') {
    try {
      const value = now()
      if (isNonEmptyString(value)) return value
    } catch {
      // A plan without a timestamp is worse than one a moment off the clock.
    }
  }
  return new Date().toISOString()
}

/** Best-effort message for a thrown value. */
function errorText(error) {
  return isNonEmptyString(error?.message) ? error.message : String(error)
}

/**
 * Normalize the source rows to `[rowId, row]` pairs.
 *
 * The contract is a Map; an id-keyed object or an array of rows is accepted too
 * so a caller that already holds rows in another shape need not rebuild one.
 *
 * @param {Map<string, object> | Record<string, object> | object[] | undefined} sourceRows
 * @returns {[string, object][]}
 */
function rowEntries(sourceRows) {
  if (sourceRows instanceof Map) return [...sourceRows.entries()]
  if (Array.isArray(sourceRows)) {
    return sourceRows.map((row) => [isNonEmptyString(row?.id) ? row.id : '', row])
  }
  if (isPlainObject(sourceRows)) return Object.entries(sourceRows)
  return []
}

/** The id to report for a row: its own `id`, else its key in the source map. */
function rowIdOf(row, key) {
  if (isNonEmptyString(row?.id)) return row.id
  return isNonEmptyString(key) ? key : ''
}

/**
 * Effective sync targets of one row.
 *
 * Mirrors `syncTargetsFor` from the sync-policy module: an empty list when
 * syncing is off, the row is excluded, or the row override disables it;
 * otherwise the override targets replace the policy defaults.
 *
 * @param {{enabled?: boolean, targets?: string[], exclude?: Set<string>, overrides?: Map<string, object>}} sync
 * @param {string} rowId
 * @returns {string[]}
 */
function rowTargets(sync, rowId) {
  const policy = isPlainObject(sync) ? sync : {}
  if (policy.enabled === false) return []
  if (policy.exclude instanceof Set && policy.exclude.has(rowId)) return []
  const override = policy.overrides instanceof Map ? policy.overrides.get(rowId) : undefined
  if (override?.enabled === false) return []
  const targets = override?.targets ?? policy.targets
  return Array.isArray(targets) ? targets.filter(isNonEmptyString) : []
}

/**
 * Evaluate the caller's automatic skip rule. A thrown callback becomes a plan
 * error rather than an exception, and an empty string means "do not skip".
 *
 * @param {((row: object) => string | undefined) | undefined} autoSkip
 * @param {object} row
 * @param {string[]} errors - collected errors (mutated).
 * @returns {string | undefined}
 */
function automaticSkip(autoSkip, row, errors) {
  if (typeof autoSkip !== 'function') return undefined
  let reason
  try {
    reason = autoSkip(row)
  } catch (error) {
    errors.push(`autoSkip for row ${JSON.stringify(row?.id ?? '')} failed: ${errorText(error)}`)
    return undefined
  }
  if (typeof reason === 'string') return reason === '' ? undefined : reason
  if (reason === undefined || reason === null || reason === false) return undefined
  return String(reason)
}

/**
 * Read one row config out of the `profile -> (rowId -> config)` structure.
 *
 * @param {Map<string, Map<string, object>> | Record<string, object> | undefined} targetRows
 * @param {string} profile
 * @param {string} rowId
 * @returns {{present: boolean, config: any}} `present` is false when the row is
 *          missing (or stored as `undefined`, which carries no config).
 */
function targetRowState(targetRows, profile, rowId) {
  const missing = { present: false, config: undefined }
  if (!(targetRows instanceof Map) && !isPlainObject(targetRows)) return missing
  let rows
  if (targetRows instanceof Map) rows = targetRows.get(profile)
  else if (Object.hasOwn(targetRows, profile)) rows = targetRows[profile]
  if (rows instanceof Map) {
    if (!rows.has(rowId)) return missing
    const config = rows.get(rowId)
    return config === undefined ? missing : { present: true, config }
  }
  if (isPlainObject(rows)) {
    if (!Object.hasOwn(rows, rowId)) return missing
    const config = rows[rowId]
    return config === undefined ? missing : { present: true, config }
  }
  return missing
}

/**
 * Structural equality for YAML/JSON values. Keys compare by name, not order;
 * arrays compare recursively here but are reported as one change by
 * {@link collectChanges}.
 */
function sameValue(left, right) {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameValue(value, right[index]))
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  }
  return false
}

/**
 * Append one change per differing value, recursing into objects.
 *
 * `from` is the target's current value and `to` the source's. Source keys come
 * first, then keys only the target carries; those are reported with
 * `to: undefined` because a push writes the source config as-is, so an extra
 * target field is a removal.
 *
 * @param {string} profile
 * @param {string[]} path
 * @param {any} from - target value at `path`.
 * @param {any} to - source value at `path`.
 * @param {object[]} changes - collected changes (mutated).
 */
function collectChanges(profile, path, from, to, changes) {
  if (isPlainObject(from) && isPlainObject(to)) {
    for (const key of Object.keys(to)) {
      collectChanges(profile, [...path, key], from[key], to[key], changes)
    }
    for (const key of Object.keys(from)) {
      if (Object.hasOwn(to, key)) continue
      collectChanges(profile, [...path, key], from[key], undefined, changes)
    }
    return
  }
  if (sameValue(from, to)) return
  changes.push({ profile, path, from, to })
}

/**
 * Changes needed to make one target row equal the source row.
 *
 * @returns {{profile: string, path: string[], from: any, to: any}[]}
 */
function targetChanges(profile, sourceConfig, target) {
  if (!target.present) return [{ profile, path: [], from: undefined, to: sourceConfig }]
  const changes = []
  collectChanges(profile, [], target.config, sourceConfig, changes)
  return changes
}

// ---------------------------------------------------------------------------
// Three-way comparison (P2)
// ---------------------------------------------------------------------------

/**
 * Normalize the `baseline` argument to the `rows` map the planner compares.
 *
 * The documented shape is `{ [rowId]: { [profile]: config } }` — the `rows`
 * value of `fleet.sync.json`. A full baseline document is accepted too, so a
 * caller that already holds `readBaseline().baseline` need not unwrap it.
 *
 * @param {any} baseline
 * @returns {Record<string, Record<string, any>>}
 */
function baselineRows(baseline) {
  if (!isPlainObject(baseline)) return {}
  // A full document is recognizable by its version/updatedAt marker; a row id
  // may legitimately be called `rows`, so plain rows are otherwise left alone.
  if (
    isPlainObject(baseline.rows) &&
    (baseline.version !== undefined || baseline.updatedAt !== undefined)
  ) {
    return baseline.rows
  }
  return baseline
}

/**
 * The base config recorded for one (row, target), or `undefined` when that pair
 * was never pushed successfully.
 *
 * @param {Record<string, Record<string, any>>} rows
 * @param {string} rowId
 * @param {string} profile
 * @returns {any}
 */
function baselineConfig(rows, rowId, profile) {
  if (!Object.hasOwn(rows, rowId)) return undefined
  const row = rows[rowId]
  if (!isPlainObject(row) || !Object.hasOwn(row, profile)) return undefined
  return row[profile]
}

/**
 * Recursively compare one value three ways.
 *
 * `base` is the last successfully pushed source value, `source` the current
 * source value and `target` what the target holds now:
 *
 *  - the source did not change (`source === base`) → leave the target alone,
 *    even when the target was edited locally;
 *  - the source changed and the target did not (`target === base`) → the write
 *    is safe and becomes one change;
 *  - both changed → a conflict, unless they converged on the same value;
 *  - wherever all three are objects the comparison recurses per key, so an
 *    edit to one nested field does not look like a rewrite of its parent.
 *
 * Arrays and scalars compare as whole values. `path` is the field path reported
 * to the caller; `from` is the target's current value (so a preview shows what
 * the push would overwrite) and `to` the source value (`undefined` = removal).
 *
 * @param {string} profile
 * @param {string[]} path
 * @param {any} base
 * @param {any} source
 * @param {any} target
 * @param {object[]} changes - collected safe changes (mutated).
 * @param {object[]} conflicts - collected conflicts (mutated).
 */
function collectThreeWayChanges(profile, path, base, source, target, changes, conflicts) {
  if (isPlainObject(base) && isPlainObject(source) && isPlainObject(target)) {
    const keys = []
    const seen = new Set()
    // Source keys first (the P1 order), then target-only and base-only keys.
    for (const value of [source, target, base]) {
      for (const key of Object.keys(value)) {
        if (seen.has(key)) continue
        seen.add(key)
        keys.push(key)
      }
    }
    for (const key of keys) {
      collectThreeWayChanges(profile, [...path, key], base[key], source[key], target[key], changes, conflicts)
    }
    return
  }
  if (sameValue(source, base)) return
  if (!sameValue(target, base)) {
    // Both sides moved; only a disagreement blocks the write. If they landed on
    // the same value the target is already correct and nothing is reported.
    if (!sameValue(source, target)) conflicts.push({ profile, path, base, source, target })
    return
  }
  changes.push({ profile, path, from: target, to: source })
}

/**
 * Plan a profile-to-profile row sync without touching the file system.
 *
 * Every row of `sourceRows` is visited (the manifest's `items` are not
 * consulted): its effective targets are read from the resolved policy, the
 * source profile itself is removed, and each target's current config is
 * diffed against the source.
 *
 * Two planning modes:
 *
 *  - **legacy (no `baseline` argument)**: a plain two-way diff. Every field the
 *    source and target disagree on is a change and pushing a row rewrites it
 *    wholesale. This is the P1 contract and is kept byte for byte so callers
 *    that have no baseline yet behave exactly as before.
 *  - **three-way (`baseline` supplied)**: `baseline[rowId][profile]` is the
 *    value the target last accepted. A field is written only when the source
 *    changed it and the target did not; when both changed it, the field is a
 *    conflict and the whole row is withheld. A target with no baseline entry is
 *    a first sync: an equal target is in sync, a differing one receives the
 *    whole row (`firstSync: true`) because there is no field-level ancestor.
 *
 * Skipping happens in this order: the caller's `autoSkip` reason (highest
 * priority), then no remaining target, then a row with no writable field.
 * Conflict rows are never pushed, even if other targets (or other fields on
 * the same target) are safe: one unresolved disagreement makes the row's
 * ownership ambiguous, and a partial write would hide it.
 *
 * @param {object} options
 * @param {string} options.sourceProfile - profile the rows are read from.
 * @param {{enabled:boolean,targets:string[],exclude:Set<string>,overrides:Map,errors:string[]}} options.sync
 *        resolved sync policy (see `resolveSync`).
 * @param {Map<string,{id:string,name?:string,config:object}>} options.sourceRows
 *        row id → row of the source profile.
 * @param {string[]} options.knownProfiles - profile universe; accepted for
 *        symmetry with `resolveSync`, whose targets are already concrete.
 * @param {Map<string, Map<string, object>>} [options.targetRows]
 *        profile → (row id → config); missing entries mean "target row absent".
 * @param {Record<string, Record<string, any>> | {rows: Record<string, Record<string, any>>}} [options.baseline]
 *        last pushed source config per row and target profile (the `rows` map of
 *        `fleet.sync.json`); omitted keeps the P1 two-way behaviour.
 * @param {(row: object) => string|undefined} [options.autoSkip]
 *        caller-computed skip reason, evaluated before the built-in reasons.
 * @param {() => string} [options.now] - clock for `generatedAt`.
 * @returns {{
 *   ok: boolean,
 *   sourceProfile: string,
 *   generatedAt: string,
 *   rows: {
 *     id: string,
 *     targets: string[],
 *     action: 'push' | 'skip' | 'conflict',
 *     reason?: string,
 *     firstSync?: boolean,
 *     changes: { profile: string, path: string[], from: any, to: any }[],
 *     conflicts?: { profile: string, path: string[], base: any, source: any, target: any }[],
 *   }[],
 *   errors: string[],
 * }} the plan; `ok` is true only when `errors` is empty.
 */
export function planSync(options) {
  const { sourceProfile, sync, sourceRows, targetRows, baseline, autoSkip, now } = options ?? {}
  const sourceName = isNonEmptyString(sourceProfile) ? sourceProfile : ''
  const generatedAt = timestamp(now)
  // `undefined` means "no baseline was read at all" and keeps the P1 two-way
  // contract. An explicitly supplied (possibly empty) baseline selects the
  // three-way mode, where a missing entry is a genuine first sync.
  const threeWay = baseline !== undefined
  const baseRows = threeWay ? baselineRows(baseline) : {}

  if (!isPlainObject(sync) || sync.enabled === false) {
    return {
      ok: false,
      sourceProfile: sourceName,
      generatedAt,
      rows: [],
      errors: [SYNC_DISABLED],
    }
  }

  const errors = []
  for (const message of Array.isArray(sync.errors) ? sync.errors : []) {
    if (isNonEmptyString(message)) errors.push(message)
  }

  const rows = []
  for (const [key, row] of rowEntries(sourceRows)) {
    const id = rowIdOf(row, key)
    if (id === '') continue
    const targets = uniqueStrings(rowTargets(sync, id)).filter((target) => target !== sourceName)
    const skipReason = automaticSkip(autoSkip, row, errors)
    if (skipReason !== undefined) {
      rows.push({ id, targets, action: 'skip', reason: skipReason, changes: [] })
      continue
    }
    if (targets.length === 0) {
      rows.push({ id, targets, action: 'skip', reason: 'no-target', changes: [] })
      continue
    }

    const sourceConfig = row?.config
    if (!threeWay) {
      // P1 contract: a plain two-way diff, no baseline bookkeeping.
      const changes = []
      for (const target of targets) {
        changes.push(...targetChanges(target, sourceConfig, targetRowState(targetRows, target, id)))
      }
      if (changes.length === 0) {
        rows.push({ id, targets, action: 'skip', reason: 'in-sync', changes })
      } else {
        rows.push({ id, targets, action: 'push', changes })
      }
      continue
    }

    const changes = []
    const conflicts = []
    let sawBaseline = false
    let firstSync = false
    for (const target of targets) {
      const base = baselineConfig(baseRows, id, target)
      const state = targetRowState(targetRows, target, id)
      const targetConfig = state.present ? state.config : undefined
      if (base === undefined) {
        // No ancestor for this pair: the whole row is the unit of comparison.
        // Equal means there is nothing to do; different means a first push
        // (there is no field-level basis for a narrower write).
        if (!sameValue(sourceConfig, targetConfig)) {
          changes.push({ profile: target, path: [], from: targetConfig, to: sourceConfig })
          firstSync = true
        }
        continue
      }
      sawBaseline = true
      collectThreeWayChanges(target, [], base, sourceConfig, targetConfig, changes, conflicts)
    }

    if (conflicts.length > 0) {
      // Conflict wins over a concurrent safe write: the row is withheld, but
      // both lists stay visible so a preview can explain exactly why.
      rows.push({ id, targets, action: 'conflict', changes, conflicts })
      continue
    }
    if (changes.length > 0) {
      const planned = { id, targets, action: 'push', changes }
      if (firstSync) planned.firstSync = true
      rows.push(planned)
      continue
    }
    rows.push({
      id,
      targets,
      action: 'skip',
      reason: sawBaseline ? 'no-source-change' : 'in-sync',
      changes: [],
    })
  }

  return {
    ok: errors.length === 0,
    sourceProfile: sourceName,
    generatedAt,
    rows,
    errors,
  }
}

/** Read one source row out of the Map/array/object shapes {@link rowEntries} accepts. */
function sourceRowFor(sourceRows, id) {
  if (sourceRows instanceof Map) return sourceRows.get(id)
  if (Array.isArray(sourceRows)) return sourceRows.find((row) => row?.id === id)
  if (isPlainObject(sourceRows) && Object.hasOwn(sourceRows, id)) return sourceRows[id]
  return undefined
}

/**
 * Fold a sync plan into the manifest shape the existing renderer consumes.
 *
 * The synced manifest keeps the original top level (`version`, `profiles`,
 * `providers`, `bundles`) but replaces `items` with one entry per pushed row:
 * `{ id, name?, scope: targets, config }`. Original items are dropped on
 * purpose — after a sync the source profile is the authority — and skipped
 * rows are reported separately instead of being carried over.
 *
 * @param {object} options
 * @param {object} options.manifest - manifest the plan was computed from.
 * @param {{rows: object[]}} options.plan - `planSync()` result.
 * @param {Map<string,{id:string,name?:string,config:object}>} options.sourceRows
 *        source rows, used to supply `name` and `config` for pushed items.
 * @returns {{ manifest: object, skipped: { id: string, reason: string }[] }}
 */
export function buildSyncedManifest({ manifest, plan, sourceRows } = {}) {
  const source = isPlainObject(manifest) ? manifest : {}
  const planRows = Array.isArray(plan?.rows) ? plan.rows : []
  const items = []
  const skipped = []
  const targetUnion = []

  for (const row of planRows) {
    if (!isPlainObject(row)) continue
    for (const target of Array.isArray(row.targets) ? row.targets : []) {
      if (isNonEmptyString(target) && !targetUnion.includes(target)) targetUnion.push(target)
    }
    const id = isNonEmptyString(row.id) ? row.id : ''
    if (id === '') continue
    if (row.action === 'push') {
      const sourceRow = sourceRowFor(sourceRows, id)
      const item = { id }
      if (isNonEmptyString(sourceRow?.name)) item.name = sourceRow.name
      item.scope = uniqueStrings(row.targets)
      item.config = sourceRow?.config
      items.push(item)
    } else if (row.action === 'skip') {
      const reason = isNonEmptyString(row.reason) ? row.reason : 'unknown'
      skipped.push({ id, reason })
    }
  }

  const output = {}
  if (source.version !== undefined) output.version = source.version
  output.profiles = Array.isArray(source.profiles) ? [...source.profiles] : targetUnion
  output.providers = Array.isArray(source.providers) ? [...source.providers] : []
  output.bundles = Array.isArray(source.bundles) ? [...source.bundles] : []
  output.items = items

  return { manifest: output, skipped }
}
