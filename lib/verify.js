/**
 * Post-apply verification helpers.
 *
 * `dumpProfileConfig` asks the official CLI what a profile actually mounts
 * (`dsh --profile <p> --dump-config`); `verifyManagedBlock` cross-checks the
 * block recorded in `cordis.patch.yml` against the entries the manifest renders
 * right now. Both are read-only and never throw on bad input.
 */
import { hashEntries, extractManagedBlock } from './render.js'
import { isNonEmptyString, managedBlockBody, parseYaml, runProcess, shortText } from './util.js'

/**
 * Run `dsh --profile <profile> --dump-config` and return its stdout.
 *
 * @param {{ dshBin?: string, profile?: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, text: string, error: string | null }>}
 */
export async function dumpProfileConfig({ dshBin, profile, timeoutMs = 60_000 } = {}) {
  if (!isNonEmptyString(dshBin)) return { ok: false, text: '', error: 'the dsh CLI path is required' }
  if (!isNonEmptyString(profile)) return { ok: false, text: '', error: 'a profile name is required' }
  const bin = dshBin.trim()
  const args = ['--profile', profile.trim(), '--dump-config']
  const runnable = /\.(?:mjs|cjs|js)$/i.test(bin) ? process.execPath : bin
  const argv = /\.(?:mjs|cjs|js)$/i.test(bin) ? [bin, ...args] : args
  const result = await runProcess({ command: runnable, args: argv, timeoutMs })
  const text = result.stdout
  if (result.error) {
    return { ok: false, text, error: `cannot run ${bin}: ${shortText(result.error.message ?? result.error, 400)}` }
  }
  if (result.timedOut) return { ok: false, text, error: `timed out after ${timeoutMs}ms` }
  if (result.code !== 0) {
    const diagnostic = isNonEmptyString(result.stderr) ? result.stderr : result.stdout
    return {
      ok: false,
      text,
      error: `dsh --dump-config exited with code ${result.code ?? 'null'}${diagnostic ? `: ${shortText(diagnostic, 600)}` : ''}`,
    }
  }
  if (text.trim() === '') return { ok: false, text, error: 'dsh --dump-config printed nothing' }
  return { ok: true, text, error: null }
}

/** Count managed-block header lines in a patch document. */
function countBlockHeaders(patchText) {
  let count = 0
  for (const line of patchText.split('\n')) {
    if (/^# >>> dsh-fleet\b/.test(line)) count += 1
  }
  return count
}

/**
 * Check that the managed block is complete, internally consistent, and equal to
 * the entries the manifest renders now.
 *
 * @param {{ entries?: object[], patchText?: string }} options
 * @returns {string[]} warnings; an empty array means the block verifies.
 */
export function verifyManagedBlock({ entries, patchText } = {}) {
  const warnings = []
  const text = typeof patchText === 'string' ? patchText : ''
  const expected = Array.isArray(entries) ? entries : []
  const block = extractManagedBlock(text)
  if (block === null) {
    warnings.push('managed block is missing from the profile patch file')
    return warnings
  }
  if (countBlockHeaders(text) > 1) {
    warnings.push('multiple managed-block headers found; only the first block is rewritten by apply')
  }
  if (block.complete !== true) {
    warnings.push('managed block is incomplete: its closing "# <<< dsh-fleet" line is missing')
  }
  if (block.hash === null) {
    warnings.push('managed block header carries no sha256 digest')
  }
  let parsed
  try {
    parsed = parseYaml(managedBlockBody(block.text))
  } catch (error) {
    warnings.push(`managed block body is not valid YAML: ${shortText(error?.message ?? error, 300)}`)
    return warnings
  }
  if (parsed === null) parsed = []
  if (!Array.isArray(parsed)) {
    warnings.push('managed block body must be a YAML list of entries')
    return warnings
  }
  const actualHash = hashEntries(parsed)
  if (block.hash !== null && block.hash !== actualHash) {
    warnings.push(`managed block hash mismatch: the header records sha256:${block.hash} but its contents hash to ${actualHash}`)
  }
  const expectedHash = hashEntries(expected)
  if (actualHash !== expectedHash) {
    warnings.push('managed block entries differ from the manifest rendering (run plan/apply to refresh)')
  }
  return warnings
}
