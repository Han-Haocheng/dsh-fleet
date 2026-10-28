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
import { extractManagedBlock } from './render.js'
import { autoSkipReason, readSourceRows, rowsFromDump } from './source.js'
import { buildSyncTargets } from './sync-merge.js'
import { planSync } from './sync.js'
import { isNonEmptyString, isPlainObject, parseYamlTolerant } from './util.js'
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
 *  6. diff the source rows against the targets;
 *  7. fold the plan into a renderer-ready manifest, keeping target-local rows;
 *  8. report `resolved.errors` as errors, never as silent warnings.
 *
 * `warnings` carries the target-dump fallbacks plus the folding warnings (a
 * push row with no scope, …). `ok` is true only when the plan itself is
 * error-free.
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
 * @returns {Promise<{
 *   ok: boolean,
 *   sourceProfile: string | null,
 *   backend: 'runtime' | 'cli' | null,
 *   resolved: object | null,
 *   plan: object | null,
 *   merged: object | null,
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
    autoSkip,
  })

  // 7) Fold pushes into a renderer-ready manifest, keeping target-local rows.
  const merged = buildSyncTargets({
    manifest,
    plan,
    sourceRows: source.rows,
    states,
    knownProfiles,
  })

  // 8) A malformed `sync` section is a configuration error: `planSync` already
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
    errors,
    warnings: [...warnings, ...(Array.isArray(merged.warnings) ? merged.warnings : [])],
  }
}
