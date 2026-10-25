/**
 * Profile state reading plus every file write dsh-fleet performs.
 *
 * A profile is `$DSH_HOME/profiles/<name>`: a `package.json` whose
 * `dsh.profile.bundles` list is the ordered bundle layer selection, and a
 * `cordis.patch.yml` holding the user's own patch layer (which is where the
 * fleet managed block lives). Bundles resolve from the DSH installation first
 * and from the profile's `node_modules` second, mirroring the DSH launcher.
 */
import { createRequire } from 'node:module'
import { closeSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  atomicWriteFileSync,
  backupFileSync,
  directoryExists,
  DSH_HOME_ENV,
  ensureDir,
  expandHomePath,
  fileExists,
  isNonEmptyString,
  isPlainObject,
  parseYamlTolerant,
  readTextFile,
  uniqueStrings,
} from './util.js'

/** A lock older than this is considered abandoned. */
export const LOCK_STALE_MS = 10 * 60 * 1000

/** The manifest file name under the Harness home. */
export const MANIFEST_FILENAME = 'fleet.yml'

/** The lock file name under the Harness home. */
export const LOCK_FILENAME = 'fleet.lock'

/** The per-profile user patch file. */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The per-profile manifest file. */
export const PROFILE_MANIFEST_FILENAME = 'package.json'

/** Resolve the Harness home: `$DSH_HOME` when set, `~/.dsh` otherwise. */
export function homeFrom(env = process.env) {
  const raw = typeof env?.[DSH_HOME_ENV] === 'string' ? env[DSH_HOME_ENV].trim() : ''
  return resolve(raw === '' ? join(homedir(), '.dsh') : expandHomePath(raw))
}

/** Reject profile names that could escape `profiles/`. */
function assertProfileName(name) {
  if (!isNonEmptyString(name)) throw new Error('profile name is required')
  if (name === '.' || name === '..' || name === 'node_modules' || /[\\/]/.test(name)) {
    throw new Error(`invalid profile name ${JSON.stringify(name)}`)
  }
  return name
}

/** Absolute directory of one profile. */
function profileDirectory(home, name) {
  return join(resolve(home ?? homeFrom()), 'profiles', assertProfileName(name))
}

/** Names of every initialized profile under `<home>/profiles`, sorted. */
export function discoverProfiles(home) {
  const profilesDir = join(resolve(home ?? homeFrom()), 'profiles')
  let entries
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
  const names = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const name = entry.name
    if (name.startsWith('.') || !isNonEmptyString(name)) continue
    if (!fileExists(join(profilesDir, name, PROFILE_MANIFEST_FILENAME))) continue
    names.push(name)
  }
  return names.sort()
}

/** Normalize an install anchor: a package directory, its package.json, or a file inside it. */
function anchorFileFrom(installAnchor) {
  if (!isNonEmptyString(installAnchor)) return null
  const absolute = resolve(expandHomePath(installAnchor.trim()))
  try {
    if (directoryExists(absolute)) return join(absolute, PROFILE_MANIFEST_FILENAME)
  } catch {
    // Fall through: treat it as a file path.
  }
  return absolute
}

/** Node's own node_modules lookup order from one anchor package.json file. */
function packageDirFromAnchor(anchorFile, packageName) {
  try {
    const anchorRequire = createRequire(anchorFile)
    for (const searchPath of anchorRequire.resolve.paths(packageName) ?? []) {
      if (!isNonEmptyString(searchPath)) continue
      const candidate = join(searchPath, packageName)
      if (fileExists(join(candidate, PROFILE_MANIFEST_FILENAME))) return candidate
    }
  } catch {
    // Fall through to the sibling node_modules probe.
  }
  const candidate = join(resolve(anchorFile, '..'), 'node_modules', packageName)
  return fileExists(join(candidate, PROFILE_MANIFEST_FILENAME)) ? candidate : null
}

/** Read a package.json value, or null when unreadable/invalid. */
function readPackageManifest(packageDir) {
  const text = readTextFile(join(packageDir, PROFILE_MANIFEST_FILENAME))
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Resolve a bundle package to a directory, preferring the installation anchor. */
function resolveBundleLocation(name, profileDir, installAnchor) {
  if (!isNonEmptyString(name)) return { installed: false, from: null, version: null, dir: null }
  const anchors = []
  const installFile = anchorFileFrom(installAnchor)
  if (installFile !== null) anchors.push({ anchor: installFile, from: 'installation' })
  if (isNonEmptyString(profileDir)) {
    anchors.push({ anchor: join(resolve(profileDir), PROFILE_MANIFEST_FILENAME), from: 'profile' })
  }
  for (const { anchor, from } of anchors) {
    const dir = packageDirFromAnchor(anchor, name)
    if (dir === null) continue
    const manifest = readPackageManifest(dir)
    return { installed: true, from, version: typeof manifest?.version === 'string' ? manifest.version : null, dir }
  }
  return { installed: false, from: null, version: null, dir: null }
}

/**
 * Resolve one bundle package for a profile.
 *
 * @param {string} name - package name from `dsh.profile.bundles`.
 * @param {string} profileDir - absolute profile directory.
 * @param {string} [installAnchor] - DSH installation directory (or a file inside it).
 * @returns {{ installed: boolean, from: 'profile' | 'installation' | null, version: string | null }}
 */
export function resolveBundlePackage(name, profileDir, installAnchor) {
  const location = resolveBundleLocation(name, profileDir, installAnchor)
  return { installed: location.installed, from: location.from, version: location.version }
}

/** Resolve a bundle package to its directory (installation anchor first). */
export function resolveBundleDir(name, profileDir, installAnchor) {
  return resolveBundleLocation(name, profileDir, installAnchor).dir
}

/** Sentinel: a patch uses a construct this best-effort replayer refuses to guess. */
class SkipPatchFile extends Error {}

/** Whether a patch entry is an include we cannot replay. */
function isIncludeEntry(entry) {
  if (entry.include !== undefined || entry['cordis:include'] !== undefined) return true
  return typeof entry.name === 'string' && entry.name.includes('cordis-plugin-include')
}

/** Index one entry (and its group children) by id. */
function replayEntry(entry, ids) {
  if (!isPlainObject(entry)) return
  if (isIncludeEntry(entry)) throw new SkipPatchFile()
  if (isNonEmptyString(entry.id)) ids.add(entry.id)
  if (entry.group === true && Array.isArray(entry.config)) {
    for (const child of entry.config) replayEntry(child, ids)
  }
}

/** Index one patch (insert list or id-targeted override). */
function replayPatch(patch, ids) {
  if (!isPlainObject(patch)) return
  if (isIncludeEntry(patch)) throw new SkipPatchFile()
  if (Array.isArray(patch.insert)) {
    if (isNonEmptyString(patch.id)) ids.add(patch.id)
    for (const entry of patch.insert) replayEntry(entry, ids)
    return
  }
  if (isNonEmptyString(patch.id)) ids.add(patch.id)
}

/** Index a whole patch document. */
function replayDocument(document, ids) {
  if (Array.isArray(document)) {
    for (const patch of document) replayPatch(patch, ids)
    return
  }
  if (!isPlainObject(document)) return
  if (Array.isArray(document.insert)) {
    for (const entry of document.insert) replayEntry(entry, ids)
    return
  }
  if (Array.isArray(document.patches)) {
    for (const patch of document.patches) replayPatch(patch, ids)
    return
  }
  replayEntry(document, ids)
}

/** Replay one patch file text into `ids`; unparsable/include documents add nothing. */
function replayPatchText(text, ids) {
  const document = parseYamlTolerant(text)
  if (document === null || document === undefined) return
  const local = new Set()
  try {
    replayDocument(document, local)
  } catch (error) {
    if (error instanceof SkipPatchFile) return
    throw error
  }
  for (const id of local) ids.add(id)
}

/**
 * Best-effort replay of the row ids a profile's composition declares: every
 * bundle patch insert plus the profile's own patch file. Unreadable patches and
 * unsupported include constructs are skipped, never thrown.
 *
 * @param {{ bundles?: string[], profileDir?: string, installAnchor?: string, patchText?: string }} options
 * @returns {Set<string>}
 */
export function collectRowIds({ bundles, profileDir, installAnchor, patchText } = {}) {
  const rowIds = new Set()
  const selected = Array.isArray(bundles) ? bundles.filter(isNonEmptyString) : []
  for (const name of uniqueStrings(selected)) {
    const location = resolveBundleLocation(name, profileDir, installAnchor)
    if (!location.installed || location.dir === null) continue
    const manifest = readPackageManifest(location.dir)
    const declared = manifest?.dsh?.bundle?.patch
    const patchFiles = typeof declared === 'string'
      ? [declared]
      : Array.isArray(declared)
        ? declared.filter(isNonEmptyString)
        : []
    for (const relative of patchFiles) {
      let text
      try {
        text = readTextFile(join(location.dir, relative))
      } catch {
        text = null
      }
      if (typeof text === 'string') replayPatchText(text, rowIds)
    }
  }
  if (typeof patchText === 'string' && patchText.trim() !== '') replayPatchText(patchText, rowIds)
  return rowIds
}

/**
 * Read everything the planner needs to know about one profile.
 *
 * @param {string} home - Harness home.
 * @param {string} name - profile name.
 * @param {{ installAnchor?: string }} [options]
 * @returns {{
 *   name: string, dir: string, present: boolean, bundles: string[],
 *   dependencies: Record<string, string>, patchText: string,
 *   installed: Set<string>, rowIds: Set<string>, error?: string,
 * }}
 */
export function readProfileState(home, name, options = {}) {
  const dir = profileDirectory(home, name)
  const present = directoryExists(dir)
  const installAnchor = options?.installAnchor ?? null
  let bundles = []
  let dependencies = {}
  let error = null

  const manifestText = readTextFile(join(dir, PROFILE_MANIFEST_FILENAME))
  if (manifestText !== null) {
    try {
      const parsed = JSON.parse(manifestText)
      if (!isPlainObject(parsed)) throw new Error('must hold a JSON object')
      const declared = parsed?.dsh?.profile?.bundles
      if (Array.isArray(declared)) bundles = declared.filter((value) => typeof value === 'string')
      if (isPlainObject(parsed?.dependencies)) dependencies = parsed.dependencies
    } catch (manifestError) {
      error = `invalid profile manifest ${join(dir, PROFILE_MANIFEST_FILENAME)}: ${manifestError?.message ?? manifestError}`
    }
  }

  let patchText = ''
  try {
    patchText = readTextFile(join(dir, PROFILE_PATCH_FILENAME)) ?? ''
  } catch (patchError) {
    error = error ?? `cannot read ${join(dir, PROFILE_PATCH_FILENAME)}: ${patchError?.message ?? patchError}`
  }

  const installed = new Set()
  for (const candidate of uniqueStrings([...bundles, ...Object.keys(dependencies)])) {
    if (resolveBundleLocation(candidate, dir, installAnchor).installed) installed.add(candidate)
  }

  let rowIds = new Set()
  try {
    rowIds = collectRowIds({ bundles, profileDir: dir, installAnchor, patchText })
  } catch (replayError) {
    error = error ?? `cannot replay profile rows: ${replayError?.message ?? replayError}`
  }

  const state = { name, dir, present, bundles, dependencies, patchText, installed, rowIds }
  if (error !== null) state.error = error
  return state
}

/**
 * Write one profile's `package.json` bundle selection and `cordis.patch.yml`.
 *
 * Files are atomically replaced after a timestamped backup, and only when the
 * bytes actually change, so a no-op apply leaves the profile untouched.
 * `dependencies` are merged over the existing ones (never removed) — pruning a
 * dependency stays the Host's decision.
 *
 * @returns {{ backups: string[], files: string[] }}
 */
export function writeProfileFiles({ home, name, patchText, bundles, dependencies } = {}) {
  const dir = profileDirectory(home, name)
  ensureDir(dir)
  const backups = []
  const files = []

  const manifestPath = join(dir, PROFILE_MANIFEST_FILENAME)
  const existingText = readTextFile(manifestPath)
  let manifest
  if (existingText === null) {
    manifest = { name: `dsh-profile-${name}`, private: true, dependencies: {} }
  } else {
    try {
      manifest = JSON.parse(existingText)
    } catch (manifestError) {
      throw new Error(`invalid profile manifest ${manifestPath}: ${manifestError?.message ?? manifestError}`)
    }
    if (!isPlainObject(manifest)) throw new Error(`invalid profile manifest ${manifestPath}: must hold a JSON object`)
  }

  if (Array.isArray(bundles)) {
    manifest.dsh = isPlainObject(manifest.dsh) ? manifest.dsh : {}
    manifest.dsh.profile = isPlainObject(manifest.dsh.profile) ? manifest.dsh.profile : {}
    manifest.dsh.profile.bundles = bundles.filter(isNonEmptyString)
  }
  if (isPlainObject(dependencies)) {
    manifest.dependencies = {
      ...(isPlainObject(manifest.dependencies) ? manifest.dependencies : {}),
      ...dependencies,
    }
  }

  const nextManifestText = `${JSON.stringify(manifest, undefined, 2)}\n`
  if (nextManifestText !== existingText) {
    const backup = backupFileSync(manifestPath)
    if (backup !== null) backups.push(backup)
    atomicWriteFileSync(manifestPath, nextManifestText)
    files.push(manifestPath)
  }

  if (typeof patchText === 'string') {
    const patchPath = join(dir, PROFILE_PATCH_FILENAME)
    const currentText = readTextFile(patchPath)
    if (patchText !== (currentText ?? '')) {
      const backup = backupFileSync(patchPath)
      if (backup !== null) backups.push(backup)
      atomicWriteFileSync(patchPath, patchText)
      files.push(patchPath)
    }
  }

  return { backups, files }
}

/** Read `<home>/fleet.yml`; `text` is null when the file does not exist. */
export function readManifestFile(home) {
  const path = join(resolve(home ?? homeFrom()), MANIFEST_FILENAME)
  return { text: readTextFile(path), path }
}

/** Atomically replace `<home>/fleet.yml` after backing the previous version up. */
export function writeManifestFile(home, text) {
  const root = resolve(home ?? homeFrom())
  ensureDir(root)
  const path = join(root, MANIFEST_FILENAME)
  const backup = backupFileSync(path)
  atomicWriteFileSync(path, typeof text === 'string' ? text : `${text ?? ''}`)
  return { path, backup }
}

/** Read the lock record; null means missing or unusable (i.e. stale). */
function readLockRecord(lockPath) {
  const text = readTextFile(lockPath)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Whether the recorded holder is gone (dead pid, old timestamp, bad record). */
function lockIsStale(record, staleMs, now) {
  if (!isPlainObject(record)) return true
  const pid = Number(record.pid)
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) return true
  const startedAt = Date.parse(typeof record.startedAt === 'string' ? record.startedAt : '')
  if (!Number.isFinite(startedAt)) return true
  if (now - startedAt > staleMs) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/** Remove the lock only when this acquisition still owns it. */
function dropLock(lockPath, nonce) {
  const record = readLockRecord(lockPath)
  if (record === null) return
  if (record.nonce !== nonce) return
  try {
    unlinkSync(lockPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * Acquire the cross-process apply lock (`<home>/fleet.lock`) with `wx`.
 *
 * A lock whose recorded pid is gone, whose `startedAt` is older than
 * `staleMs` (10 minutes by default), or whose record is unreadable is treated
 * as abandoned and taken over.
 *
 * @param {string} home - Harness home.
 * @param {{ owner?: string, staleMs?: number, now?: number }} [opts]
 *        `owner` is the display label stored in the lock file (and returned);
 *        `now` exists for deterministic tests.
 * @returns {{ ok: boolean, owner: string | null, release: () => void }}
 */
export function acquireLock(home, opts = {}) {
  const root = resolve(home ?? homeFrom())
  ensureDir(root)
  const lockPath = join(root, LOCK_FILENAME)
  const owner = isNonEmptyString(opts.owner) ? opts.owner : `pid:${process.pid}`
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : LOCK_STALE_MS
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const nonce = randomBytes(8).toString('hex')
  const record = { owner, pid: process.pid, startedAt: new Date(now).toISOString(), nonce }
  const payload = `${JSON.stringify(record)}\n`

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const holder = readLockRecord(lockPath)
      if (holder !== null && !lockIsStale(holder, staleMs, now)) {
        return { ok: false, owner: isNonEmptyString(holder.owner) ? holder.owner : `pid:${holder.pid}`, release: () => {} }
      }
      // The record is abandoned (dead pid, old timestamp, unreadable, or gone).
      try {
        unlinkSync(lockPath)
      } catch (removeError) {
        if (removeError?.code !== 'ENOENT') {
          // Another contender won the takeover race; report the lock as held.
          const current = readLockRecord(lockPath)
          return { ok: false, owner: isNonEmptyString(current?.owner) ? current.owner : null, release: () => {} }
        }
      }
      continue
    }
    try {
      writeFileSync(fd, payload)
    } finally {
      closeSync(fd)
    }
    let released = false
    return {
      ok: true,
      owner,
      release() {
        if (released) return
        released = true
        dropLock(lockPath, nonce)
      },
    }
  }

  const holder = readLockRecord(lockPath)
  return { ok: false, owner: isNonEmptyString(holder?.owner) ? holder.owner : null, release: () => {} }
}

/** Atomically replace a file, preserving its mode. See util.atomicWriteFileSync. */
export function atomicWriteFile(path, text) {
  atomicWriteFileSync(path, text)
}

/** Back a file up to `<file>.bak-fleet-<stamp>`, keeping the newest five. */
export function backupFile(path) {
  return backupFileSync(path)
}
