/**
 * Pure rendering of the per-profile managed block plus bundle-list
 * reconciliation. Nothing here touches the file system: the Host layer reads a
 * profile's state, passes it in, and writes the returned text.
 *
 * Byte stability is a hard requirement: the same manifest rendered twice must
 * produce identical text, and the recorded `sha256` covers only the entry list
 * (never the header line), so a comment tweak cannot look like a config change.
 */
import { effectiveEntry, isInScope } from './manifest.js'
import {
  BLOCK_FOOTER,
  BLOCK_HEADER_PREFIX,
  blockHashFromHeader,
  findBlockRange,
  isNonEmptyString,
  isPlainObject,
  parseYamlTolerant,
  sha256,
  stableJson,
  stringifyYaml,
  uniqueStrings,
} from './util.js'

/** The literal source path shown in the header (the default manifest location). */
const MANIFEST_DISPLAY_PATH = '~/.dsh/fleet.yml'

/** sha256 over the stable (key-sorted) JSON serialization of the entries. */
export function hashEntries(entries) {
  return sha256(stableJson(Array.isArray(entries) ? entries : []))
}

/** Resolve the profile list a render is evaluated against. */
function knownProfileList(manifest, knownProfiles) {
  if (Array.isArray(knownProfiles) && knownProfiles.length > 0) {
    return knownProfiles.filter(isNonEmptyString)
  }
  const declared = manifest?.profiles
  return Array.isArray(declared) ? declared.filter(isNonEmptyString) : []
}

/**
 * Per-model fields fleet may carry over from the profile's own rows when the
 * manifest entry does not declare them. Capability-adjacent metadata only:
 * the manifest stays the selector, but it is no longer required to restate
 * facts the profile already knows.
 */
const INHERITABLE_MODEL_FIELDS = Object.freeze([
  'reasoningEfforts',
  'contextWindow',
  'maxTokens',
  'input',
  'output',
])

/** Patch text with the fleet managed block removed, leaving the profile's own rows. */
function withoutManagedBlock(text) {
  const source = typeof text === 'string' ? text : ''
  const range = findBlockRange(source)
  if (range === null) return source
  const lines = source.split('\n')
  const endLine = range.complete ? range.endLine : lines.length - 1
  return [...lines.slice(0, range.startLine), ...lines.slice(endLine + 1)].join('\n')
}

/**
 * Harvest per-model metadata a profile already carries in its own `llm-pi-ai`
 * rows.
 *
 * Rendering writes the whole row, so a manifest that is thinner than the row it
 * replaces silently drops capability (`reasoningEfforts`, `contextWindow`, …).
 * `renderManagedBlock` therefore fills a missing field from this map; a
 * manifest-declared value always wins, and `reasoningEfforts: false` stays the
 * explicit "this model has no reasoning levels" opt-out.
 *
 * The managed block is stripped before reading: harvesting our own output would
 * freeze earlier renders and hide a value the author removed from the manifest.
 *
 * @param {string} patchText - current `cordis.patch.yml` contents.
 * @returns {Record<string, Record<string, object>> | undefined}
 *          provider key → model id → metadata fields.
 */
export function collectInheritedModelMeta(patchText) {
  const rows = parseYamlTolerant(withoutManagedBlock(patchText))
  if (!Array.isArray(rows)) return undefined
  const result = {}
  for (const row of rows) {
    if (!isPlainObject(row) || row.id !== 'llm-pi-ai') continue
    const providers = isPlainObject(row.config?.providers) ? row.config.providers : undefined
    if (providers === undefined) continue
    for (const [key, provider] of Object.entries(providers)) {
      if (!isPlainObject(provider) || !Array.isArray(provider.models)) continue
      const bucket = (result[key] ??= {})
      for (const model of provider.models) {
        if (!isPlainObject(model) || !isNonEmptyString(model.id)) continue
        const meta = {}
        for (const field of INHERITABLE_MODEL_FIELDS) {
          if (model[field] !== undefined) meta[field] = model[field]
        }
        if (Object.keys(meta).length === 0) continue
        // Later rows win: a patch applies top-down, so the last definition of
        // this model is the one in force.
        bucket[model.id] = { ...(bucket[model.id] ?? {}), ...meta }
      }
    }
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/** Copy inherited metadata into a model entry that does not declare it. */
function inheritModelEntry(model, providerMeta) {
  if (!isPlainObject(model) || !isNonEmptyString(model.id) || providerMeta === undefined) return model
  const meta = providerMeta[model.id]
  if (meta === undefined) return model
  let merged = model
  for (const field of INHERITABLE_MODEL_FIELDS) {
    if (merged[field] !== undefined) continue
    if (meta[field] === undefined) continue
    if (merged === model) merged = { ...model }
    merged[field] = meta[field]
  }
  return merged
}

/** Build one managed-block entry for an in-scope manifest item. */
function renderItemEntry(item, profile, knownProfiles, providers, inheritModelMeta) {
  const { config, disabled } = effectiveEntry(item, profile)
  let effectiveConfig = isPlainObject(config) ? config : {}
  if (item.id === 'llm-pi-ai') {
    const merged = {}
    let hasProvider = false
    const baseProviders = isPlainObject(effectiveConfig.providers) ? effectiveConfig.providers : undefined
    if (baseProviders !== undefined) {
      for (const [key, value] of Object.entries(baseProviders)) {
        merged[key] = value
        hasProvider = true
      }
    }
    for (const provider of providers) {
      if (!isInScope(provider, profile, knownProfiles)) continue
      const effective = effectiveEntry(provider, profile)
      if (effective.disabled) continue
      if (!isNonEmptyString(provider.key)) continue
      merged[provider.key] = isPlainObject(effective.config) ? effective.config : {}
      hasProvider = true
    }
    if (hasProvider) effectiveConfig = { ...effectiveConfig, providers: merged }
  }
  if (inheritModelMeta !== undefined && isPlainObject(effectiveConfig.providers)) {
    const providersOut = { ...effectiveConfig.providers }
    let touched = false
    for (const [key, providerConfig] of Object.entries(providersOut)) {
      const providerMeta = inheritModelMeta[key]
      if (providerMeta === undefined || !isPlainObject(providerConfig)) continue
      if (!Array.isArray(providerConfig.models)) continue
      providersOut[key] = {
        ...providerConfig,
        models: providerConfig.models.map((model) => inheritModelEntry(model, providerMeta)),
      }
      touched = true
    }
    if (touched) effectiveConfig = { ...effectiveConfig, providers: providersOut }
  }
  const entry = { id: item.id }
  if (isNonEmptyString(item.name)) entry.name = item.name
  entry.config = effectiveConfig
  if (disabled) entry.disabled = true
  return entry
}

/**
 * Render the managed block for one profile.
 *
 * @param {object} options
 * @param {object} options.manifest - normalized manifest.
 * @param {string} options.profile - profile name being rendered.
 * @param {string[]} [options.knownProfiles] - profile universe (defaults to `manifest.profiles`).
 * @param {(profile: string, rowId: string) => boolean} [options.rowExists]
 *        tells whether a row already exists in that profile's composition; used
 *        only for out-of-scope items that opt into `enforce`.
 * @param {Record<string, Record<string, object>>} [options.inheritModelMeta]
 *        output of {@link collectInheritedModelMeta} for this profile: metadata
 *        the manifest omits but the profile's own row already carries.
 * @returns {{ entries: object[], text: string, hash: string }}
 */
export function renderManagedBlock({ manifest, profile, knownProfiles, rowExists, inheritModelMeta } = {}) {
  const known = knownProfileList(manifest, knownProfiles)
  const exists = typeof rowExists === 'function' ? rowExists : () => false
  const items = Array.isArray(manifest?.items) ? manifest.items.filter(isPlainObject) : []
  const providers = Array.isArray(manifest?.providers) ? manifest.providers.filter(isPlainObject) : []

  const entries = []
  for (const item of items) {
    if (!isNonEmptyString(item.id)) continue
    if (isInScope(item, profile, known)) {
      entries.push(renderItemEntry(item, profile, known, providers, inheritModelMeta))
      continue
    }
    // Out of scope means "not applied": the profile keeps its own layer and the
    // bundle defaults. Only an explicit `enforce: true` turns the row off, and
    // only when the row actually exists there.
    if (item.enforce === true && exists(profile, item.id) === true) {
      entries.push({ id: item.id, disabled: true })
    }
  }

  const hash = hashEntries(entries)
  const body = stringifyYaml(entries)
  const header = `${BLOCK_HEADER_PREFIX} v1 sha256:${hash} —— generated from ${MANIFEST_DISPLAY_PATH}, do not edit`
  const text = `${header}\n${body}${BLOCK_FOOTER}\n`
  return { entries, text, hash }
}

/**
 * Insert or replace the managed block inside a profile patch file.
 * Text outside the block is preserved byte for byte; without markers the block
 * is appended after the existing content (separated by one blank line).
 *
 * @param {string} patchText - current `cordis.patch.yml` contents.
 * @param {string} blockText - output of {@link renderManagedBlock}.text.
 * @returns {string} next patch file contents.
 */
export function upsertManagedBlock(patchText, blockText) {
  const text = typeof patchText === 'string' ? patchText : ''
  const block = typeof blockText === 'string' ? blockText : ''
  const normalizedBlock = block === '' ? '' : block.endsWith('\n') ? block : `${block}\n`
  const range = findBlockRange(text)

  if (range === null) {
    if (text.trim() === '') return normalizedBlock
    const head = text.replace(/\n+$/, '')
    if (head === '') return normalizedBlock
    return `${head}\n\n${normalizedBlock}`
  }

  const lines = text.split('\n')
  let startOffset = 0
  for (let index = 0; index < range.startLine; index += 1) startOffset += lines[index].length + 1
  let endOffset = text.length
  if (range.complete) {
    let offset = startOffset
    for (let index = range.startLine; index <= range.endLine; index += 1) offset += lines[index].length + 1
    endOffset = Math.min(offset, text.length)
  }
  return `${text.slice(0, startOffset)}${normalizedBlock}${text.slice(endOffset)}`
}

/**
 * Read the managed block out of a patch file.
 *
 * @param {string} patchText
 * @returns {{ present: boolean, hash: string | null, text: string, complete: boolean } | null}
 *          null when no managed-block header exists. `text` keeps the marker
 *          lines, so `YAML.parse(block.text)` yields the entry list directly.
 */
export function extractManagedBlock(patchText) {
  const text = typeof patchText === 'string' ? patchText : ''
  const range = findBlockRange(text)
  if (range === null) return null
  const lines = text.split('\n')
  const bodyLines = range.complete ? lines.slice(range.startLine, range.endLine + 1) : lines.slice(range.startLine)
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '' && !range.complete) bodyLines.pop()
  const headerLine = lines[range.startLine]
  const hash = blockHashFromHeader(headerLine)
  return {
    present: true,
    hash,
    text: `${bodyLines.join('\n')}\n`,
    complete: range.complete,
  }
}

/**
 * Reconcile a profile's bundle selection with the manifest.
 *
 * Managed bundles (every name in `manifest.bundles`) are removed from the
 * current selection and the in-scope ones are appended in manifest order; the
 * non-managed bundles keep their original relative order in front. Deselecting
 * never touches `package.json` `dependencies` — the Host decides whether to
 * prune a dependency.
 *
 * @returns {{ bundles: string[], added: string[], removed: string[] }}
 */
export function reconcileBundles({ manifest, profile, knownProfiles, currentBundles } = {}) {
  const known = knownProfileList(manifest, knownProfiles)
  const current = Array.isArray(currentBundles) ? currentBundles.filter(isNonEmptyString) : []
  const managed = Array.isArray(manifest?.bundles) ? manifest.bundles.filter(isPlainObject) : []
  const managedNames = new Set(managed.map((bundle) => bundle.name).filter(isNonEmptyString))

  const selected = []
  for (const bundle of managed) {
    if (!isNonEmptyString(bundle.name)) continue
    if (!isInScope(bundle, profile, known)) continue
    if (effectiveEntry(bundle, profile).disabled) continue
    selected.push(bundle.name)
  }
  const selectedSet = new Set(selected)

  const kept = []
  const seen = new Set()
  for (const name of current) {
    if (managedNames.has(name)) continue
    if (seen.has(name)) continue
    seen.add(name)
    kept.push(name)
  }

  const added = selected.filter((name) => !current.includes(name))
  const removed = uniqueStrings(current.filter((name) => managedNames.has(name) && !selectedSet.has(name)))
  return { bundles: [...kept, ...selected], added, removed }
}
