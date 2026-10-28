/**
 * The sync baseline: what each target profile last accepted from the source.
 *
 * A three-way sync needs a common ancestor. The manifest and the profiles
 * record the *current* values, but not what the last successful push wrote, so
 * without a baseline a planner cannot tell "the target was edited locally"
 * from "the source changed since the last push". This module persists that
 * ancestor in its own file:
 *
 *   $DSH_HOME/fleet.sync.json
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-01-02T03:04:05.000Z",
 *     "rows": { "<row id>": { "<target profile>": { …config… } } }
 *   }
 *
 * The baseline is deliberately separate from `fleet.state.json`: the state file
 * is informational (last apply time, change count) and is deleted by `restore`,
 * while the baseline is comparison data that a failed write must never touch.
 *
 * Everything here is total: a missing, unreadable or malformed file yields an
 * empty baseline plus an error string, and a write failure is returned rather
 * than thrown. Writes are atomic (temp sibling + rename) so a crash can never
 * leave a half-written baseline that would make every field look changed.
 */
import { join } from 'node:path'

import { atomicWriteFileSync, isNonEmptyString, isPlainObject, readTextFile } from './util.js'

/** Current on-disk schema version. */
export const BASELINE_VERSION = 1

/** File name under the Harness home. */
export const BASELINE_FILENAME = 'fleet.sync.json'

/**
 * The absolute baseline path for one Harness home.
 *
 * @param {string} home
 * @returns {string}
 */
export function baselinePath(home) {
  return join(home, BASELINE_FILENAME)
}

/** A baseline with no rows; the value `readBaseline()` reports for a missing file. */
export function emptyBaseline() {
  return { version: BASELINE_VERSION, updatedAt: null, rows: {} }
}

/** Best-effort message for a thrown value. */
function errorText(error) {
  return isNonEmptyString(error?.message) ? error.message : String(error)
}

/**
 * The baseline timestamp, tolerating a broken or missing clock.
 *
 * @param {(() => string) | undefined} now
 * @returns {string}
 */
function timestamp(now) {
  if (typeof now === 'function') {
    try {
      const value = now()
      if (isNonEmptyString(value)) return value
    } catch {
      // A baseline without a timestamp is better than no baseline at all.
    }
  }
  return new Date().toISOString()
}

/**
 * Keep only the shape the planner understands: `{ [rowId]: { [profile]: value } }`.
 *
 * Unknown row/profile entries are dropped instead of making the whole file
 * unusable. A malformed row value cannot be compared three ways, so it is
 * ignored (its row simply looks "never pushed" to the planner).
 *
 * @param {any} value
 * @returns {Record<string, Record<string, any>>}
 */
function normalizeRows(value) {
  if (!isPlainObject(value)) return {}
  const rows = {}
  for (const [id, profiles] of Object.entries(value)) {
    if (!isNonEmptyString(id) || !isPlainObject(profiles)) continue
    const entry = {}
    for (const [profile, config] of Object.entries(profiles)) {
      if (!isNonEmptyString(profile)) continue
      entry[profile] = config
    }
    rows[id] = entry
  }
  return rows
}

/**
 * Read the baseline for one Harness home.
 *
 * A missing file is the normal first-sync case: `{ ok: true, baseline: empty,
 * error: null }`. An unreadable or malformed file reports `ok: false` with an
 * error message but still returns a usable empty baseline, so callers can plan
 * (first-sync semantics) instead of failing the whole command.
 *
 * @param {object} options
 * @param {string | undefined} options.home - Harness home.
 * @returns {{ ok: boolean, baseline: { version: number, updatedAt: string | null, rows: object }, error: string | null }}
 */
export function readBaseline({ home } = {}) {
  if (!isNonEmptyString(home)) {
    return { ok: false, baseline: emptyBaseline(), error: 'the Harness home is unknown' }
  }
  const path = baselinePath(home)
  let text
  try {
    // `readTextFile` returns null for ENOENT/ENOTDIR and throws for the rest.
    text = readTextFile(path)
  } catch (error) {
    return { ok: false, baseline: emptyBaseline(), error: `cannot read ${path}: ${errorText(error)}` }
  }
  if (text === null || text.trim() === '') return { ok: true, baseline: emptyBaseline(), error: null }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, baseline: emptyBaseline(), error: `cannot parse ${path}: ${errorText(error)}` }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, baseline: emptyBaseline(), error: `${path}: the baseline must hold a JSON object` }
  }
  return {
    ok: true,
    baseline: {
      version: Number.isInteger(parsed.version) ? parsed.version : BASELINE_VERSION,
      updatedAt: isNonEmptyString(parsed.updatedAt) ? parsed.updatedAt : null,
      rows: normalizeRows(parsed.rows),
    },
    error: null,
  }
}

/**
 * Merge `entries` into the baseline and write it atomically.
 *
 * `entries` is the list of profile/config pairs one apply actually pushed; each
 * pair replaces that row/profile's previous base and leaves every other entry
 * untouched, so an apply limited to one profile cannot erase the rest of the
 * comparison state.
 *
 * @param {object} options
 * @param {string | undefined} options.home - Harness home.
 * @param {{ id?: string, profile?: string, config?: any }[]} [options.entries]
 * @param {() => string} [options.now] - clock override, mainly for tests.
 * @returns {{ ok: boolean, error: string | null }}
 */
export function recordBaseline({ home, entries, now } = {}) {
  if (!isNonEmptyString(home)) return { ok: false, error: 'the Harness home is unknown' }
  const current = readBaseline({ home })
  // A corrupt baseline must not be silently replaced: the previous comparison
  // state is the only thing separating "target edited" from "source edited".
  if (!current.ok) return { ok: false, error: current.error }

  const rows = { ...current.baseline.rows }
  let changed = false
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isPlainObject(entry)) continue
    if (!isNonEmptyString(entry.id) || !isNonEmptyString(entry.profile)) continue
    if (entry.config === undefined) continue
    const row = isPlainObject(rows[entry.id]) ? { ...rows[entry.id] } : {}
    row[entry.profile] = entry.config
    rows[entry.id] = row
    changed = true
  }
  if (!changed) return { ok: true, error: null }

  const baseline = { version: BASELINE_VERSION, updatedAt: timestamp(now), rows }
  try {
    atomicWriteFileSync(baselinePath(home), `${JSON.stringify(baseline, undefined, 2)}\n`)
  } catch (error) {
    return { ok: false, error: `cannot write ${baselinePath(home)}: ${errorText(error)}` }
  }
  return { ok: true, error: null }
}

/**
 * Forget baseline rows, either the named ids or (without `ids`) all of them.
 *
 * `restore` calls this without ids: the files rolled back to a snapshot taken
 * before the last push, so no baseline entry describes the profiles any more.
 * A missing baseline file is a successful no-op.
 *
 * @param {object} options
 * @param {string | undefined} options.home - Harness home.
 * @param {Set<string> | string[]} [options.ids] - row ids to drop; all when omitted.
 * @param {() => string} [options.now] - clock override, mainly for tests.
 * @returns {{ ok: boolean, error: string | null }}
 */
export function clearBaseline({ home, ids, now } = {}) {
  if (!isNonEmptyString(home)) return { ok: false, error: 'the Harness home is unknown' }
  const current = readBaseline({ home })
  if (!current.ok) return { ok: false, error: current.error }

  const rows = { ...current.baseline.rows }
  if (ids === undefined) {
    for (const id of Object.keys(rows)) delete rows[id]
  } else {
    const list = ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : []
    for (const id of list) {
      if (isNonEmptyString(id)) delete rows[id]
    }
  }

  const baseline = { version: BASELINE_VERSION, updatedAt: timestamp(now), rows }
  try {
    atomicWriteFileSync(baselinePath(home), `${JSON.stringify(baseline, undefined, 2)}\n`)
  } catch (error) {
    return { ok: false, error: `cannot write ${baselinePath(home)}: ${errorText(error)}` }
  }
  return { ok: true, error: null }
}
