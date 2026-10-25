/**
 * Package installation for the two surfaces a Host can reach:
 *
 * - the running profile, through the official `pluginManager` service
 *   (`installBundle`), which reloads the live tree when the profile allows it;
 * - any other CLI-managed profile, through `dsh plugin --profile <p> add <spec>`.
 *
 * Desktop is a reserved profile the Electron app owns: the CLI refuses it and
 * only an in-process service inside desktop can install into it, so
 * {@link capabilityFor} reports it as `manual` from every other profile.
 */
import { isNonEmptyString, runProcess, shortText } from './util.js'

/** One-line description of a plugin-manager `ChangeResult`. */
function describeChangeResult(result) {
  const parts = []
  if (isNonEmptyString(result?.bundle)) {
    parts.push(`installed ${result.bundle}${isNonEmptyString(result.version) ? `@${result.version}` : ''}`)
  }
  if (isNonEmptyString(result?.application)) parts.push(`application: ${result.application}`)
  const error = result?.error
  if (error && typeof error === 'object') {
    const code = isNonEmptyString(error.code) ? error.code : 'error'
    parts.push(isNonEmptyString(error.diagnostic) ? `${code}: ${shortText(error.diagnostic, 400)}` : code)
  }
  const packageResult = result?.packageResult
  if (packageResult && typeof packageResult === 'object' && isNonEmptyString(packageResult.kind)) {
    parts.push(`package manager: ${packageResult.kind}`)
  }
  if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
    parts.push(`warnings: ${result.warnings.map((warning) => shortText(warning, 120)).join('; ')}`)
  }
  return parts.length > 0 ? parts.join('; ') : 'the plugin manager reported no outcome'
}

/**
 * How one profile's missing package can be installed.
 *
 * @param {{ currentProfile?: string | null, targetProfile?: string | null }} options
 * @returns {'service' | 'cli' | 'manual'}
 */
export function capabilityFor({ currentProfile, targetProfile } = {}) {
  const target = isNonEmptyString(targetProfile) ? targetProfile.trim() : ''
  const current = isNonEmptyString(currentProfile) ? currentProfile.trim() : ''
  if (target === '') return 'manual'
  if (current !== '' && target === current) return 'service'
  // Desktop's reserved profile is managed exclusively by the Electron carrier.
  if (target === 'desktop') return 'manual'
  return 'cli'
}

/**
 * Install one bundle into the profile this process is running in, through the
 * official plugin-manager service.
 *
 * @param {{ installBundle: (spec: string, options?: object) => Promise<object> }} pluginManager
 *        the Cordis `pluginManager` service (may be missing: degraded hosts).
 * @param {string} spec - package spec, e.g. `dsh-mnemon@0.5.34`.
 * @param {object} [opts] - forwarded to `pluginManager.installBundle`.
 * @returns {Promise<{ ok: boolean, detail: string, restartRequired: boolean }>}
 */
export async function installInCurrentProfile(pluginManager, spec, opts = {}) {
  if (!isNonEmptyString(spec)) {
    return { ok: false, detail: 'install spec is required', restartRequired: false }
  }
  if (!pluginManager || typeof pluginManager.installBundle !== 'function') {
    return { ok: false, detail: 'the pluginManager service is unavailable in this profile', restartRequired: false }
  }
  try {
    const result = await pluginManager.installBundle(spec, opts ?? {})
    const application = typeof result?.application === 'string' ? result.application : ''
    const ok = application === 'applied' || application === 'restart-required' || application === 'overridden'
    return {
      ok,
      detail: describeChangeResult(result),
      restartRequired: application === 'restart-required',
    }
  } catch (error) {
    return { ok: false, detail: shortText(error?.message ?? error, 600), restartRequired: false }
  }
}

/** Whether a command names a JavaScript entry point that needs `node` in front. */
function needsNodeRunner(command) {
  return /\.(?:mjs|cjs|js)$/i.test(command)
}

/**
 * Install one bundle into another profile through the official CLI:
 * `dsh plugin --profile <profile> add <spec>`.
 *
 * @param {{ dshBin?: string, profile?: string, spec?: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, detail: string, stdout: string, stderr: string, code: number | null, timedOut: boolean }>}
 */
export async function installViaCli({ dshBin, profile, spec, timeoutMs = 300_000 } = {}) {
  const stdout = ''
  const stderr = ''
  if (!isNonEmptyString(dshBin)) {
    return { ok: false, detail: 'the dsh CLI path is required', stdout, stderr, code: null, timedOut: false }
  }
  if (!isNonEmptyString(profile) || !isNonEmptyString(spec)) {
    return { ok: false, detail: 'profile and spec are required', stdout, stderr, code: null, timedOut: false }
  }
  const bin = dshBin.trim()
  const args = ['plugin', '--profile', profile.trim(), 'add', spec.trim()]
  const command = needsNodeRunner(bin) ? process.execPath : bin
  const resolvedArgs = needsNodeRunner(bin) ? [bin, ...args] : args
  const result = await runProcess({ command, args: resolvedArgs, timeoutMs })
  let detail
  if (result.error) {
    detail = `cannot run ${bin}: ${shortText(result.error.message ?? result.error, 400)}`
  } else if (result.timedOut) {
    detail = `timed out after ${timeoutMs}ms`
  } else if (result.code === 0) {
    detail = `installed ${spec.trim()}`
  } else {
    const diagnostic = isNonEmptyString(result.stderr) ? result.stderr : result.stdout
    detail = `dsh plugin exited with code ${result.code ?? 'null'}${result.signal ? ` (${result.signal})` : ''}${diagnostic ? `: ${shortText(diagnostic, 600)}` : ''}`
  }
  return {
    ok: result.ok,
    detail,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    timedOut: result.timedOut,
  }
}
