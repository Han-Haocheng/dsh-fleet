/**
 * Shared helpers for dsh-fleet: deterministic hashing, YAML helpers, atomic
 * file replacement, timestamped backups, and the managed-block markers.
 *
 * Every function here is synchronous and side-effect free unless its name says
 * otherwise (`atomicWriteFileSync`, `backupFileSync`, `pruneBackups`). Profile
 * IO deliberately stays synchronous so `buildPlan`/`applyPlan` can run from a
 * short-lived CLI process without an event loop of their own.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import YAML from 'yaml'

/** Environment variable overriding the Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Suffix separating a file from its dsh-fleet backup siblings. */
export const BACKUP_SUFFIX = '.bak-fleet-'

/** How many timestamped backups one file keeps. */
export const MAX_BACKUPS = 5

/** Default mode for files dsh-fleet creates (they may hold API keys). */
export const DEFAULT_FILE_MODE = 0o600

/** The line opening a managed block. */
export const BLOCK_HEADER_PREFIX = '# >>> dsh-fleet'

/** The line closing a managed block. */
export const BLOCK_FOOTER = '# <<< dsh-fleet'

const HEADER_LINE_RE = /^# >>> dsh-fleet\b/
const FOOTER_LINE_RE = /^# <<< dsh-fleet\b/
const HASH_RE = /sha256:([0-9a-fA-F]{64})/

/** Whether a value is a JSON/YAML style plain object (not null, not an array). */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a non-empty string. */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Deep-copy plain data; `structuredClone` when available, JSON otherwise. */
export function deepClone(value) {
  if (value === undefined) return undefined
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      // Functions/symbols cannot be cloned; fall back to JSON for plain data.
    }
  }
  return JSON.parse(JSON.stringify(value))
}

/** Deduplicate strings while preserving first-seen order. */
export function uniqueStrings(values) {
  const seen = new Set()
  const out = []
  for (const value of values ?? []) {
    if (typeof value !== 'string' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** Hex sha256 of a string. */
export function sha256(input) {
  return createHash('sha256').update(typeof input === 'string' ? input : String(input), 'utf8').digest('hex')
}

/** Recursively sort object keys so JSON output ignores insertion order. */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key])
    return out
  }
  return value
}

/** Stable JSON used as the hash input for managed blocks. */
export function stableJson(value) {
  return JSON.stringify(sortKeysDeep(value === undefined ? null : value))
}

/** Expand `~`, `~/x` and `~\x` against the OS home; other paths pass through. */
export function expandHomePath(path) {
  if (typeof path !== 'string') return path
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Read a UTF-8 file, returning null for a missing file (other errors throw). */
export function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

/** Whether a regular file exists (symlinks followed). */
export function fileExists(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether a directory exists (symlinks followed). */
export function directoryExists(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** mkdir -p. */
export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

/**
 * Parse YAML strictly: syntax and duplicate-key errors throw. Used for
 * author-controlled documents (the fleet manifest, the managed block body).
 */
export function parseYaml(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  return YAML.parse(text, { prettyErrors: true })
}

/**
 * Parse YAML tolerantly: returns null instead of throwing, and unresolved
 * custom tags (`!!js`, `!include`) keep their scalar text. Used when replaying
 * bundle patches, whose author is a third party we must not fail on.
 */
export function parseYamlTolerant(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    return YAML.parse(text, { logLevel: 'silent' })
  } catch {
    return null
  }
}

/** Stable YAML: never wrap long lines, never emit anchors/aliases. */
export function stringifyYaml(value) {
  return YAML.stringify(value, { lineWidth: 0, aliasDuplicateObjects: false })
}

/** Timestamp for backup names: `YYYYMMDD-HHMMSSmmm` (lexicographic = chronological). */
export function backupStamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`
  )
}

/**
 * Write `text` to `path` atomically: a random-suffix sibling is created with
 * `wx` and the caller's mode, then renamed over the target. The target's mode
 * is preserved; new files default to 0600.
 */
export function atomicWriteFileSync(path, text, options = {}) {
  const dir = dirname(path)
  ensureDir(dir)
  let mode = options.mode
  if (mode === undefined) {
    try {
      mode = statSync(path).mode & 0o777
    } catch {
      mode = DEFAULT_FILE_MODE
    }
  }
  const temp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, text, { mode, flag: 'wx' })
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may never have been created.
    }
    throw error
  }
}

/** Every backup sibling of `path`, oldest first (timestamped names sort). */
export function listBackupFiles(path) {
  const dir = dirname(path)
  const prefix = `${basename(path)}${BACKUP_SUFFIX}`
  let entries
  try {
    entries = readdirSync(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((entry) => entry.startsWith(prefix))
    .sort()
    .map((entry) => join(dir, entry))
}

/** Delete all but the newest `keep` backups of `path`. */
export function pruneBackups(path, keep = MAX_BACKUPS) {
  const backups = listBackupFiles(path)
  const excess = backups.length - keep
  if (excess <= 0) return []
  const removed = backups.slice(0, excess)
  for (const stale of removed) {
    try {
      rmSync(stale, { force: true })
    } catch {
      // A backup that cannot be removed must never break an apply.
    }
  }
  return removed
}

/**
 * Copy `path` to `<path>.bak-fleet-<stamp>` before it is rewritten. Missing
 * files have nothing to back up and return null. The oldest backups beyond
 * `options.keep` are pruned.
 */
export function backupFileSync(path, options = {}) {
  if (!fileExists(path)) return null
  const stamp = options.stamp ?? backupStamp()
  const prefix = `${path}${BACKUP_SUFFIX}${stamp}`
  let backupPath = prefix
  let attempt = 0
  while (fileExists(backupPath)) {
    attempt += 1
    backupPath = `${prefix}-${attempt}`
    if (attempt > 100) break
  }
  copyFileSync(path, backupPath)
  try {
    chmodSync(backupPath, statSync(path).mode & 0o777)
  } catch {
    // Mode restoration is best effort.
  }
  pruneBackups(path, options.keep ?? MAX_BACKUPS)
  return backupPath
}

/** Whether a line opens a managed block. */
export function isBlockHeaderLine(line) {
  return typeof line === 'string' && HEADER_LINE_RE.test(line)
}

/** Whether a line closes a managed block. */
export function isBlockFooterLine(line) {
  return typeof line === 'string' && FOOTER_LINE_RE.test(line)
}

/** The sha256 recorded in a managed-block header line, or null. */
export function blockHashFromHeader(line) {
  const match = HASH_RE.exec(typeof line === 'string' ? line : '')
  return match === null ? null : match[1].toLowerCase()
}

/**
 * Locate the first managed block inside a patch document.
 * @returns `{ startLine, endLine, complete }` (line indices, endLine inclusive)
 *          or null when no header line exists.
 */
export function findBlockRange(patchText) {
  const lines = typeof patchText === 'string' ? patchText.split('\n') : []
  let startLine = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (isBlockHeaderLine(lines[index])) {
      startLine = index
      break
    }
  }
  if (startLine < 0) return null
  for (let index = startLine + 1; index < lines.length; index += 1) {
    if (isBlockFooterLine(lines[index])) return { startLine, endLine: index, complete: true }
  }
  return { startLine, endLine: lines.length - 1, complete: false }
}

/** The YAML body of a managed block, without its marker lines. */
export function managedBlockBody(blockText) {
  const lines = typeof blockText === 'string' ? blockText.split('\n') : []
  const body = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (index === 0 && isBlockHeaderLine(line)) continue
    if (isBlockFooterLine(line)) continue
    body.push(line)
  }
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  return body.join('\n')
}

/** Collapse a value into a one-line diagnostic suffix. */
export function shortText(value, limit = 200) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * Deep-copy a value into lossless JSON: object properties whose value is
 * `undefined` are dropped, `undefined` array entries become `null`, and a
 * `Date` becomes its ISO string.
 *
 * The Harness snapshots every agent-tool result with `snapshotJsonValue` and
 * throws `ToolOutputError: value is not lossless JSON` when any property is
 * `undefined` — JSON.stringify would silently drop it, so the round trip
 * differs. Tool payloads therefore go through here before they are returned.
 * `null` is a legal JSON value and means "known to be empty"; only `undefined`
 * means "absent", and absent keys must not be sent at all.
 */
export function stripUndefinedJson(value) {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefinedJson(entry) ?? null)
  }
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    const cleaned = stripUndefinedJson(entry)
    if (cleaned === undefined) continue
    out[key] = cleaned
  }
  return out
}

/**
 * Run a child process and capture its output, with a timeout that escalates
 * from SIGTERM to SIGKILL. Never rejects: start failures and timeouts are
 * reported in the returned record.
 *
 * @param {{ command: string, args?: string[], timeoutMs?: number, cwd?: string,
 *           env?: Record<string, string | undefined>, maxOutputBytes?: number }} options
 * @returns {Promise<{
 *   ok: boolean, code: number | null, signal: string | null, timedOut: boolean,
 *   stdout: string, stderr: string, error: Error | null,
 * }>}
 */
export function runProcess({ command, args = [], timeoutMs = 60_000, cwd, env, maxOutputBytes = 256 * 1024 } = {}) {
  return new Promise((resolvePromise) => {
    const append = (current, chunk) => {
      if (current.length >= maxOutputBytes) return current
      return current + chunk.toString('utf8').slice(0, maxOutputBytes - current.length)
    }
    let child
    try {
      child = spawn(command, args, {
        cwd: cwd ?? process.cwd(),
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ ok: false, code: null, signal: null, timedOut: false, stdout: '', stderr: '', error })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let killTimer
    let hardKillTimer
    const finish = (result) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (hardKillTimer) clearTimeout(hardKillTimer)
      resolvePromise(result)
    }
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGTERM')
        } catch {
          // The child already exited.
        }
        hardKillTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // The child already exited.
          }
        }, 2_000)
        hardKillTimer.unref?.()
      }, timeoutMs)
      killTimer.unref?.()
    }
    child.on('error', (error) => {
      finish({ ok: false, code: null, signal: null, timedOut: false, stdout, stderr, error })
    })
    child.on('close', (code, signal) => {
      finish({
        ok: code === 0 && !timedOut,
        code,
        signal: signal ?? null,
        timedOut,
        stdout,
        stderr,
        error: null,
      })
    })
  })
}
