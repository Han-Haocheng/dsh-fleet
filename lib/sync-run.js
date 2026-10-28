/**
 * Host-side preparation of a profile-to-profile sync push.
 *
 * The pure modules own the rules: `resolveSync` turns the manifest's `sync`
 * section into a policy, `planSync` diffs the source rows against the target
 * profiles, and `buildSyncTargets` folds that plan into manifest items while
 * preserving rows only the target profiles manage locally. This module is the
 * one place that gathers the three inputs those rules need — the source rows,
 * the target profiles' *effective* rows, and the profile patch texts — and
 * reports every failure in one result object instead of throwing.
 *
 * Read-only: nothing here writes a file, installs a package or mutates the
 * manifest. A caller that wants to write takes the returned `merged.manifest`
 * through the normal `buildPlan`/`applyPlan` path.
 */
import { resolveSync } from './manifest.js'
import { resolveBundleDir } from './profile.js'
import { extractManagedBlock } from './render.js'
import { autoSkipReason, readSourceRows, rowsFromDump } from './source.js'
import { buildSyncTargets } from './sync-merge.js'
import { planSync } from './sync.js'
import { deepClone, isNonEmptyString, isPlainObject, parseYamlTolerant, stableJson } from './util.js'
import { dumpProfileConfig } from './verify.js'

/** Message used when the manifest carries no enabled sync policy. */
const SYNC_DISABLED = 'sync is not enabled in this manifest'

/** Message used when the Host did not report which profile it is running. */
const NO_SOURCE_PROFILE = 'the source profile is unknown (no profileContext)'

/**
 * Top-level loader rows start in column 0, so a newline followed by `- id: `
 * begins one. Nested sequences are indented and therefore never split.
 */
const TOP_LEVEL_ROW_START = /\n(?=- id: )/

/** The id of a row whose text begins with (or contains) the row header. */
const TOP_LEVEL_ROW_ID = /- id: (\S+)/

/** Look one profile's state out of the `states` map (plain object tolerated). */
function stateFor(states, profile) {
  if (states instanceof Map) return states.get(profile)
  if (isPlainObject(states) && Object.hasOwn(states, profile)) return states[profile]
  return undefined
}

/**
 * Split a patch text into its top-level row chunks.
 *
 * The split is textual on purpose: parsing the patch would either evaluate a
 * `!!js` expression or reject the unknown tag, and both scans below must work
 * on exactly the text the user wrote.
 *
 * @param {string | null | undefined} patchText
 * @returns {string[]} one chunk per top-level row; empty when there is no text.
 */
function topLevelRowChunks(patchText) {
  if (typeof patchText !== 'string' || patchText.trim() === '') return []
  return patchText.split(TOP_LEVEL_ROW_START)
}

/** The row id declared by one top-level chunk, or undefined for a stray chunk. */
function rowIdOfChunk(chunk) {
  const match = TOP_LEVEL_ROW_ID.exec(chunk)
  return match === null ? undefined : match[1]
}

/**
 * Collect the ids of top-level rows present in one profile patch text.
 *
 * A profile patch file holds the rows the user (or a previous dsh-fleet run)
 * actually declared for that profile; everything else a profile mounts is
 * inherited from a parent or contributed by a plugin, and must not be treated
 * as fleet-wide user state when a push is planned.
 *
 * The scan is deliberately textual, exactly like {@link jsRowIdsFromPatch}:
 * ids are recovered from the column-0 `- id: ` header lines only, so a nested
 * `- id:` inside a row's config is never mistaken for a row of its own.
 *
 * @param {string | null | undefined} patchText - one profile's `cordis.patch.yml`.
 * @returns {Set<string>} ids of the rows the patch declares (duplicates collapse).
 */
export function rowIdsFromPatch(patchText) {
  const ids = new Set()
  for (const chunk of topLevelRowChunks(patchText)) {
    const id = rowIdOfChunk(chunk)
    if (id !== undefined) ids.add(id)
  }
  return ids
}

/**
 * Collect the ids of top-level rows whose patch text still carries `!!js`.
 *
 * `readSourceRows` detects expressions structurally when the runtime
 * `configEditor` backend is used, but the CLI backend goes through
 * `dsh --dump-config`, which evaluates `!!js` before printing. The result then
 * looks exactly like a literal value and `autoSkipReason` cannot tell it apart.
 * Scanning the source profile's patch text closes that hole: a row that
 * declares an expression there is excluded regardless of which backend read
 * the rows.
 *
 * The scan is deliberately textual. Parsing the patch would either evaluate
 * the expression (the thing we must avoid) or reject an unknown `!!js` tag, so
 * names are recovered from the row header lines only.
 *
 * @param {string | null | undefined} patchText - source profile's patch file.
 * @returns {Set<string>} ids of rows that declare at least one `!!js` value.
 */
export function jsRowIdsFromPatch(patchText) {
  const ids = new Set()
  for (const chunk of topLevelRowChunks(patchText)) {
    if (!chunk.includes('!!js')) continue
    const id = rowIdOfChunk(chunk)
    if (id !== undefined) ids.add(id)
  }
  return ids
}

/**
 * Union of the top-level row ids declared by every known profile's patch text.
 *
 * An empty set means "no patch text was available" rather than "no row is
 * user state": a Host whose `states` map is missing must still preview a push
 * instead of silently skipping every row.
 *
 * @param {Map<string, { patchText?: string }> | Record<string, { patchText?: string }>} states
 * @param {string[]} knownProfiles
 * @returns {Set<string>} union of every known profile's patch row ids.
 */
function profileRowIdsFromStates(states, knownProfiles) {
  const ids = new Set()
  const profiles = Array.isArray(knownProfiles) ? knownProfiles.filter(isNonEmptyString) : []
  for (const profile of profiles) {
    for (const id of rowIdsFromPatch(stateFor(states, profile)?.patchText)) ids.add(id)
  }
  return ids
}

/**
 * Normalize the caller's `allowedRowIds` option (Set or array) into trimmed ids.
 *
 * @param {Set<string> | string[] | undefined} value
 * @returns {Set<string> | null} the normalized set, or null when nothing usable
 *          was supplied (so the default union applies). An empty Set is treated
 *          like "unknown" by the caller, matching the default path.
 */
function allowedRowIdSet(value) {
  let entries = null
  if (value instanceof Set) entries = [...value]
  else if (Array.isArray(value)) entries = value
  if (entries === null) return null
  const ids = new Set()
  for (const entry of entries) {
    if (isNonEmptyString(entry)) ids.add(entry.trim())
  }
  return ids
}

/** Best-effort message for a thrown value. */
function errorText(error) {
  return isNonEmptyString(error?.message) ? error.message : String(error)
}

/**
 * Read the target profiles' current managed-block rows.
 *
 * Each profile maps row id → config. A missing state, a missing managed block
 * and a block that is not valid YAML all yield an empty map: a target that
 * cannot be read is "the row is absent", which makes the plan report the whole
 * source config as a change. Duplicated ids keep the first row, matching the
 * renderer's one-entry-per-id rule.
 *
 * @param {Map<string, { patchText?: string }> | Record<string, { patchText?: string }>} states
 * @param {string[]} knownProfiles
 * @returns {Map<string, Map<string, object>>} profile → (row id → config).
 */
export function targetRowsFromStates(states, knownProfiles) {
  const targetRows = new Map()
  const profiles = Array.isArray(knownProfiles) ? knownProfiles.filter(isNonEmptyString) : []
  for (const profile of profiles) {
    const rows = new Map()
    const patchText = stateFor(states, profile)?.patchText
    if (typeof patchText === 'string' && patchText.trim() !== '') {
      const block = extractManagedBlock(patchText)
      if (block?.present === true) {
        const parsed = parseYamlTolerant(block.text)
        if (Array.isArray(parsed)) {
          for (const row of parsed) {
            if (!isPlainObject(row) || !isNonEmptyString(row.id) || rows.has(row.id)) continue
            rows.set(row.id, isPlainObject(row.config) ? row.config : {})
          }
        }
      }
    }
    targetRows.set(profile, rows)
  }
  return targetRows
}

/**
 * Read the current config of one target row out of the
 * `profile -> (row id -> config)` map built above.
 *
 * @param {Map<string, Map<string, object>>} targetRows
 * @param {string} profile
 * @param {string} rowId
 * @returns {{present: boolean, config: any}}
 */
function targetRowState(targetRows, profile, rowId) {
  const missing = { present: false, config: undefined }
  if (!(targetRows instanceof Map)) return missing
  const rows = targetRows.get(profile)
  if (!(rows instanceof Map) || !rows.has(rowId)) return missing
  const config = rows.get(rowId)
  return config === undefined ? missing : { present: true, config }
}

/** Read one source row out of the id-keyed Map (plain object tolerated). */
function sourceRowFor(sourceRows, id) {
  if (sourceRows instanceof Map) return sourceRows.get(id)
  if (Array.isArray(sourceRows)) return sourceRows.find((row) => row?.id === id)
  if (isPlainObject(sourceRows) && Object.hasOwn(sourceRows, id)) return sourceRows[id]
  return undefined
}

/** The package a row configures, or `''` for a built-in (nameless) row. */
function packageNameOf(row) {
  return isNonEmptyString(row?.name) ? row.name.trim() : ''
}

/** The target's installed-package set, only when the Host reported one. */
function installedPackages(state) {
  return state?.installed instanceof Set ? state.installed : undefined
}

/**
 * One package version out of a `Map` or a plain object, as
 * `readProfileState()` reports it.
 *
 * @param {Map<string, string> | Record<string, string> | undefined} versions
 * @param {string} name
 * @returns {string | undefined}
 */
function packageVersion(versions, name) {
  if (!isNonEmptyString(name)) return undefined
  if (versions instanceof Map) {
    const value = versions.get(name)
    return isNonEmptyString(value) ? value : undefined
  }
  if (isPlainObject(versions) && Object.hasOwn(versions, name)) {
    const value = versions[name]
    return isNonEmptyString(value) ? value : undefined
  }
  return undefined
}

/** Skip reason used when a named row's package is not installed on a target. */
const PLUGIN_MISSING = 'plugin-missing'

/**
 * Drop sync targets that cannot carry a named row, and advertise version drift.
 *
 * A row with a package `name` is a plugin row: pushing it to a profile that does
 * not have the package would write config into a profile that will never mount
 * it. Such a target is skipped with reason `plugin-missing` (the row's other
 * targets continue); when the package is present on both sides but at different
 * versions the row is still pushed and a warning records the mismatch.
 *
 * Nameless rows (DSH built-ins) carry no package identity, so they are never
 * availability-gated.
 *
 * The plan rows are mutated in place: this is the last planning step before the
 * merge, and every consumer downstream (merge, preview, baseline) must see the
 * same effective target list. Skipped profiles are reported on the row as
 * `skippedTargets` and never appear in `changes`, `conflicts` or `targets`.
 *
 * @param {object} options
 * @param {object | null} options.plan - `planSync()` result.
 * @param {Map<string, object>} options.sourceRows - source profile rows.
 * @param {Map<string, object>} [options.states] - `readProfileState()` results.
 * @param {string} options.sourceProfile - profile the rows were read from.
 * @param {string[]} options.warnings - collected warnings (mutated).
 * @returns {object | null} the same plan, gated.
 */
function gatePlanAvailability({ plan, sourceRows, states, sourceProfile, warnings, installAnchor }) {
  const rows = Array.isArray(plan?.rows) ? plan.rows : []
  const sourceState = stateFor(states, sourceProfile)
  for (const row of rows) {
    if (!isPlainObject(row) || !Array.isArray(row.targets)) continue
    const name = packageNameOf(sourceRowFor(sourceRows, row.id))
    if (name === '') continue

    // A profile's package.json lists only what it declares itself; DSH core
    // packages live in the installation tree. Resolve through both the profile
    // directory and the install anchor before calling a row's package missing.
    const available = (state) => {
      const installed = installedPackages(state)
      if (installed === undefined) return true
      if (installed.has(name)) return true
      return resolveBundleDir(name, state?.dir, installAnchor) !== null
    }
    const sourceVersion = packageVersion(sourceState?.versions, name)
    // A row that is already skipped (self, expression, empty config, …) is not
    // pushed anywhere, so version drift about it is noise.
    const mayPush = row.action === 'push' || row.action === 'conflict'
    const kept = []
    const skipped = []
    for (const target of row.targets) {
      if (!isNonEmptyString(target)) continue
      const state = stateFor(states, target)
      if (!available(state)) {
        skipped.push({ profile: target, reason: PLUGIN_MISSING })
        continue
      }
      kept.push(target)
      if (mayPush && sourceVersion !== undefined) {
        const targetVersion = packageVersion(state?.versions, name)
        if (targetVersion !== undefined && targetVersion !== sourceVersion) {
          warnings.push(`version mismatch for ${row.id} on ${target}: ${sourceVersion} -> ${targetVersion}`)
        }
      }
    }
    if (skipped.length === 0) continue

    row.skippedTargets = skipped
    row.targets = kept
    const keptProfiles = new Set(kept)
    if (Array.isArray(row.changes)) {
      row.changes = row.changes.filter((change) => keptProfiles.has(change?.profile))
    }
    if (Array.isArray(row.conflicts)) {
      row.conflicts = row.conflicts.filter((conflict) => keptProfiles.has(conflict?.profile))
    }
    if (row.action === 'push' || row.action === 'conflict') {
      if (Array.isArray(row.conflicts) && row.conflicts.length > 0) {
        row.action = 'conflict'
      } else if (Array.isArray(row.changes) && row.changes.length > 0) {
        row.action = 'push'
        delete row.conflicts
      } else {
        delete row.conflicts
        delete row.firstSync
        row.action = 'skip'
        row.reason = kept.length === 0 ? PLUGIN_MISSING : 'in-sync'
      }
    }
  }
  return plan
}

// ---------------------------------------------------------------------------
// Three-way write shape (P2)
// ---------------------------------------------------------------------------

/** Normalize a `baseline` argument to the `rows` map, tolerating the document. */
function baselineRows(baseline) {
  if (!isPlainObject(baseline)) return {}
  if (
    isPlainObject(baseline.rows) &&
    (baseline.version !== undefined || baseline.updatedAt !== undefined)
  ) {
    return baseline.rows
  }
  return baseline
}

/** The recorded base for one (row, profile), or undefined when never pushed. */
function baselineConfig(rows, rowId, profile) {
  if (!Object.hasOwn(rows, rowId)) return undefined
  const row = rows[rowId]
  if (!isPlainObject(row) || !Object.hasOwn(row, profile)) return undefined
  return row[profile]
}

/**
 * Restrict each push row's scope to the profiles that actually have a safe
 * field to write.
 *
 * `buildSyncTargets` scopes an item to every plan target, so a profile that is
 * already in sync would be rewritten with the source's whole config — exactly
 * the P1 behaviour P2 removes. Narrowing the scope here lets the merge emit the
 * row only where a write is needed; every other profile keeps its own managed
 * block entry as a `local` item.
 *
 * @param {object} plan
 * @returns {object}
 */
function planForWrite(plan) {
  if (!isPlainObject(plan) || !Array.isArray(plan.rows)) return plan
  return {
    ...plan,
    rows: plan.rows.map((row) => {
      if (!isPlainObject(row) || row.action !== 'push' || !Array.isArray(row.changes)) return row
      const writable = new Set(
        row.changes.map((change) => change?.profile).filter((profile) => isNonEmptyString(profile)),
      )
      return { ...row, targets: (row.targets ?? []).filter((target) => writable.has(target)) }
    }),
  }
}

/** Set (or, with `undefined`, delete) one value inside a plain-object tree. */
function setAtPath(root, path, value) {
  let node = root
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    if (!isPlainObject(node[key])) {
      if (value === undefined) return root
      node[key] = {}
    }
    node = node[key]
  }
  const last = path[path.length - 1]
  if (value === undefined) delete node[last]
  else node[last] = value
  return root
}

/**
 * The config one target should carry after this push.
 *
 * Starting from the target's *effective* config (the same value the three-way
 * comparison used) and applying only the safe changes preserves every field
 * the target edited locally. A row without a baseline entry has no field-level
 * ancestor, so it is a whole-row first push.
 *
 * @param {object} options
 * @param {object} options.row - gated `planSync()` row.
 * @param {string} options.profile - target profile.
 * @param {any} options.sourceConfig - current source config.
 * @param {Map<string, Map<string, object>>} options.targetRows
 * @param {Record<string, Record<string, any>>} options.baseline
 * @returns {any}
 */
function desiredTargetConfig({ row, profile, sourceConfig, targetRows, baseline }) {
  // First syncs are per profile, not per row: a row may have a baseline for one
  // target and none for another, and only the latter moves as a whole.
  const base = baselineConfig(baseline, row.id, profile)
  if (base === undefined) return sourceConfig
  const state = targetRowState(targetRows, profile, row.id)
  if (!state.present || !isPlainObject(state.config)) return sourceConfig
  // Deep copy: applying a nested change must not mutate the profile state the
  // read-only preparation step was handed.
  let desired = deepClone(state.config)
  for (const change of Array.isArray(row.changes) ? row.changes : []) {
    if (change?.profile !== profile || !Array.isArray(change.path)) continue
    if (change.path.length === 0) return change.to
    desired = setAtPath(desired, change.path, change.to)
  }
  return desired
}

/**
 * Replace the merge's source-whole-row items with per-profile field merges.
 *
 * `buildSyncTargets` cannot express "same id, different config per profile"
 * inside one item, so a three-way push is split: profiles that end up with the
 * same config share one item, and differing configs become separate items with
 * single-profile scopes (the renderer emits exactly one entry per profile).
 *
 * @param {object} options
 * @param {{items: object[], manifest: object}} options.merged - merge result (mutated).
 * @param {object} options.plan - gated plan.
 * @param {Map<string, object>} options.sourceRows
 * @param {Map<string, Map<string, object>>} options.targetRows
 * @param {any} options.baseline
 * @returns {{items: object[], manifest: object}}
 */
function applyFieldMerge({ merged, plan, sourceRows, targetRows, baseline }) {
  if (!isPlainObject(merged) || !Array.isArray(merged.items)) return merged
  const baselineMap = baselineRows(baseline)
  const rowsById = new Map(
    (Array.isArray(plan?.rows) ? plan.rows : [])
      .filter((row) => isPlainObject(row) && isNonEmptyString(row.id))
      .map((row) => [row.id, row]),
  )

  const next = []
  for (const item of merged.items) {
    if (!isPlainObject(item) || item.origin !== 'sync') {
      next.push(item)
      continue
    }
    const row = rowsById.get(item.id)
    if (row === undefined || row.action !== 'push') {
      next.push(item)
      continue
    }
    const sourceConfig = sourceRowFor(sourceRows, item.id)?.config
    /** stableJson(config) → grouped item, so equal results share one scope. */
    const groups = new Map()
    for (const profile of Array.isArray(item.scope) ? item.scope : []) {
      if (!isNonEmptyString(profile)) continue
      const desired = desiredTargetConfig({ row, profile, sourceConfig, targetRows, baseline: baselineMap })
      // The merge's own contract is "an item config is an object"; keep that
      // even when a malformed source row carried something else.
      const config = isPlainObject(desired) ? desired : {}
      const key = stableJson(config)
      const group = groups.get(key)
      if (group !== undefined) {
        group.scope.push(profile)
        continue
      }
      groups.set(key, { id: item.id, scope: [profile], config, origin: 'sync' })
    }
    next.push(...groups.values())
  }
  // The manifest returned by the merge shares this array; splice keeps that.
  merged.items.splice(0, merged.items.length, ...next)
  return merged
}

/** The row/profile pairs one successful push wrote; used for the new baseline. */
function baselineEntriesFrom(plan, sourceRows) {
  const entries = []
  for (const row of Array.isArray(plan?.rows) ? plan.rows : []) {
    if (!isPlainObject(row) || row.action !== 'push') continue
    const sourceRow = sourceRowFor(sourceRows, row.id)
    if (!isPlainObject(sourceRow?.config)) continue
    const profiles = []
    for (const change of Array.isArray(row.changes) ? row.changes : []) {
      if (isNonEmptyString(change?.profile) && !profiles.includes(change.profile)) profiles.push(change.profile)
    }
    for (const profile of profiles) {
      entries.push({ id: row.id, profile, config: sourceRow.config })
    }
  }
  return entries
}

/**
 * Read the current profile as the source, plan the push, and build the manifest
 * the renderer should apply. Read-only.
 *
 * Steps, each one a hard stop reported through `errors`:
 *  1. resolve the manifest's `sync` policy; a disabled policy never reads a row;
 *  2. require `env.currentProfile` (there is no source otherwise);
 *  3. read the source rows (runtime `configEditor` first, CLI dump fallback);
 *  4. decide which row ids may be synced at all (explicit `allowedRowIds`, else
 *     the union of the profiles' patch rows) and exclude rows whose patch text
 *     still carries `!!js`, whichever backend produced them (the CLI evaluates
 *     the expression before printing);
 *  5. read every target profile's *effective* rows through `dumpTarget`, falling
 *     back to its managed block (and warning) when the dump is unavailable;
 *  6. diff the source rows against the targets (three-way when a `baseline` was
 *     supplied, otherwise the P1 two-way diff);
 *  7. gate named (plugin) rows on the target's installed package set, warning
 *     on version drift and skipping targets with `plugin-missing`;
 *  8. fold the plan into a renderer-ready manifest, keeping target-local rows;
 *     in three-way mode each target receives only the safe fields plus its own
 *     local edits;
 *  9. report `resolved.errors` as errors, never as silent warnings.
 *
 * `warnings` carries the target-dump fallbacks, version mismatches plus the
 * folding warnings (a push row with no scope, …). `ok` is true only when the
 * plan itself is error-free.
 *
 * @param {object} [options]
 * @param {object} [options.ctx] - Cordis context passed to `readSourceRows`.
 * @param {{ currentProfile?: string, dshCommand?: string }} [options.env] - Host environment snapshot.
 * @param {object} [options.manifest] - manifest object, typically from `parseManifest`.
 * @param {string[]} [options.knownProfiles] - profile universe.
 * @param {Map<string, { patchText?: string }>} [options.states] - `readProfileState()` results.
 * @param {string} [options.selfId] - id of the row owned by this Host (never synced).
 * @param {string} [options.dshBin] - explicit dsh CLI path for the fallback reader.
 * @param {Function} [options.dump] - `dumpProfileConfig` replacement, mainly for tests.
 * @param {Function} [options.dumpTarget] - `dumpProfileConfig` replacement used to
 *        read a *target* profile's effective config; defaults to `dump`.
 * @param {Set<string> | string[]} [options.allowedRowIds] - ids that may be
 *        synced; defaults to the union of every known profile's patch rows.
 * @param {Record<string, Record<string, any>>} [options.baseline] - last pushed
 *        source config per row/target (the `rows` of `fleet.sync.json`).
 *        Supplying it (even empty) selects the three-way P2 planner; omitting it
 *        keeps the P1 two-way behaviour.
 * @returns {Promise<{
 *   ok: boolean,
 *   sourceProfile: string | null,
 *   backend: 'runtime' | 'cli' | null,
 *   resolved: object | null,
 *   plan: object | null,
 *   merged: object | null,
 *   baselineEntries: { id: string, profile: string, config: object }[],
 *   errors: string[],
 *   warnings: string[],
 * }>} the prepared push; `plan`/`merged` are null when a hard stop happened.
 */
export async function prepareSync({
  ctx,
  env,
  manifest,
  knownProfiles,
  states,
  selfId = 'dsh-fleet',
  dshBin,
  dump = dumpProfileConfig,
  dumpTarget,
  allowedRowIds,
  baseline,
} = {}) {
  // 1) Policy first: a manifest without sync must not touch the source profile.
  const resolved = resolveSync(manifest, knownProfiles)
  if (!resolved.enabled) {
    return {
      ok: false,
      sourceProfile: null,
      backend: null,
      resolved: null,
      plan: null,
      merged: null,
      baselineEntries: [],
      errors: [SYNC_DISABLED],
      warnings: [],
    }
  }

  // 2) A source profile is the whole point of a push.
  const sourceProfile = isNonEmptyString(env?.currentProfile) ? env.currentProfile.trim() : ''
  if (sourceProfile === '') {
    return {
      ok: false,
      sourceProfile: null,
      backend: null,
      resolved,
      plan: null,
      merged: null,
      baselineEntries: [],
      errors: [NO_SOURCE_PROFILE],
      warnings: [],
    }
  }

  // 3) Read the source rows. A failed read would plan a push of nothing, so it
  // stops here instead of producing a misleading empty preview.
  const source = await readSourceRows({ ctx, env, dshBin, dump })
  if (!source.ok) {
    return {
      ok: false,
      sourceProfile,
      backend: source.backend ?? null,
      resolved,
      plan: null,
      merged: null,
      baselineEntries: [],
      errors: [isNonEmptyString(source.error) ? source.error : 'the source profile rows could not be read'],
      warnings: [],
    }
  }

  // 4) Which ids are user state worth syncing, and which rows must be excluded
  // outright.
  //
  // `allowed` is the id set the caller trusts, or by default the union of the
  // ids the known profiles' patch files declare. Anything else a profile
  // mounts is inherited or contributed by a plugin, so copying it elsewhere
  // would spread another profile's state. An empty union means "no patch text
  // was available" rather than "nothing may be synced", so the rule stays off
  // in that case.
  const allowed = allowedRowIdSet(allowedRowIds) ?? profileRowIdsFromStates(states, knownProfiles)

  // The runtime backend exposes expressions as `{ __jsExpr }`; the CLI backend
  // has already evaluated them, so the patch text is the only remaining
  // evidence for that path.
  const jsRowIds = jsRowIdsFromPatch(stateFor(states, sourceProfile)?.patchText)

  // Priority: self/expression detection first (evaluating an expression is the
  // dangerous case), then the patch-level `!!js` scan that covers the CLI
  // backend, then membership, then a row that carries nothing to compare.
  const autoSkip = (row) =>
    autoSkipReason(row, { selfId }) ??
    (jsRowIds.has(row?.id) ? 'js-expression' : undefined) ??
    (allowed.size > 0 && !allowed.has(row?.id) ? 'not-a-profile-row' : undefined) ??
    (isPlainObject(row?.config) && Object.keys(row.config).length === 0 ? 'empty-config' : undefined)

  // 5) Target profiles' *effective* rows. `dsh --dump-config` reports what the
  // profile actually mounts, which is what a diff must compare against; its
  // managed block only records what the last render wrote. A failed dump falls
  // back to that block and says so, because the preview then cannot see rows
  // the block does not carry. The source profile is skipped: step 3 already
  // read it through the source backend.
  const targetRows = new Map()
  const warnings = []
  const runDumpTarget = typeof dumpTarget === 'function' ? dumpTarget : dump
  const targetBin = isNonEmptyString(dshBin)
    ? dshBin.trim()
    : isNonEmptyString(env?.dshCommand)
      ? env.dshCommand.trim()
      : undefined
  const managedRowsFor = (profile) => targetRowsFromStates(states, [profile]).get(profile) ?? new Map()
  const targets = Array.isArray(knownProfiles) ? knownProfiles.filter(isNonEmptyString) : []
  for (const profile of targets) {
    if (profile === sourceProfile) continue
    try {
      const dumped = await runDumpTarget({ dshBin: targetBin, profile })
      if (dumped?.ok === true) {
        // rowsFromDump hands back { id, config } rows; the diff wants the config
        // itself, keyed by row id.
        targetRows.set(
          profile,
          new Map([...rowsFromDump(dumped.text)].map(([id, row]) => [id, row.config])),
        )
        continue
      }
      const reason = isNonEmptyString(dumped?.error)
        ? dumped.error
        : 'dsh --dump-config failed without a diagnostic'
      targetRows.set(profile, managedRowsFor(profile))
      warnings.push(`effective config for ${profile} is unavailable (${reason}); diffs use its managed block`)
    } catch (error) {
      targetRows.set(profile, managedRowsFor(profile))
      warnings.push(
        `effective config for ${profile} is unavailable (${errorText(error)}); diffs use its managed block`,
      )
    }
  }

  // 6) Diff source against targets.
  const plan = planSync({
    sourceProfile,
    sync: resolved,
    sourceRows: source.rows,
    knownProfiles,
    targetRows,
    baseline,
    autoSkip,
  })

  // 7) Availability gate: a named (plugin) row cannot be pushed to a profile
  // that does not have the package installed. Version drift is reported but
  // never blocks the push. Nameless rows (DSH built-ins) carry no package
  // identity and are left alone.
  gatePlanAvailability({
    plan,
    sourceRows: source.rows,
    states,
    sourceProfile,
    warnings,
    installAnchor: env?.installAnchor,
  })

  // 8) Fold pushes into a renderer-ready manifest, keeping target-local rows.
  // In three-way mode the scope is narrowed to the profiles with a safe write
  // and every item's config becomes the target's own config plus those fields,
  // so a locally edited key the source did not touch survives the push.
  const merged = buildSyncTargets({
    manifest,
    plan: baseline === undefined ? plan : planForWrite(plan),
    sourceRows: source.rows,
    states,
    knownProfiles,
  })
  if (baseline !== undefined) {
    applyFieldMerge({ merged, plan, sourceRows: source.rows, targetRows, baseline })
  }

  // 9) A malformed `sync` section is a configuration error: `planSync` already
  // copies `resolved.errors` into the plan, but report them once even when a
  // future planner stops doing that. `ok` stays false in either case.
  const errors = [...new Set([...resolved.errors, ...plan.errors])]
  return {
    ok: plan.ok && plan.errors.length === 0,
    sourceProfile,
    backend: source.backend,
    resolved,
    plan,
    merged,
    baselineEntries: baselineEntriesFrom(plan, source.rows),
    errors,
    warnings: [...warnings, ...(Array.isArray(merged.warnings) ? merged.warnings : [])],
  }
}
