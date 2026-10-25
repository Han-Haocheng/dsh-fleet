window.__ModuleLoader__.load({
  id: 'dsh-fleet',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const API = '/api/fleet'

    const DICT = {
      zh: {
        title: '多 Profile 管理',
        subtitle: '一份清单管理 web / TUI / Desktop 的插件、模型接入与配置；范围外的条目不生效。',
        refresh: '刷新',
        plan: '预览变更',
        apply: '应用',
        applyConfirm: '将写入受管块并对账 bundle 选择（缺包会先安装），继续？',
        manifest: '清单',
        lock: '写锁',
        held: '占用中',
        free: '空闲',
        lastApplied: '上次应用',
        never: '从未',
        current: '当前',
        noProfiles: '没有可管理的 profile。',
        manifestErrors: '清单错误',
        loading: '加载中…',
        loadFailed: '加载失败',
        inSync: '已同步',
        drift: '漂移',
        missing: '缺包',
        outOfScope: '范围外',
        unknown: '未知',
        error: '错误',
        pending: '待应用',
        item: '条目',
        scope: '范围',
        saveScope: '保存范围',
        cancel: '取消',
        editScope: '改范围',
        changes: '待应用的变更',
        noChanges: '没有待应用的变更。',
        installs: '待安装',
        appliedTitle: '应用结果',
        applied: '已写入',
        backups: '备份',
        restart: '需重启',
        applyFailed: '应用失败',
        scopeFailed: '保存范围失败',
        planFailed: '预览失败',
        outOfScopeHint: '范围外的条目不写入、不安装；只有 enforce 条目会被强制关闭。',
        tabBundles: '插件包',
        tabProviders: '模型接入',
        tabItems: '配置行',
        searchPlaceholder: '按名称或标识筛选…',
        filterProblems: '只看问题',
        noMatches: '没有匹配的条目。',
        emptyKind: '这一类还没有条目。',
        all: '全部',
        problems: '问题',
        scopeEditorHint: '勾选后，该条目会写入对应 profile；取消勾选则跳过写入。',
        pendingInstallsCount: '待安装',
      },
      en: {
        title: 'Profiles',
        subtitle: 'One manifest for plugins, model providers and config across web / TUI / Desktop; out-of-scope entries do not apply.',
        refresh: 'Refresh',
        plan: 'Preview',
        apply: 'Apply',
        applyConfirm: 'This writes managed blocks and reconciles bundle selections (missing packages install first). Continue?',
        manifest: 'Manifest',
        lock: 'Lock',
        held: 'held',
        free: 'free',
        lastApplied: 'Last applied',
        never: 'never',
        current: 'current',
        noProfiles: 'No manageable profile.',
        manifestErrors: 'Manifest errors',
        loading: 'Loading…',
        loadFailed: 'Failed to load',
        inSync: 'in sync',
        drift: 'drift',
        missing: 'missing',
        outOfScope: 'out of scope',
        unknown: 'unknown',
        error: 'error',
        pending: 'pending',
        item: 'Entry',
        scope: 'Scope',
        saveScope: 'Save',
        cancel: 'Cancel',
        editScope: 'Edit scope',
        changes: 'Pending changes',
        noChanges: 'Nothing to apply; in sync.',
        installs: 'Pending installs',
        appliedTitle: 'Apply result',
        applied: 'Written',
        backups: 'Backups',
        restart: 'Restart required',
        applyFailed: 'Apply failed',
        scopeFailed: 'Saving scope failed',
        planFailed: 'Preview failed',
        outOfScopeHint: 'Out-of-scope entries are neither written nor installed; only enforce entries are forced off.',
        tabBundles: 'Bundles',
        tabProviders: 'Model providers',
        tabItems: 'Config rows',
        searchPlaceholder: 'Filter by name or spec…',
        filterProblems: 'Problems only',
        noMatches: 'No matching entries.',
        emptyKind: 'Nothing in this category yet.',
        all: 'all',
        problems: 'problems',
        scopeEditorHint: 'Checked profiles receive this entry; unchecked profiles are skipped.',
        pendingInstallsCount: 'installs',
      },
    }

    const TONE = {
      'in-sync': { bg: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.12))', fg: 'var(--dsw-alias-text-2, #757575)' },
      drift: { bg: 'rgba(230, 160, 40, 0.16)', fg: '#a86b16' },
      missing: { bg: 'rgba(220, 80, 80, 0.14)', fg: '#b43c3c' },
      'out-of-scope': { bg: 'rgba(127,127,127,0.07)', fg: 'var(--dsw-alias-text-3, #9e9e9e)' },
      unknown: { bg: 'rgba(127,127,127,0.07)', fg: 'var(--dsw-alias-text-3, #9e9e9e)' },
      error: { bg: 'rgba(220, 80, 80, 0.16)', fg: '#b43c3c' },
      pending: { bg: 'rgba(90, 130, 220, 0.14)', fg: '#4568ad' },
    }

    const STATUS_KEY = {
      'in-sync': 'inSync',
      drift: 'drift',
      missing: 'missing',
      'out-of-scope': 'outOfScope',
      unknown: 'unknown',
      error: 'error',
      pending: 'pending',
    }

    const PROBLEM = new Set(['drift', 'missing', 'error'])

    async function request(path, init) {
      const response = await fetch(API + path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = { ok: false, errors: [`HTTP ${response.status}`] }
      }
      if (payload === null || typeof payload !== 'object') {
        payload = { ok: false, errors: [`HTTP ${response.status}`] }
      }
      return payload
    }

    function chip(t, status) {
      const tone = TONE[status] ?? TONE.unknown
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 8px',
            borderRadius: 999,
            fontSize: 12,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
            background: tone.bg,
            color: tone.fg,
          },
        },
        t(STATUS_KEY[status] ?? 'unknown'),
      )
    }

    function makePage(t) {
      return function FleetPage() {
        const [state, setState] = useState(null)
        const [error, setError] = useState(null)
        const [busy, setBusy] = useState(null)
        const [tab, setTab] = useState('items')
        const [query, setQuery] = useState('')
        const [problemOnly, setProblemOnly] = useState(false)
        const [plan, setPlan] = useState(null)
        const [applyResult, setApplyResult] = useState(null)
        const [editing, setEditing] = useState(null)
        const [scopeDraft, setScopeDraft] = useState(null)
        const [toast, setToast] = useState(null)

        const load = useCallback(async () => {
          setError(null)
          try {
            const payload = await request('/state')
            setState(payload)
            if (payload.ok === false && payload.items === undefined) {
              setError((payload.errors ?? []).join('\n') || 'state unavailable')
            }
          } catch (reason) {
            setError(String(reason))
          }
        }, [])

        useEffect(() => {
          load()
        }, [load])

        const profiles = state?.profiles ?? []
        const entries = state?.items ?? []
        const manifestErrors = state?.manifestErrors ?? []

        const runPlan = useCallback(async () => {
          setBusy('plan')
          setToast(null)
          try {
            const payload = await request('/plan', { method: 'POST', body: '{}' })
            setPlan(payload)
            if (payload.ok === false) {
              setToast({ kind: 'error', text: (payload.errors ?? []).join('\n') || t('planFailed') })
            }
          } catch (reason) {
            setToast({ kind: 'error', text: String(reason) })
          } finally {
            setBusy(null)
          }
        }, [])

        const runApply = useCallback(async () => {
          if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('applyConfirm'))) {
            return
          }
          setBusy('apply')
          setToast(null)
          try {
            const payload = await request('/apply', { method: 'POST', body: '{}' })
            setApplyResult(payload)
            if (payload.ok) {
              setToast({ kind: 'ok', text: `${t('applied')}: ${payload.applied?.length ?? 0}` })
              await load()
            } else {
              setToast({ kind: 'error', text: (payload.errors ?? []).join('\n') || t('applyFailed') })
            }
          } catch (reason) {
            setToast({ kind: 'error', text: String(reason) })
          } finally {
            setBusy(null)
          }
        }, [load])

        const startEdit = useCallback(
          (entry) => {
            setEditing(entry.key)
            const draft = {}
            for (const profile of profiles) draft[profile.name] = entry.scope.includes(profile.name)
            setScopeDraft(draft)
          },
          [profiles],
        )

        const cancelEdit = useCallback(() => {
          setEditing(null)
          setScopeDraft(null)
        }, [])

        const saveScope = useCallback(async () => {
          if (!editing || !scopeDraft) return
          const scope = Object.entries(scopeDraft)
            .filter(([, enabled]) => enabled)
            .map(([name]) => name)
          setBusy(`scope:${editing}`)
          try {
            const payload = await request('/scope', {
              method: 'POST',
              body: JSON.stringify({ key: editing, scope }),
            })
            if (payload.ok) {
              setEditing(null)
              setScopeDraft(null)
              if (payload.state) setState(payload.state)
              else await load()
            } else {
              setToast({ kind: 'error', text: (payload.errors ?? []).join('\n') || t('scopeFailed') })
            }
          } catch (reason) {
            setToast({ kind: 'error', text: String(reason) })
          } finally {
            setBusy(null)
          }
        }, [editing, scopeDraft, load])

        const kindEntries = (kind) => entries.filter((entry) => entry.kind === kind)
        const counts = {
          bundles: kindEntries('bundle').length,
          providers: kindEntries('provider').length,
          items: kindEntries('item').length,
        }
        const tabKind = { bundles: 'bundle', providers: 'provider', items: 'item' }[tab]
        const active = entries.filter((entry) => entry.kind === tabKind)
        const lowered = query.trim().toLowerCase()
        const visible = active.filter((entry) => {
          if (lowered !== '' && !`${entry.label} ${entry.spec ?? ''}`.toLowerCase().includes(lowered)) return false
          if (!problemOnly) return true
          return profiles.some((profile) => PROBLEM.has(entry.status?.[profile.name]))
        })

        const profileSummary = (profile) => {
          const statuses = entries.map((entry) => entry.status?.[profile.name])
          const problems = statuses.filter((status) => PROBLEM.has(status)).length
          const missing = statuses.filter((status) => status === 'missing').length
          return {
            tone: problems === 0 ? 'in-sync' : missing > 0 ? 'missing' : 'drift',
            problems,
            label: problems === 0 ? t('inSync') : `${problems} ${t('problems')}`,
          }
        }

        const buttonStyle = (disabled) => ({
          appearance: 'none',
          border: '1px solid var(--dsw-alias-border-1, rgba(127,127,127,0.32))',
          background: 'var(--dsw-alias-bg-layer-1, transparent)',
          color: 'inherit',
          borderRadius: 8,
          padding: '5px 12px',
          fontSize: 13,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        })

        const primaryButton = {
          ...buttonStyle(false),
          borderColor: 'var(--dsw-alias-accent-1, #4c6fb8)',
          color: 'var(--dsw-alias-accent-1, #4c6fb8)',
          fontWeight: 600,
        }

        const cardStyle = {
          border: '1px solid var(--dsw-alias-border-1, rgba(127,127,127,0.18))',
          borderRadius: 12,
          padding: 14,
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.035))',
        }

        const header = h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between' } },
          h(
            'div',
            null,
            h('h2', { style: { margin: 0, fontSize: 18, lineHeight: '26px' } }, t('title')),
            h('p', { style: { margin: '4px 0 0', fontSize: 13, opacity: 0.72, maxWidth: 560 } }, t('subtitle')),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { style: buttonStyle(Boolean(busy)), disabled: Boolean(busy), onClick: load }, t('refresh')),
            h('button', { style: buttonStyle(Boolean(busy)), disabled: Boolean(busy), onClick: runPlan }, busy === 'plan' ? '…' : t('plan')),
            h('button', { style: primaryButton, disabled: Boolean(busy), onClick: runApply }, busy === 'apply' ? '…' : t('apply')),
          ),
        )

        const metaBar = h(
          'div',
          {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px 16px',
              fontSize: 12,
              opacity: 0.78,
              marginTop: 10,
              lineHeight: '18px',
            },
          },
          h('span', null, `${t('manifest')}: ${state?.manifestPath ?? '—'}`),
          h('span', null, `${t('current')}: ${state?.currentProfile ?? '—'}`),
          h('span', null, `${t('lock')}: ${state?.lock?.held ? `${t('held')} (${state.lock.owner})` : t('free')}`),
          h('span', null, `${t('lastApplied')}: ${state?.lastApplied ?? t('never')}`),
        )

        const profileCards =
          profiles.length === 0
            ? h('div', { style: { marginTop: 12, opacity: 0.7, fontSize: 13 } }, t('noProfiles'))
            : h(
                'div',
                {
                  style: {
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                    gap: 10,
                    marginTop: 12,
                  },
                },
                profiles.map((profile) => {
                  const summary = profileSummary(profile)
                  const isCurrent = profile.name === state?.currentProfile
                  return h(
                    'div',
                    {
                      key: profile.name,
                      style: {
                        ...cardStyle,
                        padding: '10px 12px',
                        borderColor: isCurrent
                          ? 'var(--dsw-alias-accent-1, #4c6fb8)'
                          : 'var(--dsw-alias-border-1, rgba(127,127,127,0.18))',
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                      h('div', { style: { fontWeight: 600, fontSize: 13 } }, profile.name),
                      isCurrent ? h('span', { style: { fontSize: 11, opacity: 0.7 } }, t('current')) : null,
                    ),
                    h(
                      'div',
                      { style: { marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
                      chip(t, summary.tone),
                      profile.pendingChanges > 0
                        ? h('span', { style: { fontSize: 12, color: '#a86b16' } }, `${profile.pendingChanges} ${t('pending')}`)
                        : null,
                    ),
                  )
                }),
              )

        const toolbar = h(
          'div',
          {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 16,
            },
          },
          h(
            'div',
            {
              style: {
                display: 'inline-flex',
                gap: 4,
                padding: 3,
                borderRadius: 10,
                background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.09))',
              },
            },
            [
              ['bundles', t('tabBundles')],
              ['providers', t('tabProviders')],
              ['items', t('tabItems')],
            ].map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  onClick: () => setTab(key),
                  style: {
                    appearance: 'none',
                    border: 'none',
                    borderRadius: 8,
                    padding: '5px 12px',
                    fontSize: 13,
                    cursor: 'pointer',
                    background: tab === key ? 'var(--dsw-alias-bg-layer-1, #fff)' : 'transparent',
                    color: 'inherit',
                    fontWeight: tab === key ? 600 : 400,
                    boxShadow: tab === key ? '0 1px 2px rgba(0,0,0,0.12)' : 'none',
                  },
                },
                `${label} ${counts[key] ?? 0}`,
              ),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              value: query,
              placeholder: t('searchPlaceholder'),
              onChange: (event) => setQuery(event.target.value),
              style: {
                width: 200,
                padding: '5px 10px',
                borderRadius: 8,
                fontSize: 13,
                border: '1px solid var(--dsw-alias-border-1, rgba(127,127,127,0.32))',
                background: 'var(--dsw-alias-bg-layer-1, transparent)',
                color: 'inherit',
              },
            }),
            h(
              'label',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.85 } },
              h('input', { type: 'checkbox', checked: problemOnly, onChange: () => setProblemOnly((value) => !value) }),
              t('filterProblems'),
            ),
          ),
        )

        const headCell = {
          textAlign: 'left',
          padding: '7px 10px',
          fontSize: 12,
          fontWeight: 600,
          opacity: 0.65,
          whiteSpace: 'nowrap',
          borderBottom: '1px solid var(--dsw-alias-border-1, rgba(127,127,127,0.18))',
        }
        const cell = { padding: '8px 10px', verticalAlign: 'top' }
        const smallButton = (onClick, label) =>
          h(
            'button',
            {
              onClick,
              style: { ...buttonStyle(false), padding: '2px 8px', fontSize: 12, whiteSpace: 'nowrap' },
            },
            label,
          )

        function rowFor(entry) {
          const editingThis = editing === entry.key
          const main = h(
            'tr',
            { key: entry.key },
            h(
              'td',
              { style: { ...cell, minWidth: 220, maxWidth: 380 } },
              h('div', { style: { fontWeight: 500, fontSize: 13 } }, entry.label),
              entry.spec ? h('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 1 } }, entry.spec) : null,
            ),
            profiles.map((profile) =>
              h(
                'td',
                { key: profile.name, style: { ...cell, textAlign: 'center', whiteSpace: 'nowrap' } },
                chip(t, entry.status?.[profile.name]),
              ),
            ),
            h(
              'td',
              { style: { ...cell, whiteSpace: 'nowrap', textAlign: 'right' } },
              h(
                'span',
                { style: { fontSize: 12, opacity: 0.7, marginRight: 8 } },
                entry.scope.length === profiles.length ? t('all') : entry.scope.join(', '),
              ),
              smallButton(() => (editingThis ? cancelEdit() : startEdit(entry)), editingThis ? t('cancel') : t('editScope')),
            ),
          )
          if (!editingThis) return main
          const editor = h(
            'tr',
            { key: `${entry.key}:scope` },
            h(
              'td',
              {
                colSpan: profiles.length + 2,
                style: {
                  padding: '10px 12px',
                  background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.045))',
                  borderBottom: '1px solid var(--dsw-alias-border-1, rgba(127,127,127,0.12))',
                },
              },
              h('div', { style: { fontSize: 12, opacity: 0.72, marginBottom: 8 } }, t('scopeEditorHint')),
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' } },
                ...profiles.map((profile) =>
                  h(
                    'label',
                    { key: profile.name, style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 } },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(scopeDraft?.[profile.name]),
                      onChange: () =>
                        setScopeDraft((draft) => ({ ...(draft ?? {}), [profile.name]: !draft?.[profile.name] })),
                    }),
                    profile.name,
                    chip(t, entry.status?.[profile.name]),
                  ),
                ),
                h(
                  'button',
                  { style: buttonStyle(Boolean(busy)), disabled: Boolean(busy), onClick: saveScope },
                  busy === `scope:${entry.key}` ? '…' : t('saveScope'),
                ),
              ),
            ),
          )
          return [main, editor]
        }

        const table =
          visible.length === 0
            ? h(
                'div',
                { style: { ...cardStyle, marginTop: 10, textAlign: 'center', opacity: 0.7, fontSize: 13 } },
                active.length === 0 ? t('emptyKind') : t('noMatches'),
              )
            : h(
                'div',
                { style: { ...cardStyle, marginTop: 10, padding: 0, overflowX: 'auto' } },
                h(
                  'table',
                  { style: { borderCollapse: 'collapse', width: '100%', fontSize: 13 } },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', { style: headCell }, t('item')),
                      ...profiles.map((profile) =>
                        h('th', { key: profile.name, style: { ...headCell, textAlign: 'center' } }, profile.name),
                      ),
                      h('th', { style: { ...headCell, textAlign: 'right' } }, t('scope')),
                    ),
                  ),
                  h('tbody', null, visible.flatMap((entry) => rowFor(entry))),
                ),
              )

        const errorsBlock =
          manifestErrors.length > 0
            ? h(
                'div',
                {
                  style: {
                    marginTop: 12,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: 'rgba(220, 80, 80, 0.1)',
                    color: '#b43c3c',
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                  },
                },
                `${t('manifestErrors')}:\n${manifestErrors.join('\n')}`,
              )
            : null

        const toastBlock =
          toast === null
            ? null
            : h(
                'div',
                {
                  style: {
                    marginTop: 10,
                    padding: '9px 12px',
                    borderRadius: 8,
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    background: toast.kind === 'ok' ? 'rgba(80, 160, 110, 0.12)' : 'rgba(220, 80, 80, 0.1)',
                    color: toast.kind === 'ok' ? '#3f8a5c' : '#b43c3c',
                  },
                },
                toast.text,
              )

        const planBlock =
          plan === null
            ? null
            : h(
                'div',
                { style: { ...cardStyle, marginTop: 14, fontSize: 12 } },
                h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, t('changes')),
                plan.errors?.length
                  ? h('div', { style: { color: '#b43c3c', whiteSpace: 'pre-wrap' } }, plan.errors.join('\n'))
                  : plan.changes?.length === 0
                    ? h('div', { style: { opacity: 0.7 } }, t('noChanges'))
                    : h(
                        'ul',
                        { style: { margin: 0, paddingLeft: 18, lineHeight: '20px' } },
                        plan.changes.map((change, index) => h('li', { key: index }, `[${change.profile}] ${change.detail}`)),
                      ),
                plan.pendingInstalls?.length
                  ? h(
                      'div',
                      { style: { marginTop: 8 } },
                      `${t('installs')} (${plan.pendingInstalls.length})`,
                      h(
                        'ul',
                        { style: { margin: '2px 0 0', paddingLeft: 18, lineHeight: '20px' } },
                        plan.pendingInstalls.map((install, index) =>
                          h(
                            'li',
                            { key: index },
                            `[${install.profile}] ${install.spec}${install.capability === 'manual' ? ' (manual)' : ''}`,
                          ),
                        ),
                      ),
                    )
                  : null,
              )

        const resultBlock =
          applyResult === null
            ? null
            : h(
                'div',
                { style: { ...cardStyle, marginTop: 14, fontSize: 12 } },
                h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, t('appliedTitle')),
                applyResult.ok
                  ? h('div', null, `${t('applied')}: ${applyResult.applied?.length ?? 0}`)
                  : h('div', { style: { color: '#b43c3c', whiteSpace: 'pre-wrap' } }, (applyResult.errors ?? []).join('\n')),
                applyResult.backups?.length
                  ? h('div', { style: { opacity: 0.7, marginTop: 2 } }, `${t('backups')}: ${applyResult.backups.length}`)
                  : null,
                applyResult.restartRequired?.length
                  ? h('div', { style: { color: '#a86b16', marginTop: 2 } }, `${t('restart')}: ${applyResult.restartRequired.join(', ')}`)
                  : null,
              )

        if (state === null) {
          return h(
            'div',
            { style: { padding: '10px 4px 32px' } },
            header,
            h(
              'div',
              { style: { marginTop: 24, opacity: 0.7, fontSize: 13 } },
              error !== null ? `${t('loadFailed')}: ${error}` : t('loading'),
            ),
          )
        }

        return h(
          'div',
          { style: { padding: '10px 4px 32px' } },
          header,
          metaBar,
          errorsBlock,
          toastBlock,
          profileCards,
          toolbar,
          table,
          planBlock,
          resultBlock,
          h('div', { style: { marginTop: 12, fontSize: 11, opacity: 0.55 } }, t('outOfScopeHint')),
        )
      }
    }

    return {
      inject: ['locale', 'slots'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('dsh-fleet', DICT), 'dsh-fleet: locale')
        const t = ctx.locale.bind('dsh-fleet')
        const Page = makePage(t)
        ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'fleet',
                order: 18,
                label: () => t('title'),
              },
              Page,
            )
          } catch {
            return () => {}
          }
        })
      },
    }
  },
})
