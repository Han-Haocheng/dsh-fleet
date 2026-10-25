/**
 * Restoring fleet's own timestamped backups.
 *
 * `writeProfileFiles` backs up `package.json` and `cordis.patch.yml` before
 * rewriting them. This module lists those backups and restores the newest
 * copy of each file (or the copies carrying one explicit stamp), taking a
 * fresh backup of the current content first so a restore can be undone too.
 */
import { copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { backupFileSync, listBackupFiles } from './util.js'

/** Files fleet rewrites inside a profile directory. */
export const RESTORABLE_FILES = ['cordis.patch.yml', 'package.json']

const BACKUP_SUFFIX = '.bak-fleet-'

/** Timestamp part of one backup file, or null when the name does not match. */
function stampOf(file, name) {
  const prefix = `${name}${BACKUP_SUFFIX}`
  const base = basename(file)
  return base.startsWith(prefix) ? base.slice(prefix.length) : null
}

/**
 * Every restorable backup, newest first.
 *
 * @returns {{ file: string, path: string, stamp: string }[]}
 */
export function listProfileBackups(profileDir) {
  const entries = []
  for (const name of RESTORABLE_FILES) {
    for (const path of listBackupFiles(join(profileDir, name))) {
      const stamp = stampOf(path, name)
      if (stamp !== null) entries.push({ file: name, path, stamp })
    }
  }
  return entries.sort((left, right) => right.stamp.localeCompare(left.stamp))
}

/**
 * Restore backups inside one profile directory.
 *
 * With no `stamp`, the newest backup of each file is restored (the state
 * before the most recent apply). With a `stamp`, only files carrying that
 * exact stamp are restored.
 *
 * @param {string} profileDir
 * @param {{ stamp?: string }} [options]
 * @returns {{ restored: { file: string, stamp: string }[], skipped: string[], errors: string[] }}
 */
export function restoreProfileBackups(profileDir, options = {}) {
  const restored = []
  const skipped = []
  const errors = []
  const stamp = options.stamp
  for (const name of RESTORABLE_FILES) {
    const backups = listBackupFiles(join(profileDir, name)).map((path) => ({ path, stamp: stampOf(path, name) }))
    const chosen =
      stamp === undefined
        ? backups[backups.length - 1] ?? null
        : backups.findLast((entry) => entry.stamp === stamp) ?? null
    if (chosen === null) {
      skipped.push(name)
      continue
    }
    const target = join(profileDir, name)
    try {
      backupFileSync(target)
      copyFileSync(chosen.path, target)
      restored.push({ file: name, stamp: chosen.stamp })
    } catch (error) {
      errors.push(`${name}: ${error?.message ?? error}`)
    }
  }
  return { restored, skipped, errors }
}
