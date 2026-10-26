/**
 * Drift summary for the "you forgot to apply" reminder.
 *
 * dsh-fleet has no watcher: a manifest edit only reaches a profile when `apply`
 * runs. The startup check therefore reports the same pending changes `plan`
 * would, in a shape small enough for a status line, a log line, and the
 * `fleet status` payload.
 */

/**
 * Count pending changes per profile, optionally narrowed to one profile.
 *
 * @param {object|null|undefined} plan - `buildPlan()` result (`{ changes: [...] }`).
 * @param {string} [profile] - only count this profile's changes.
 * @returns {{ pending: number, byProfile: Record<string, number> }}
 *          `byProfile` lists only profiles that actually have pending changes.
 */
export function summarizeDrift(plan, profile) {
  const changes = Array.isArray(plan?.changes) ? plan.changes : []
  const scoped =
    typeof profile === 'string' && profile !== ''
      ? changes.filter((change) => change?.profile === profile)
      : changes
  const byProfile = {}
  for (const change of scoped) {
    const key = typeof change?.profile === 'string' && change.profile !== '' ? change.profile : 'unknown'
    byProfile[key] = (byProfile[key] ?? 0) + 1
  }
  return { pending: scoped.length, byProfile }
}

/**
 * One-line status text for a drift summary, or undefined when in sync.
 * Kept beside the summary so the log line, the TUI footer and tests agree.
 *
 * @param {{ pending: number }} drift
 * @returns {string|undefined}
 */
export function driftBadge(drift) {
  const pending = typeof drift?.pending === 'number' ? drift.pending : 0
  if (pending <= 0) return undefined
  return `fleet: ${pending} 待应用`
}
