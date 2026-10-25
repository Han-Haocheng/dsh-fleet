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
  provider: ['key', 'scope', 'description', 'config', 'disabled', 'enforce', 'overrides'],
  bundle: ['name', 'spec', 'scope', 'description', 'provides', 'prune', 'disabled', 'enforce', 'overrides'],
  item: ['id', 'name', 'scope', 'description', 'config', 'requires', 'disabled', 'enforce', 'overrides'],
}

const TOP_LEVEL_FIELDS = ['version', 'profiles', 'providers', 'bundles', 'items']

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

/** Optional human description shown by the settings page on hover. */
function checkDescription(entry, label, errors) {
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
 * Validate a normalized manifest.
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

  const itemIds = new Set()
  items.forEach((item, index) => {
    const label = `items[${index}]`
    if (!isPlainObject(item)) {
      errors.push(`${label}: must be a mapping`)
      return
    }
    if (!isNonEmptyString(item.id)) {
      errors.push(`${label}.id: must be a non-empty string`)
    } else if (itemIds.has(item.id)) {
      errors.push(`${label}.id: duplicate item id ${JSON.stringify(item.id)}`)
    } else {
      itemIds.add(item.id)
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

  if (providers.length > 0 && !items.some((item) => isPlainObject(item) && item.id === 'llm-pi-ai')) {
    errors.push('items: a manifest with providers must declare the "llm-pi-ai" item (provider aggregation needs its config)')
  }

  const defaultModel = items.find((item) => isPlainObject(item) && item.id === 'agent-default-model')
  const selectedProvider = isPlainObject(defaultModel?.config) ? defaultModel.config.provider : undefined
  if (isNonEmptyString(selectedProvider) && !providerKeys.has(selectedProvider)) {
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
