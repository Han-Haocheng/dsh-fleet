/**
 * Source-side rows for "sync this profile's rows into another profile".
 *
 * The source is the profile this Host is currently running. Its addressable
 * patch rows are read through the live `configEditor` service when one is
 * mounted (the config actually in force), or through
 * `dsh --profile <p> --dump-config` when the Host has no editor (a CLI-only
 * context). Both backends produce the same row shape, `{ id, name?, config }`,
 * so callers cannot tell them apart.
 *
 * Everything here is read-only and never throws: a broken service, a failing
 * CLI and malformed YAML all come back in the result object or as an empty map.
 * Rows that still carry a `!!js` expression are detected rather than evaluated;
 * syncing one would copy source-profile state into another profile.
 */
import { dumpProfileConfig } from './verify.js'
import {
  isNonEmptyString,
  isPlainObject,
  parseYamlTolerant,
  shortText,
  stripUndefinedJson,
} from './util.js'

/**
 * Deep-check whether a value still carries an unevaluated `!!js` expression.
 *
 * The dsh loader parses `!!js <code>` into a single-key `{ __jsExpr: '<code>' }`
 * object. Such a value only means something in the profile that declared it
 * (its code may read that profile's environment), so a row carrying one must
 * not be copied to another profile. Objects and arrays are walked recursively;
 * cycles are visited once.
 *
 * @param {unknown} value - row config, or any value to inspect.
 * @returns {boolean} true when an expression node is reachable from `value`.
 */
export function containsJsExpression(value) {
  const seen = new Set()
  const visit = (node) => {
    if (typeof node !== 'object' || node === null) return false
    if (seen.has(node)) return false
    seen.add(node)
    if (isPlainObject(node) && Object.hasOwn(node, '__jsExpr')) return true
    const children = Array.isArray(node) ? node : Object.values(node)
    return children.some(visit)
  }
  try {
    return visit(value)
  } catch {
    // A throwing getter/proxy must not crash a read-only inspection.
    return false
  }
}

/**
 * Unwrap schemastery volatile wrappers and clone the result into plain JSON.
 *
 * A volatile field resolves to a frozen reference whose `get()` returns the
 * validated value; `{ ...config }` would copy that reference (and its `get`
 * function) instead of the data. Wrappers are unwrapped at any depth, then
 * `stripUndefinedJson` drops functions/`undefined`, converts a `Date` to its
 * ISO string and detaches the result from live config objects.
 *
 * @param {any} value - config value, possibly containing `{ get() }` wrappers.
 * @returns {any} plain JSON data; `undefined` when nothing clonable is there.
 */
export function plainValue(value) {
  try {
    return stripUndefinedJson(unwrapVolatile(value, new Set()))
  } catch {
    // Keep the "never throws" contract even for values with throwing getters.
    return undefined
  }
}

/**
 * Replace every `{ get() }` reference by the value it contains.
 *
 * `seen` makes cyclic config safe and prevents a wrapper whose `get()` returns
 * itself (or its parent) from recursing forever.
 *
 * @param {any} value
 * @param {Set<object>} seen - wrappers/objects on the current path.
 * @returns {any}
 */
function unwrapVolatile(value, seen) {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return undefined
  // `Object.hasOwn` keeps class instances (Map, Headers, …) whose prototype
  // also has `get()` from being mistaken for a volatile reference.
  if (Object.hasOwn(value, 'get') && typeof value.get === 'function') {
    seen.add(value)
    let inner
    try {
      inner = value.get()
    } catch {
      seen.delete(value)
      return undefined
    }
    const plain = unwrapVolatile(inner, seen)
    seen.delete(value)
    return plain
  }
  seen.add(value)
  let plain
  if (Array.isArray(value)) {
    plain = value.map((entry) => unwrapVolatile(entry, seen))
  } else if (value instanceof Date) {
    plain = value
  } else {
    plain = {}
    for (const [key, entry] of Object.entries(value)) plain[key] = unwrapVolatile(entry, seen)
  }
  seen.delete(value)
  return plain
}

/** Trim an id/name, or null when it is not a non-empty string. */
function usableText(value) {
  return isNonEmptyString(value) ? value.trim() : null
}

/**
 * Build the row map of a live `configEditor.configuration()` result.
 *
 * Each item is `{ entry, inherited, override }`. `entry.fiber.config` is the
 * config actually in force and therefore wins; before the plugin activates it
 * is absent, and the profile's own layers are merged shallowly instead (the
 * override layer patched on top of what the profile inherits). Entries without
 * a usable id are skipped: they are not addressable from a profile patch file,
 * so they could never be written to another profile.
 *
 * @param {{ entry?: object, inherited?: object, override?: object }[] | null | undefined} configuration
 * @returns {Map<string, { id: string, name?: string, config: object }>}
 */
export function rowsFromConfiguration(configuration) {
  const rows = new Map()
  if (!Array.isArray(configuration)) return rows
  for (const item of configuration) {
    const id = usableText(item?.entry?.options?.id)
    if (id === null) continue
    const runtime = plainValue(item?.entry?.fiber?.config)
    let config = isPlainObject(runtime)
      ? runtime
      : plainValue({ ...item?.inherited, ...item?.override })
    if (!isPlainObject(config)) config = {}
    const row = { id, config }
    const name = usableText(item?.entry?.options?.name)
    if (name !== null) row.name = name
    rows.set(id, row)
  }
  return rows
}

/**
 * Parse rows out of `dsh --profile <p> --dump-config` stdout.
 *
 * The dump is a YAML list (with `# ==` source comments); parseYamlTolerant
 * already ignores those and returns null for invalid YAML. Only `id`, `name`
 * and `config` are carried: the dump also records where each row came from,
 * which says nothing about the row itself. Invalid YAML, empty text and a
 * non-list document all yield an empty map.
 *
 * Limitation: parseYamlTolerant uses the generic `yaml` package, which has no
 * `!!js` tag, so an expression in a CLI dump becomes its scalar text instead
 * of `{ __jsExpr: … }`. `containsJsExpression` can therefore only recognize
 * expressions read through the runtime backend; callers that must not sync
 * expressions should prefer `readSourceRows` (runtime first) or reject dump
 * rows by their own policy.
 *
 * @param {string | null | undefined} text - dsh's stdout.
 * @returns {Map<string, { id: string, name?: string, config: object }>}
 */
export function rowsFromDump(text) {
  const rows = new Map()
  const parsed = parseYamlTolerant(text)
  if (!Array.isArray(parsed)) return rows
  for (const entry of parsed) {
    if (!isPlainObject(entry)) continue
    const id = usableText(entry.id)
    if (id === null) continue
    const config = plainValue(entry.config)
    const row = { id, config: isPlainObject(config) ? config : {} }
    const name = usableText(entry.name)
    if (name !== null) row.name = name
    rows.set(id, row)
  }
  return rows
}

/**
 * Read the current profile's rows: live runtime first, CLI fallback.
 *
 * The runtime backend is preferred because `entry.fiber.config` is the config
 * actually in force, including values contributed by other plugins. When this
 * Host exposes no `configEditor` service (or it currently has no rows), the
 * offline CLI is asked instead. `dump` is injectable so tests never spawn dsh.
 *
 * @param {object} [options]
 * @param {object} [options.ctx] - Cordis context; only `ctx.get('configEditor')` is used.
 * @param {{ currentProfile?: string, dshCommand?: string }} [options.env] - Host environment snapshot.
 * @param {string} [options.dshBin] - explicit dsh CLI path; wins over `env.dshCommand`.
 * @param {(options: { dshBin: string, profile: string }) => Promise<{ ok: boolean, text: string, error: string | null }>} [options.dump]
 *        `dumpProfileConfig` replacement, mainly for tests.
 * @returns {Promise<{
 *   ok: boolean,
 *   backend: 'runtime' | 'cli' | null,
 *   rows: Map<string, { id: string, name?: string, config: object }>,
 *   error: string | null,
 * }>} `backend` names the backend that produced the rows, or the one that was
 *     tried and failed; it is null when neither backend could even be attempted.
 */
export async function readSourceRows({ ctx, env, dshBin, dump = dumpProfileConfig } = {}) {
  let runtimeTried = false
  let runtimeError = null

  // 1) Live configEditor: authoritative and already evaluated.
  try {
    const editor = ctx?.get?.('configEditor')
    if (typeof editor?.configuration === 'function') {
      runtimeTried = true
      const configuration = await editor.configuration()
      if (Array.isArray(configuration) && configuration.length > 0) {
        return {
          ok: true,
          backend: 'runtime',
          rows: rowsFromConfiguration(configuration),
          error: null,
        }
      }
    }
  } catch (error) {
    runtimeError = shortText(error?.message ?? error, 300)
  }

  // 2) Offline CLI: needs a profile name and a dsh binary.
  const profile = usableText(env?.currentProfile)
  const command = usableText(dshBin) ?? usableText(env?.dshCommand)
  if (profile !== null && command !== null) {
    const runDump = typeof dump === 'function' ? dump : dumpProfileConfig
    try {
      const result = await runDump({ dshBin: command, profile })
      if (result?.ok === true) {
        return { ok: true, backend: 'cli', rows: rowsFromDump(result.text), error: null }
      }
      return {
        ok: false,
        backend: 'cli',
        rows: new Map(),
        error: usableText(result?.error) ?? 'dsh --dump-config failed without a diagnostic',
      }
    } catch (error) {
      return {
        ok: false,
        backend: 'cli',
        rows: new Map(),
        error: `dsh --dump-config failed for profile ${JSON.stringify(profile)}: ${shortText(error?.message ?? error, 400)}`,
      }
    }
  }

  // 3) Nothing to read from: explain which half of the fallback is missing.
  const missing = []
  if (profile === null) missing.push('env.currentProfile')
  if (command === null) missing.push('a dsh CLI path (dshBin or env.dshCommand)')
  const reason =
    runtimeError !== null
      ? `the configEditor service failed (${runtimeError})`
      : runtimeTried
        ? 'the configEditor service returned no configuration rows'
        : 'the configEditor service is unavailable'
  return {
    ok: false,
    backend: null,
    rows: new Map(),
    error: `${reason}; the CLI fallback requires ${missing.join(' and ')}`,
  }
}

/**
 * Why a row must never be synced, if it must not.
 *
 * Checked in this order: a row addressed to the profile that already has it
 * (`self`) is reported as such even when it also carries an expression; an
 * expression row is reported before the id check because evaluating it is the
 * more dangerous failure mode. `undefined` means the row can be synced.
 *
 * @param {{ id?: string, name?: string, config?: object } | null | undefined} row
 * @param {{ selfId?: string }} [options] - id of the source profile's own row.
 * @returns {'self' | 'js-expression' | 'no-id' | undefined}
 */
export function autoSkipReason(row, { selfId } = {}) {
  const id = usableText(row?.id)
  const self = usableText(selfId)
  if (id !== null && self !== null && id === self) return 'self'
  if (containsJsExpression(row?.config)) return 'js-expression'
  if (id === null) return 'no-id'
  return undefined
}
