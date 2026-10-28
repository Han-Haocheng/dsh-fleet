/**
 * The fleet manifest (`$DSH_HOME/fleet.yml`): parsing, normalization,
 * validation, scope resolution and stable serialization.
 *
 * A manifest is the single source of truth for three entry kinds:
 *
 *   providers  - model providers merged into the profile's `llm-pi-ai` row
 *   bundles    - profile bundle layers (`package.json` `dsh.profile.bundles`)
 *   items      - patch rows (loader entries) with a config payload
 *
 * Every entry carries `scope` (list of profile names, or `["all"]`) and may
 * carry `overrides`: per-profile patches applied when *that* profile renders.
 * `overrides` are validated here and resolved by the renderer; this module only
 * owns the shape rules.
 */
import { deepClone, isNonEmptyString, isPlainObject, parseYaml, shortText, stringifyYaml, uniqueStrings } from './util.js'

/** The manifest schema version this plugin writes and accepts. */
export const MANIFEST_VERSION = 1

/** Canonical field order (and the allowed field set) per entry kind. */
const ENTRY_FIELDS = {
  provider: ['key', 'scope', 'title', 'description', 'config', 'disabled', 'enforce', 'overrides'],
  bundle: ['name', 'spec', 'scope', 'title', 'description', 'provides', 'prune', 'disabled', 'enforce', 'overrides'],
  item: ['id', 'name', 'scope', 'title', 'description', 'config', 'requires', 'disabled', 'enforce', 'overrides'],
}

const TOP_LEVEL_FIELDS = ['version', 'profiles', 'sync', 'providers', 'bundles', 'items']

/** Deep-copy one manifest value without losing YAML scalar identity. */
function cloneValue(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'object') return deepClone(value)
  return value
}

/** Normalize one entry to its canonical field order and defaults. */
function normalizeEntry(raw, kind, label, warnings) {
  const order = ENTRY_FIELDS[kind]
  const entry = {}
  for (const field of order) {
    if (raw[field] === undefined) continue
    entry[field] = cloneValue(raw[field])
  }
  for (const key of Object.keys(raw)) {
    if (!order.includes(key)) warnings.push(`${label}: unknown field "${key}" ignored`)
  }
  if (entry.scope === undefined) entry.scope = ['all']
  return entry
}

/** Normalize the `overrides` mapping while keeping invalid values for validation. */
function normalizeOverrides(overrides, label, warnings) {
  const result = {}
  for (const [profile, override] of Object.entries(overrides)) {
    const overrideLabel = `${label}.overrides.${profile}`
    if (!isPlainObject(override)) {
      result[profile] = cloneValue(override)
      continue
    }
    const normalized = {}
    if (override.config !== undefined) normalized.config = cloneValue(override.config)
    if (override.disabled !== undefined) normalized.disabled = cloneValue(override.disabled)
    for (const key of Object.keys(override)) {
      if (key !== 'config' && key !== 'disabled') warnings.push(`${overrideLabel}: unknown field "${key}" ignored`)
    }
    result[profile] = normalized
  }
  return result
}

/** Normalize a whole parsed document into the documented JS shape. */
function normalizeManifest(raw, errors, warnings) {
  const manifest = {}
  if (raw.version !== undefined) manifest.version = cloneValue(raw.version)
  if (raw.profiles === undefined) {
    manifest.profiles = []
  } else if (!Array.isArray(raw.profiles)) {
    manifest.profiles = []
    errors.push('profiles: must be a list of profile names')
  } else {
    manifest.profiles = raw.profiles.map(cloneValue)
  }
  if (raw.sync !== undefined) manifest.sync = cloneValue(raw.sync)
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.includes(key)) warnings.push(`unknown top-level field "${key}" ignored`)
  }
  for (const kind of ['provider', 'bundle', 'item']) {
    const listName = kind === 'provider' ? 'providers' : kind === 'bundle' ? 'bundles' : 'items'
    const value = raw[listName]
    const entries = []
    if (value !== undefined) {
      if (!Array.isArray(value)) {
        errors.push(`${listName}: must be a list`)
      } else {
        value.forEach((item, index) => {
          const label = `${listName}[${index}]`
          if (!isPlainObject(item)) {
            errors.push(`${label}: must be a mapping`)
            return
          }
          const entry = normalizeEntry(item, kind, label, warnings)
          if (isPlainObject(entry.overrides)) entry.overrides = normalizeOverrides(entry.overrides, label, warnings)
          entries.push(entry)
        })
      }
    }
    manifest[listName] = entries
  }
  return manifest
}

/**
 * Parse manifest YAML.
 *
 * Returns the normalized manifest even when validation problems exist, so a
 * caller can render a partial matrix; `errors` holds problems that make the
 * document unusable (invalid YAML, non-mapping root, non-list sections).
 * Semantic problems live in {@link validateManifest}; `warnings` lists
 * tolerated input such as unknown fields.
 *
 * @param {string} text - buffer contents of `fleet.yml`.
 * @returns {{ manifest: object | null, errors: string[], warnings: string[] }}
 */
export function parseManifest(text) {
  const errors = []
  const warnings = []
  if (typeof text !== 'string' || text.trim() === '') {
    return { manifest: null, errors: ['manifest is empty'], warnings }
  }
  let raw
  try {
    raw = parseYaml(text)
  } catch (error) {
    return {
      manifest: null,
      errors: [`manifest is not valid YAML: ${shortText(error?.message ?? error, 400)}`],
      warnings,
    }
  }
  if (raw === null || raw === undefined) {
    return { manifest: null, errors: ['manifest is empty'], warnings }
  }
  if (!isPlainObject(raw)) {
    const kind = Array.isArray(raw) ? 'a list' : typeof raw
    return { manifest: null, errors: [`manifest root must be a YAML mapping, got ${kind}`], warnings }
  }
  const manifest = normalizeManifest(raw, errors, warnings)
  return { manifest, errors, warnings }
}

/** Effective config/disabled of an entry for one profile (shallows overrides). */
export function effectiveEntry(entry, profile) {
  const base = isPlainObject(entry) ? entry : {}
  const override = isPlainObject(base.overrides) && isPlainObject(base.overrides[profile])
    ? base.overrides[profile]
    : undefined
  const overrideConfig = isPlainObject(override?.config) ? override.config : undefined
  const baseConfig = isPlainObject(base.config) ? base.config : undefined
  let config
  if (baseConfig === undefined && overrideConfig === undefined) {
    config = undefined
  } else {
    config = { ...(baseConfig ?? {}), ...(overrideConfig ?? {}) }
  }
  return { config, disabled: base.disabled === true || override?.disabled === true }
}

/** Scope names an entry targets, with `["all"]` expanded to `knownProfiles`. */
export function resolveScope(entry, knownProfiles) {
  const known = Array.isArray(knownProfiles) ? knownProfiles.filter(isNonEmptyString) : []
  const scope = isPlainObject(entry) || typeof entry === 'object' ? entry?.scope : undefined
  if (!Array.isArray(scope) || scope.length === 0) return [...known]
  if (scope.includes('all')) return uniqueStrings(known)
  return uniqueStrings(scope.filter(isNonEmptyString))
}

/** Whether an entry applies to `profile`. Absent/empty scope means everywhere. */
export function isInScope(entry, profile, knownProfiles) {
  // `knownProfiles` is accepted for signature symmetry with resolveScope: a
  // concrete profile name is either listed by the scope or it is not.
  void knownProfiles
  if (!isNonEmptyString(profile)) return false
  const scope = entry?.scope
  if (scope === undefined || scope === null) return true
  if (!Array.isArray(scope) || scope.length === 0) return true
  if (scope.includes('all')) return true
  return scope.includes(profile)
}

/** Optional human title/description shown by the settings page. */
function checkDescription(entry, label, errors) {
  if (entry.title !== undefined && typeof entry.title !== 'string') {
    errors.push(`${label}.title: must be a string`)
  }
  if (entry.description !== undefined && typeof entry.description !== 'string') {
    errors.push(`${label}.description: must be a string`)
  }
}

/** Whether a value is a valid boolean where the schema allows one. */
function checkBooleanField(entry, label, field, errors) {
  if (entry[field] !== undefined && typeof entry[field] !== 'boolean') {
    errors.push(`${label}.${field}: must be a boolean`)
  }
}

/** Whether a value is a valid list of strings where the schema allows one. */
function checkStringList(entry, label, field, errors) {
  if (entry[field] === undefined) return
  if (!Array.isArray(entry[field]) || entry[field].some((value) => !isNonEmptyString(value))) {
    errors.push(`${label}.${field}: must be a list of non-empty strings`)
  }
}

/** Validate one `scope` value against the known profile names. */
function checkScope(entry, label, knownProfiles, errors) {
  const scope = entry.scope
  if (scope === undefined) return
  if (!Array.isArray(scope)) {
    errors.push(`${label}.scope: must be a list of profile names`)
    return
  }
  if (scope.length === 0) {
    errors.push(`${label}.scope: must not be empty (use ["all"])`)
    return
  }
  if (scope.includes('all') && scope.length > 1) {
    errors.push(`${label}.scope: "all" must be the only value, got [${scope.map((value) => JSON.stringify(value)).join(', ')}]`)
  }
  for (const value of scope) {
    if (!isNonEmptyString(value)) {
      errors.push(`${label}.scope: entries must be non-empty strings`)
      continue
    }
    if (value !== 'all' && knownProfiles.length > 0 && !knownProfiles.includes(value)) {
      errors.push(`${label}.scope: unknown profile ${JSON.stringify(value)} (known: ${knownProfiles.join(', ')})`)
    }
  }
}

/** Validate one `overrides` mapping. */
function checkOverrides(entry, label, knownProfiles, errors) {
  if (entry.overrides === undefined) return
  if (!isPlainObject(entry.overrides)) {
    errors.push(`${label}.overrides: must be a mapping of profile name to { config?, disabled? }`)
    return
  }
  const scope = resolveScope(entry, knownProfiles)
  for (const [profile, override] of Object.entries(entry.overrides)) {
    const overrideLabel = `${label}.overrides.${profile}`
    if (!scope.includes(profile)) {
      errors.push(`${overrideLabel}: profile ${JSON.stringify(profile)} is outside this entry's scope (${scope.join(', ') || 'none'})`)
    }
    if (!isPlainObject(override)) {
      errors.push(`${overrideLabel}: must be a mapping with optional config/disabled`)
      continue
    }
    if (override.config !== undefined && !isPlainObject(override.config)) {
      errors.push(`${overrideLabel}.config: must be a mapping`)
    }
    if (override.disabled !== undefined && typeof override.disabled !== 'boolean') {
      errors.push(`${overrideLabel}.disabled: must be a boolean`)
    }
  }
}

/**
 * Profiles a scope selects, or `null` when it selects every profile.
 *
 * Absent, empty and `["all"]` scopes all mean "every profile" (matching
 * {@link isInScope}). A malformed scope is treated the same way so duplicate
 * detection stays conservative; {@link checkScope} reports the shape itself.
 */
function scopeProfiles(entry) {
  const scope = isPlainObject(entry) ? entry.scope : undefined
  if (!Array.isArray(scope) || scope.length === 0) return null
  if (scope.includes('all')) return null
  const profiles = scope.filter(isNonEmptyString)
  if (profiles.length !== scope.length) return null
  return profiles
}

/** Whether two entries may render for at least one shared profile. */
function scopesOverlap(left, right) {
  const leftProfiles = scopeProfiles(left)
  const rightProfiles = scopeProfiles(right)
  // A `null` scope selects every profile, so it always overlaps.
  if (leftProfiles === null || rightProfiles === null) return true
  return leftProfiles.some((profile) => rightProfiles.includes(profile))
}

/**
 * Validate a normalized manifest.
 *
 * Two item rules are relaxed when the manifest declares a `sync` section: a
 * synced manifest is a runtime projection rebuilt from discovered source rows,
 * so `items` is not the source of truth. Independently of `sync`, duplicate
 * item ids are accepted when every copy targets a disjoint set of profiles:
 * the renderer picks the copy in scope for each profile.
 *
 * @param {object} manifest - value from {@link parseManifest} (or hand-built).
 * @param {{ knownProfiles?: string[] }} [opts]
 * @returns {string[]} human-readable problems with entry locations.
 */
export function validateManifest(manifest, opts = {}) {
  const errors = []
  if (!isPlainObject(manifest)) return ['manifest must be an object']
  const declaredProfiles = Array.isArray(manifest.profiles) ? manifest.profiles : []
  const knownProfiles = Array.isArray(opts.knownProfiles)
    ? opts.knownProfiles.filter(isNonEmptyString)
    : declaredProfiles.filter(isNonEmptyString)

  if (manifest.version !== MANIFEST_VERSION) {
    errors.push(`version: expected ${MANIFEST_VERSION}, got ${JSON.stringify(manifest.version)}`)
  }

  if (!Array.isArray(manifest.profiles) || manifest.profiles.length === 0) {
    errors.push('profiles: must be a non-empty list of profile names')
  } else {
    const seen = new Set()
    manifest.profiles.forEach((profile, index) => {
      if (!isNonEmptyString(profile)) {
        errors.push(`profiles[${index}]: must be a non-empty string`)
        return
      }
      if (seen.has(profile)) errors.push(`profiles[${index}]: duplicate profile ${JSON.stringify(profile)}`)
      seen.add(profile)
    })
  }

  const providers = Array.isArray(manifest.providers) ? manifest.providers : []
  const bundles = Array.isArray(manifest.bundles) ? manifest.bundles : []
  const items = Array.isArray(manifest.items) ? manifest.items : []
  if (manifest.providers !== undefined && !Array.isArray(manifest.providers)) errors.push('providers: must be a list')
  if (manifest.bundles !== undefined && !Array.isArray(manifest.bundles)) errors.push('bundles: must be a list')
  if (manifest.items !== undefined && !Array.isArray(manifest.items)) errors.push('items: must be a list')

  const providerKeys = new Set()
  providers.forEach((provider, index) => {
    const label = `providers[${index}]`
    if (!isPlainObject(provider)) {
      errors.push(`${label}: must be a mapping`)
      return
    }
    if (!isNonEmptyString(provider.key)) {
      errors.push(`${label}.key: must be a non-empty string`)
    } else if (providerKeys.has(provider.key)) {
      errors.push(`${label}.key: duplicate provider key ${JSON.stringify(provider.key)}`)
    } else {
      providerKeys.add(provider.key)
    }
    checkScope(provider, label, knownProfiles, errors)
    checkDescription(provider, label, errors)
    if (provider.config !== undefined && !isPlainObject(provider.config)) errors.push(`${label}.config: must be a mapping`)
    checkBooleanField(provider, label, 'disabled', errors)
    checkBooleanField(provider, label, 'enforce', errors)
    checkOverrides(provider, label, knownProfiles, errors)
  })

  const bundleNames = new Set()
  const bundleSpecs = new Set()
  bundles.forEach((bundle, index) => {
    const label = `bundles[${index}]`
    if (!isPlainObject(bundle)) {
      errors.push(`${label}: must be a mapping`)
      return
    }
    if (!isNonEmptyString(bundle.name)) {
      errors.push(`${label}.name: must be a non-empty string`)
    } else if (bundleNames.has(bundle.name)) {
      errors.push(`${label}.name: duplicate bundle ${JSON.stringify(bundle.name)}`)
    } else {
      bundleNames.add(bundle.name)
    }
    if (!isNonEmptyString(bundle.spec)) {
      errors.push(`${label}.spec: must be a non-empty package spec`)
    } else if (bundleSpecs.has(bundle.spec)) {
      errors.push(`${label}.spec: duplicate bundle spec ${JSON.stringify(bundle.spec)}`)
    } else {
      bundleSpecs.add(bundle.spec)
    }
    checkScope(bundle, label, knownProfiles, errors)
    checkDescription(bundle, label, errors)
    checkStringList(bundle, label, 'provides', errors)
    if (bundle.prune !== undefined && typeof bundle.prune !== 'boolean') errors.push(`${label}.prune: must be a boolean`)
    checkBooleanField(bundle, label, 'disabled', errors)
    checkBooleanField(bundle, label, 'enforce', errors)
    checkOverrides(bundle, label, knownProfiles, errors)
  })

  const itemIds = new Map()
  items.forEach((item, index) => {
    const label = `items[${index}]`
    if (!isPlainObject(item)) {
      errors.push(`${label}: must be a mapping`)
      return
    }
    if (!isNonEmptyString(item.id)) {
      errors.push(`${label}.id: must be a non-empty string`)
    } else {
      const previous = itemIds.get(item.id)
      if (previous === undefined) {
        itemIds.set(item.id, [item])
      } else {
        // A runtime sync manifest may keep one copy of a row per profile;
        // duplicates are fine only while every copy targets disjoint profiles.
        if (previous.some((other) => scopesOverlap(item, other))) {
          errors.push(`${label}.id: duplicate item id ${JSON.stringify(item.id)} (scopes overlap; duplicate item ids must target disjoint profiles)`)
        }
        previous.push(item)
      }
    }
    if (item.name !== undefined && !isNonEmptyString(item.name)) errors.push(`${label}.name: must be a non-empty string`)
    checkScope(item, label, knownProfiles, errors)
    checkDescription(item, label, errors)
    if (item.config !== undefined && !isPlainObject(item.config)) errors.push(`${label}.config: must be a mapping`)
    checkStringList(item, label, 'requires', errors)
    if (Array.isArray(item.requires)) {
      for (const required of item.requires) {
        if (isNonEmptyString(required) && !bundleNames.has(required)) {
          errors.push(`${label}.requires: ${JSON.stringify(required)} is not a bundle in this manifest`)
        }
      }
    }
    checkBooleanField(item, label, 'disabled', errors)
    checkBooleanField(item, label, 'enforce', errors)
    checkOverrides(item, label, knownProfiles, errors)
  })

  // A synced manifest is generated from source rows, so rules that assume the
  // file names every row it renders (the aggregation row, the default model's
  // provider) no longer hold while `sync` is declared.
  const syncedManifest = manifest.sync !== undefined

  if (!syncedManifest && providers.length > 0 && !items.some((item) => isPlainObject(item) && item.id === 'llm-pi-ai')) {
    errors.push('items: a manifest with providers must declare the "llm-pi-ai" item (provider aggregation needs its config)')
  }

  const defaultModel = items.find((item) => isPlainObject(item) && item.id === 'agent-default-model')
  const selectedProvider = isPlainObject(defaultModel?.config) ? defaultModel.config.provider : undefined
  if (!syncedManifest && isNonEmptyString(selectedProvider) && !providerKeys.has(selectedProvider)) {
    errors.push(`items: agent-default-model.config.provider ${JSON.stringify(selectedProvider)} is not a provider in this manifest`)
  }

  return errors
}

/** Serialize a manifest to stable, human-editable YAML. */
export function serializeManifest(manifest) {
  const source = isPlainObject(manifest) ? manifest : {}
  const output = {}
  if (source.version !== undefined) output.version = cloneValue(source.version)
  output.profiles = Array.isArray(source.profiles) ? source.profiles.map(cloneValue) : []
  if (source.sync !== undefined) output.sync = cloneValue(source.sync)
  for (const kind of ['provider', 'bundle', 'item']) {
    const listName = kind === 'provider' ? 'providers' : kind === 'bundle' ? 'bundles' : 'items'
    const list = Array.isArray(source[listName]) ? source[listName] : []
    const serialized = []
    for (const entry of list) {
      if (!isPlainObject(entry)) continue
      const out = {}
      for (const field of ENTRY_FIELDS[kind]) {
        if (entry[field] === undefined) continue
        out[field] = cloneValue(entry[field])
      }
      serialized.push(out)
    }
    output[listName] = serialized
  }
  return stringifyYaml(output)
}

/**
 * Resolve one `sync.targets` list against the known profile names.
 *
 * `"all"` expands to `known`, unknown names are reported and dropped, and the
 * result is deduplicated. The caller guarantees `value` is a list.
 *
 * @param {unknown[]} value - raw targets list.
 * @param {string[]} known - known profile names.
 * @param {string} label - diagnostic prefix such as `sync.targets`.
 * @param {string[]} errors - collected errors (mutated).
 * @returns {string[]} effective target profile names.
 */
function resolveSyncTargets(value, known, label, errors) {
  const names = []
  for (const entry of value) {
    if (!isNonEmptyString(entry)) {
      errors.push(`${label}: entries must be non-empty strings`)
      continue
    }
    if (entry === 'all') {
      names.push(...known)
      continue
    }
    if (known.length > 0 && !known.includes(entry)) {
      errors.push(`${label}: unknown profile ${JSON.stringify(entry)} (known: ${known.join(', ')})`)
      continue
    }
    names.push(entry)
  }
  return uniqueStrings(names)
}

/**
 * Resolve one `sync.exclude` list into a row-id set.
 *
 * @param {unknown} value - raw exclude list.
 * @param {string[]} errors - collected errors (mutated).
 * @returns {Set<string>} excluded row ids.
 */
function resolveSyncExclude(value, errors) {
  const excluded = new Set()
  if (value === undefined) return excluded
  if (!Array.isArray(value)) {
    errors.push('sync.exclude: must be a list of row ids')
    return excluded
  }
  for (const entry of value) {
    if (!isNonEmptyString(entry)) {
      errors.push('sync.exclude: entries must be non-empty strings')
      continue
    }
    excluded.add(entry)
  }
  return excluded
}

/**
 * Resolve the `sync.overrides` mapping into per-row policies.
 *
 * Invalid rows are reported and skipped; valid rows keep only the fields they
 * declare, so an empty override inherits every default.
 *
 * @param {unknown} value - raw overrides mapping.
 * @param {string[]} known - known profile names.
 * @param {string[]} errors - collected errors (mutated).
 * @returns {Map<string, { targets?: string[], enabled?: boolean }>} per-row policies.
 */
function resolveSyncOverrides(value, known, errors) {
  const overrides = new Map()
  if (value === undefined) return overrides
  if (!isPlainObject(value)) {
    errors.push('sync.overrides: must be a mapping of row id to { targets?, enabled? }')
    return overrides
  }
  for (const [rowId, raw] of Object.entries(value)) {
    const label = `sync.overrides.${rowId}`
    if (!isNonEmptyString(rowId)) {
      errors.push(`${label}: row id must be a non-empty string`)
      continue
    }
    if (!isPlainObject(raw)) {
      errors.push(`${label}: must be a mapping with optional targets/enabled`)
      continue
    }
    const override = {}
    if (raw.targets !== undefined) {
      if (Array.isArray(raw.targets)) {
        override.targets = resolveSyncTargets(raw.targets, known, `${label}.targets`, errors)
      } else {
        errors.push(`${label}.targets: must be a list of profile names`)
      }
    }
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled === 'boolean') {
        override.enabled = raw.enabled
      } else {
        errors.push(`${label}.enabled: must be a boolean`)
      }
    }
    overrides.set(rowId, override)
  }
  return overrides
}

/**
 * Resolve the optional `sync` section of a manifest.
 *
 * The section turns the manifest into a sync policy: every loader row takes
 * part by default and the user excludes rows or narrows targets. A manifest
 * without the section keeps the legacy behavior (`enabled: false` and no
 * targets), while `sync.enabled: false` disables syncing but still resolves
 * the other fields so a settings page can render them.
 *
 * Pure and non-throwing: malformed values are reported in `errors` and the
 * offending entry is dropped (or replaced by the documented default).
 *
 * @param {object} manifest - manifest object, typically from {@link parseManifest}.
 * @param {string[]} knownProfiles - profile names the caller knows about.
 * @returns {{
 *   enabled: boolean,
 *   targets: string[],
 *   exclude: Set<string>,
 *   overrides: Map<string, { targets?: string[], enabled?: boolean }>,
 *   errors: string[],
 * }} resolved sync policy.
 */
export function resolveSync(manifest, knownProfiles) {
  const errors = []
  const known = Array.isArray(knownProfiles)
    ? uniqueStrings(knownProfiles.filter(isNonEmptyString))
    : []
  const sync = isPlainObject(manifest) ? manifest.sync : undefined
  if (sync === undefined) {
    return { enabled: false, targets: [], exclude: new Set(), overrides: new Map(), errors }
  }
  if (!isPlainObject(sync)) {
    errors.push('sync: must be a mapping of { enabled?, targets?, exclude?, overrides? }')
    return { enabled: false, targets: [], exclude: new Set(), overrides: new Map(), errors }
  }
  if (sync.enabled !== undefined && typeof sync.enabled !== 'boolean') {
    errors.push('sync.enabled: must be a boolean')
  }
  let targets
  if (sync.targets === undefined) {
    targets = [...known]
  } else if (Array.isArray(sync.targets)) {
    targets = resolveSyncTargets(sync.targets, known, 'sync.targets', errors)
  } else {
    errors.push('sync.targets: must be a list of profile names')
    targets = []
  }
  return {
    enabled: sync.enabled !== false,
    targets,
    exclude: resolveSyncExclude(sync.exclude, errors),
    overrides: resolveSyncOverrides(sync.overrides, known, errors),
    errors,
  }
}

/**
 * Effective sync targets of one loader row.
 *
 * Returns an empty list when syncing is off, the row is excluded, or its
 * override disables it. Otherwise the row override targets win over the
 * resolved defaults. The result is a copy the caller may mutate.
 *
 * @param {ReturnType<typeof resolveSync>} resolved - value from {@link resolveSync}.
 * @param {string} rowId - loader row id.
 * @returns {string[]} profile names this row syncs to.
 */
export function syncTargetsFor(resolved, rowId) {
  const source = isPlainObject(resolved) ? resolved : {}
  if (!source.enabled) return []
  if (source.exclude instanceof Set && source.exclude.has(rowId)) return []
  const override = source.overrides instanceof Map ? source.overrides.get(rowId) : undefined
  if (override?.enabled === false) return []
  const targets = override?.targets ?? source.targets
  return Array.isArray(targets) ? targets.filter(isNonEmptyString) : []
}
