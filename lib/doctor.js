/**
 * One-shot environment diagnostics shared by the Host action and the CLI.
 *
 * The report never writes: each finding says what is wrong and, when the fix is
 * mechanical, what the operator can do. Levels: `error` blocks a clean apply,
 * `warn` needs attention, `info` is context.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

async function fileSize(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/**
 * @param {object} input
 * @param {string} input.home - Harness home (`$DSH_HOME`).
 * @param {string} input.manifestPath - manifest path for display.
 * @param {string|null} input.currentProfile - profile this Host runs in.
 * @param {string[]} input.knownProfiles
 * @param {Map<string, object>} input.states
 * @param {string[]} input.manifestErrors
 * @param {{pendingInstalls?: object[]}} [input.plan]
 * @param {{profile: string, count: number}[]} [input.backups]
 * @param {{name: string}[]} [input.unmanaged]
 * @param {{held: boolean, owner: string|null}} [input.lock]
 * @param {(profile: string) => string} input.capability
 * @param {number} [input.rejectLogLimit]
 * @returns {Promise<{ok: boolean, checks: object[], manifestPath: string}>}
 */
export async function doctorReport(input) {
  const checks = []
  const add = (level, title, detail, fix) => checks.push(fix === undefined ? { level, title, detail } : { level, title, detail, fix })

  if (input.manifestErrors?.length > 0) {
    add('error', 'manifest', input.manifestErrors.join('\n'), `fix ${input.manifestPath} and reload the page`)
  } else {
    add('ok', 'manifest', `${input.manifestPath} parses and validates`)
  }

  const homePatch = join(input.home, 'cordis.patch.yml')
  const homePatchSize = await fileSize(homePatch)
  if (homePatchSize !== null) {
    add(
      'warn',
      'home patch layer',
      `${homePatch} is applied after profile patches, so its rows override fleet's managed block`,
      'move those rows into fleet.yml (with the right scope) or delete the home patch layer',
    )
  }

  if (input.lock?.held) {
    add(
      'warn',
      'write lock',
      `held by ${input.lock.owner ?? 'unknown'}; a crashed apply can leave it behind`,
      `delete ${join(input.home, 'fleet.lock')} only when no apply is running`,
    )
  }

  for (const profile of input.knownProfiles ?? []) {
    const state = input.states?.get(profile)
    if (state === undefined || state === null) {
      add('error', `profile ${profile}`, 'state is unavailable')
      continue
    }
    if (state.present === false) {
      add('error', `profile ${profile}`, 'profile directory does not exist', `start the ${profile} profile once, then apply again`)
      continue
    }
    if (!state.error) add('ok', `profile ${profile}`, 'directory and manifest are readable')
    const capability = input.capability?.(profile) ?? 'manual'
    if (capability === 'manual') {
      add(
        'warn',
        `install capability (${profile})`,
        'packages cannot be installed automatically from the current profile',
        'run the apply from the desktop app for desktop, or install the listed packages with the official CLI',
      )
    } else if (capability === 'service') {
      add('ok', `install capability (${profile})`, 'plugin-manager service (current profile)')
    } else {
      add('ok', `install capability (${profile})`, 'official dsh CLI')
    }
  }

  const outdated = (input.plan?.pendingInstalls ?? []).filter((entry) => entry.outdated === true)
  if (outdated.length > 0) {
    add(
      'info',
      'versions',
      outdated.map((entry) => `${entry.profile}: ${entry.bundle} ${entry.from} → ${entry.spec.split('@').pop()}`).join('; '),
      'apply upgrades them',
    )
  }

  if ((input.unmanaged?.length ?? 0) > 0) {
    add(
      'info',
      'unmanaged bundles',
      input.unmanaged.map((entry) => entry.name).join(', '),
      'adopt them from the plugins tab if they should be managed here',
    )
  }

  if ((input.backups?.length ?? 0) > 0) {
    add(
      'info',
      'backups',
      input.backups.map((entry) => `${entry.profile}: ${entry.count}`).join(', '),
      'use restore to roll back the newest apply',
    )
  }

  const rejectSize = await fileSize(join(input.home, 'fleet.reject.log'))
  const limit = input.rejectLogLimit ?? 256 * 1024
  if (rejectSize !== null && rejectSize > limit) {
    add(
      'warn',
      'reject log',
      `fleet.reject.log is ${Math.round(rejectSize / 1024)} KiB`,
      'rotate or delete it; only rejected cross-origin requests are logged there',
    )
  }

  return {
    ok: !checks.some((check) => check.level === 'error'),
    checks,
    manifestPath: input.manifestPath,
  }
}
