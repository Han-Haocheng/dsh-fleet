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
        doctor: '诊断',
        doctorOk: '没有阻断问题',
        doctorProblems: '发现问题',
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
        outdated: '版本不一致',
        unmanagedTitle: '未纳管插件',
        unmanagedHint: '这些插件已在 profile 中启用，但不在清单里；纳入后才会参与同步与版本管理。',
        adopt: '纳入清单',
        adopted: '已纳入清单',
        adoptFailed: '纳入失败',
        coreBundle: '随 DSH 提供',
        profilesLabel: 'profile',
        drift: '漂移',
        missing: '缺包',
        outOfScope: '范围外',
        unknown: '未知',
        error: '错误',
        pending: '待应用',
        item: '条目',
        scope: '范围',
        saveScope: '保存范围',
        actions: '操作',
        save: '保存',
        saveAll: '保存全部',
        discard: '放弃修改',
        unsaved: '项未保存',
        unsavedLeave: '有未保存的范围修改，确定离开？',
        rollback: '回滚上次应用',
        rollbackConfirm: '回滚会用最近一次备份覆盖 package.json 与 cordis.patch.yml，继续？',
        restored: '已回滚到最近备份',
        restoreFailed: '回滚失败',
        backupAvailable: '可回滚备份',
        saved: '范围已保存；点「应用」写入对应 profile。',
        inScope: '在范围内',
        notInScope: '不在范围',
        scopeCellHint: '每列勾选框即该条目是否写入该 profile；改完点行尾「保存」。',
        emptyScope: '至少要保留一个 profile；要彻底停用请从清单删除该条目。',
        identifierLabel: '标识',
        fullNameLabel: '全名',
        versionLabel: '版本',
        specLabel: '安装 spec',
        providesLabel: '提供',
        pruneLabel: '卸载时清理依赖',
        apiLabel: 'API',
        baseUrlLabel: 'Base URL',
        modelsLabel: '模型数',
        apiKeyEnvLabel: '密钥环境变量',
        configKeysLabel: '配置键',
        requiresLabel: '依赖行',
        scopeLabel: '范围',
        scopeAll: '全部 profile',
        descBundle: '插件包：安装该包，并把它加入范围内 profile 的 dsh.profile.bundles。',
        descProvider: '模型接入：通过 llm-pi-ai 行把 provider 配置注入范围内 profile。',
        descItem: '配置行：写入范围内 profile 受管块的一条 loader 配置。',
        detailDrift: '与清单不一致：点「应用」按清单重写；或取消勾选，保留该 profile 的本地配置。',
        detailOutdated: '版本不一致：已装 {installed}，清单要求 {expected}；点「应用」会升级。',
        detailMissing: '该包尚未安装：点「应用」会先安装再选中。',
        detailUnknown: '读不到该 profile 的状态（目录不存在或读取失败）；先启动一次该 profile。',
        detailError: '状态读取出错：查看清单错误或 fleet.reject.log。',
        providerCarrier: 'provider 通过 llm-pi-ai 行落地；该行不在这个 profile 的范围，所以保留本地 provider 配置。',
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
        doctor: 'Diagnose',
        doctorOk: 'no blocking problems',
        doctorProblems: 'problems found',
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
        outdated: 'version differs',
        unmanagedTitle: 'Unmanaged bundles',
        unmanagedHint: 'These bundles are enabled in a profile but not in the manifest; adopt one to manage it here.',
        adopt: 'Adopt',
        adopted: 'Adopted into the manifest',
        adoptFailed: 'Adopt failed',
        coreBundle: 'ships with DSH',
        profilesLabel: 'profiles',
        drift: 'drift',
        missing: 'missing',
        outOfScope: 'out of scope',
        unknown: 'unknown',
        error: 'error',
        pending: 'pending',
        item: 'Entry',
        scope: 'Scope',
        saveScope: 'Save',
        actions: 'Actions',
        save: 'Save',
        saveAll: 'Save all',
        discard: 'Discard',
        unsaved: 'unsaved',
        unsavedLeave: 'You have unsaved scope changes. Leave anyway?',
        rollback: 'Roll back last apply',
        rollbackConfirm: 'Rolling back overwrites package.json and cordis.patch.yml with the newest backups. Continue?',
        restored: 'Rolled back to the newest backups',
        restoreFailed: 'Rollback failed',
        backupAvailable: 'Restorable backups',
        saved: 'Scope saved; click Apply to write it to the profiles.',
        inScope: 'in scope',
        notInScope: 'not in scope',
        scopeCellHint: 'Each checkbox sets whether this entry is written to that profile; click Save in the row after editing.',
        emptyScope: 'Keep at least one profile; delete the entry from the manifest to disable it everywhere.',
        identifierLabel: 'Key',
        fullNameLabel: 'Full name',
        versionLabel: 'Version',
        specLabel: 'Spec',
        providesLabel: 'Provides',
        pruneLabel: 'Prune on uninstall',
        apiLabel: 'API',
        baseUrlLabel: 'Base URL',
        modelsLabel: 'Models',
        apiKeyEnvLabel: 'API key env',
        configKeysLabel: 'Config keys',
        requiresLabel: 'Requires',
        scopeLabel: 'Scope',
        scopeAll: 'all profiles',
        descBundle: 'Bundle: installs the package and adds it to dsh.profile.bundles in scope.',
        descProvider: 'Model provider: injects this provider config through the llm-pi-ai row.',
        descItem: 'Config row: writes one loader entry into the managed block.',
        detailDrift: 'Differs from the manifest: click Apply to rewrite it, or uncheck to keep this profile\'s local config.',
        detailOutdated: 'Version differs: installed {installed}, manifest wants {expected}; Apply upgrades it.',
        detailMissing: 'Not installed yet: Apply installs it before selecting the bundle.',
        detailUnknown: 'Profile state is unreadable (missing directory or read failure); start that profile once.',
        detailError: 'Status read failed: check manifest errors or fleet.reject.log.',
        providerCarrier: 'Providers land through the llm-pi-ai row; that row is out of scope here, so the local provider config is kept.',
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
      outdated: { bg: 'rgba(230, 160, 40, 0.16)', fg: '#a86b16' },
      missing: { bg: 'rgba(220, 80, 80, 0.14)', fg: '#b43c3c' },
      'out-of-scope': { bg: 'rgba(127,127,127,0.07)', fg: 'var(--dsw-alias-text-3, #9e9e9e)' },
      unknown: { bg: 'rgba(127,127,127,0.07)', fg: 'var(--dsw-alias-text-3, #9e9e9e)' },
      error: { bg: 'rgba(220, 80, 80, 0.16)', fg: '#b43c3c' },
      pending: { bg: 'rgba(90, 130, 220, 0.14)', fg: '#4568ad' },
    }

    const STATUS_KEY = {
      'in-sync': 'inSync',
      drift: 'drift',
      outdated: 'outdated',
      missing: 'missing',
      'out-of-scope': 'outOfScope',
      unknown: 'unknown',
      error: 'error',
      pending: 'pending',
    }

    const PROBLEM = new Set(['drift', 'outdated', 'missing', 'unknown', 'error'])

    const KIND_LABEL = { bundle: 'tabBundles', provider: 'tabProviders', item: 'tabItems' }

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
        const [doctor, setDoctor] = useState(null)
        const [drafts, setDrafts] = useState({})
        const dirtyCount = Object.keys(drafts).length
        useEffect(() => {
          if (dirtyCount === 0) return undefined
          if (typeof window.addEventListener !== 'function') return undefined
          const guard = (event) => {
            event.preventDefault()
            event.returnValue = ''
            return ''
          }
          window.addEventListener('beforeunload', guard)
          return () => window.removeEventListener('beforeunload', guard)
        }, [dirtyCount])
        const [tip, setTip] = useState(null)
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

        // The host stores the all-profiles case as ['all'].
        const expandedScope = (entry) =>
          entry.scope.includes('all') ? profiles.map((profile) => profile.name) : entry.scope

        const scopeOf = (entry) => drafts[entry.key] ?? expandedScope(entry)

        const showTip = (event, entry) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const width = 352
          const gap = 10
          const viewportWidth = typeof window === 'undefined' ? rect.right + gap + width : window.innerWidth
          const viewportHeight = typeof window === 'undefined' ? rect.top + 420 : window.innerHeight
          const left = rect.right + gap + width <= viewportWidth ? rect.right + gap : Math.max(8, rect.left - width - gap)
          const top = Math.min(Math.max(8, rect.top), Math.max(8, viewportHeight - 400))
          setTip({ key: entry.key, left, top })
        }

        const toggleScope = (entry, profileName) => {
          setDrafts((current) => {
            const base = current[entry.key] ?? expandedScope(entry)
            const next = base.includes(profileName)
              ? base.filter((name) => name !== profileName)
              : [...base, profileName]
            const ordered = profiles.map((profile) => profile.name).filter((name) => next.includes(name))
            return { ...current, [entry.key]: ordered }
          })
        }

        const isDirty = (entry) => {
          const draft = drafts[entry.key]
          if (draft === undefined) return false
          const base = expandedScope(entry)
          return draft.length !== base.length || draft.some((name) => !base.includes(name))
        }

        const saveRowScope = async (entry) => {
          const scope = drafts[entry.key] ?? expandedScope(entry)
          if (scope.length === 0) {
            setToast({ kind: 'error', text: t('emptyScope') })
            return
          }
          setBusy(`scope:${entry.key}`)
          try {
            const payload = await request('/scope', {
              method: 'POST',
              body: JSON.stringify({ key: entry.key, scope }),
            })
            if (payload.ok) {
              setDrafts((current) => {
                const next = { ...current }
                delete next[entry.key]
                return next
              })
              if (payload.state) setState(payload.state)
              else await load()
              setToast({ kind: 'ok', text: t('saved') })
            } else {
              setToast({ kind: 'error', text: (payload.errors ?? []).join('\n') || t('scopeFailed') })
            }
          } catch (reason) {
            setToast({ kind: 'error', text: String(reason) })
          } finally {
            setBusy(null)
          }
        }

        const adoptBundle = async (entry) => {
          setBusy(`adopt:${entry.name}`)
          try {
            const payload = await request('/adopt', {
              method: 'POST',
              body: JSON.stringify({ name: entry.name }),
            })
            if (payload.ok) {
              if (payload.state) setState(payload.state)
              setToast({ kind: 'ok', text: t('adopted') })
            } else {
              setToast({ kind: 'error', text: (payload.errors ?? []).join('\n') || t('adoptFailed') })
            }
          } catch (reason) {
            setToast({ kind: 'error', text: String(reason) })
          } finally {
            setBusy(null)
          }
        }

        const saveAllScopes = async () => {
          const pending = entries.filter((entry) => Object.prototype.hasOwnProperty.call(drafts, entry.key))
          if (pending.length === 0) return
          setBusy('scope:all')
          const failures = []
          for (const entry of pending) {
            const scope = drafts[entry.key] ?? expandedScope(entry)
            if (scope.length === 0) {
              failures.push(`${entry.label}: ${t('emptyScope')}`)
              continue
            }
            try {
              const payload = await request('/scope', {
                method: 'POST',
                body: JSON.stringify({ key: entry.key, scope }),
              })
              if (!payload.ok) {
                failures.push(`${entry.label}: ${(payload.errors ?? []).join('; ')}`)
                continue
              }
              setDrafts((current) => {
                const next = { ...current }
                delete next[entry.key]
                return next
              })
              if (payload.state) setState(payload.state)
            } catch (reason) {
              failures.push(`${entry.label}: ${String(reason)}`)
            }
          }
          setBusy(null)
          setToast(
            failures.length > 0
              ? { kind: 'error', text: failures.join('\n') }
              : { kind: 'ok', text: t('saved') },
          )
        }

        const runDoctor = async () => {
          setBusy('doctor')
          try {
            const payload = await request('/doctor')
            setDoctor(payload)
          } catch (reason) {
            setToast({ kind: 'error', text: String(reason) })
          } finally {
            setBusy(null)
          }
        }

        const restoreLast = async () => {
          if (typeof window.confirm === 'function' && !window.confirm(t('rollbackConfirm'))) return
          setBusy('restore')
          try {
            const payload = await request('/restore', { method: 'POST', body: '{}' })
            if (payload.ok) {
              if (payload.state) setState(payload.state)
              setToast({ kind: 'ok', text: t('restored') })
            } else {
              setToast({ kind: 'error', text: (payload.errors ?? []).join('\n') || t('restoreFailed') })
            }
          } catch (reason) {
            setToast({ kind: 'error', text: String(reason) })
          } finally {
            setBusy(null)
          }
        }

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
          if (
            lowered !== '' &&
            !`${entry.title ?? ''} ${entry.label} ${entry.spec ?? ''}`.toLowerCase().includes(lowered)
          ) {
            return false
          }
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
            h('button', { style: buttonStyle(Boolean(busy)), disabled: Boolean(busy), onClick: runDoctor }, busy === 'doctor' ? '…' : t('doctor')),
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

        const ENTRY_COL_WIDTH = 210
        const ACTIONS_COL_WIDTH = 88

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
        const smallButton = (onClick, label, disabled = false) =>
          h(
            'button',
            {
              onClick,
              disabled,
              style: { ...buttonStyle(disabled), padding: '2px 8px', fontSize: 12, whiteSpace: 'nowrap' },
            },
            label,
          )

        const dirtyEntries = entries.filter((entry) => Object.prototype.hasOwnProperty.call(drafts, entry.key))
        const dirtyBar =
          dirtyEntries.length === 0
            ? null
            : h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 8,
                    fontSize: 12,
                    color: '#a86b16',
                  },
                },
                h('span', null, `${dirtyEntries.length} ${t('unsaved')}`),
                smallButton(() => saveAllScopes(), busy === 'scope:all' ? '…' : t('saveAll'), Boolean(busy)),
                smallButton(() => setDrafts({}), t('discard'), Boolean(busy)),
              )

        const backups = Array.isArray(state?.backups) ? state.backups : []
        const maintenanceBlock =
          backups.length === 0
            ? null
            : h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 10,
                    fontSize: 12,
                    opacity: 0.85,
                  },
                },
                h('span', null, `${t('backupAvailable')}: ${backups.map((entry) => entry.profile).join(', ')}`),
                smallButton(() => restoreLast(), busy === 'restore' ? '…' : t('rollback'), Boolean(busy)),
              )

        const doctorBlock =
          doctor === null
            ? null
            : h(
                'div',
                { style: { ...cardStyle, marginTop: 10, fontSize: 12 } },
                h(
                  'div',
                  { style: { fontWeight: 600, marginBottom: 4 } },
                  `${t('doctor')} · ${doctor.ok ? t('doctorOk') : t('doctorProblems')}`,
                ),
                ...(doctor.checks ?? []).map((check, index) =>
                  h(
                    'div',
                    { key: index, style: { marginTop: 3, whiteSpace: 'pre-wrap' } },
                    `${check.level === 'error' ? '⛔' : check.level === 'warn' ? '⚠️' : '✅'} ${check.title}: ${check.detail}`,
                  ),
                ),
              )

        function scopeDetail(entry, profileName, status) {
          if (status === 'outdated') {
            const details = entry.details ?? {}
            const installed = details.installedVersions?.[profileName] ?? '?'
            const expected = details.expectedVersion ?? '?'
            return t('detailOutdated').replace('{installed}', installed).replace('{expected}', expected)
          }
          if (status === 'missing') return t('detailMissing')
          if (status === 'drift') return t('detailDrift')
          if (status === 'unknown') return t('detailUnknown')
          if (status === 'error') return t('detailError')
          if (entry.kind === 'provider') {
            const carrier = entries.find((item) => item.key === 'item:llm-pi-ai')
            if (carrier && !expandedScope(carrier).includes(profileName)) return t('providerCarrier')
          }
          return t('notInScope')
        }

        function tipRows(entry) {
          const rows = [[t('identifierLabel'), entry.key]]
          if (entry.title && entry.title !== entry.label) rows.push([t('fullNameLabel'), entry.label])
          if (entry.kind === 'bundle') {
            if (entry.spec) rows.push([t('specLabel'), entry.spec])
            if (entry.details?.version) rows.push([t('versionLabel'), entry.details.version])
            const provides = entry.details?.provides
            if (Array.isArray(provides) && provides.length > 0) rows.push([t('providesLabel'), provides.join(', ')])
            if (entry.details?.prune === true) rows.push([t('pruneLabel'), 'true'])
          } else if (entry.kind === 'provider') {
            const details = entry.details ?? {}
            if (details.displayName) rows.push([t('specLabel'), details.displayName])
            if (details.api) rows.push([t('apiLabel'), details.api])
            if (details.baseURL) rows.push([t('baseUrlLabel'), details.baseURL])
            if (typeof details.models === 'number') rows.push([t('modelsLabel'), String(details.models)])
            if (details.apiKeyEnv) rows.push([t('apiKeyEnvLabel'), details.apiKeyEnv])
          } else {
            const details = entry.details ?? {}
            if (details.name) rows.push([t('specLabel'), details.name])
            if (Array.isArray(details.configKeys) && details.configKeys.length > 0) {
              rows.push([t('configKeysLabel'), details.configKeys.join(', ')])
            }
            if (Array.isArray(details.requires) && details.requires.length > 0) {
              rows.push([t('requiresLabel'), details.requires.join(', ')])
            }
          }
          const scope = expandedScope(entry)
          rows.push([t('scopeLabel'), scope.length === profiles.length ? t('scopeAll') : scope.join(', ')])
          for (const profile of profiles) {
            const status = entry.status?.[profile.name]
            const problem = PROBLEM.has(status)
            const label = t(STATUS_KEY[status] ?? 'unknown')
            rows.push([profile.name, problem ? `⚠️ ${label} — ${scopeDetail(entry, profile.name, status)}` : label])
          }
          return rows.flatMap(([label, value], index) => [
            h('div', { key: `label:${index}`, style: { opacity: 0.55 } }, label),
            h('div', { key: `value:${index}`, style: { wordBreak: 'break-word' } }, value),
          ])
        }

        function rowFor(entry) {
          const dirty = isDirty(entry)
          const displayName = entry.title ?? entry.label
          return h(
            'tr',
            { key: entry.key, style: dirty ? { background: 'rgba(230, 160, 40, 0.07)' } : undefined },
            h(
              'td',
              {
                style: { ...cell, width: ENTRY_COL_WIDTH, maxWidth: ENTRY_COL_WIDTH, overflow: 'hidden' },
                onMouseEnter: (event) => showTip(event, entry),
                onMouseLeave: () => setTip(null),
              },
              h(
                'div',
                {
                  style: {
                    fontWeight: 500,
                    fontSize: 13,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                displayName,
              ),
              entry.spec
                ? h(
                    'div',
                    {
                      style: {
                        fontSize: 11,
                        opacity: 0.55,
                        marginTop: 1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      },
                    },
                    entry.spec,
                  )
                : null,
            ),
            profiles.map((profile) => {
              const status = entry.status?.[profile.name]
              const problem = PROBLEM.has(status)
              const checked = scopeOf(entry).includes(profile.name)
              const detail = problem ? scopeDetail(entry, profile.name, status) : checked ? t('inSync') : t('notInScope')
              return h(
                'td',
                { key: profile.name, style: { ...cell, textAlign: 'center', whiteSpace: 'nowrap' } },
                h(
                  'span',
                  { title: `${checked ? t('inScope') : t('notInScope')} — ${detail}`, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                  h(
                    'label',
                    { style: { display: 'inline-flex', alignItems: 'center', cursor: 'pointer' } },
                    h('input', {
                      type: 'checkbox',
                      checked,
                      onChange: () => toggleScope(entry, profile.name),
                      'aria-label': `${entry.label} @ ${profile.name}`,
                      style: { margin: 0, cursor: 'pointer' },
                    }),
                  ),
                  problem
                    ? h('span', { title: detail, style: { cursor: 'help', fontSize: 13, lineHeight: '16px' } }, '⚠️')
                    : null,
                ),
              )
            }),
            h(
              'td',
              { style: { ...cell, whiteSpace: 'nowrap', textAlign: 'right' } },
              dirty
                ? smallButton(() => saveRowScope(entry), busy === `scope:${entry.key}` ? '…' : t('save'), Boolean(busy))
                : null,
            ),
          )
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
                  {
                    style: {
                      borderCollapse: 'collapse',
                      width: '100%',
                      minWidth: 500,
                      tableLayout: 'fixed',
                      fontSize: 13,
                    },
                  },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', { style: { ...headCell, width: ENTRY_COL_WIDTH } }, t('item')),
                      ...profiles.map((profile) =>
                        h('th', { key: profile.name, style: { ...headCell, textAlign: 'center' } }, profile.name),
                      ),
                      h('th', { style: { ...headCell, width: ACTIONS_COL_WIDTH, textAlign: 'right' } }, t('actions')),
                    ),
                  ),
                  h('tbody', null, visible.flatMap((entry) => rowFor(entry))),
                ),
              )

        const unmanagedEntries = Array.isArray(state?.unmanaged) ? state.unmanaged : []
        const unmanagedBlock =
          tab !== 'bundles' || unmanagedEntries.length === 0
            ? null
            : h(
                'div',
                { style: { ...cardStyle, marginTop: 10 } },
                h(
                  'div',
                  null,
                  h('span', { style: { fontWeight: 600, fontSize: 13 } }, `${t('unmanagedTitle')} (${unmanagedEntries.length})`),
                  h('span', { style: { marginLeft: 8, fontSize: 11, opacity: 0.6 } }, t('unmanagedHint')),
                ),
                h(
                  'table',
                  { style: { borderCollapse: 'collapse', width: '100%', marginTop: 6, fontSize: 12 } },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', { style: { ...headCell, textAlign: 'left' } }, t('item')),
                      h('th', { style: { ...headCell, textAlign: 'left' } }, t('profilesLabel')),
                      h('th', { style: { ...headCell, textAlign: 'left' } }, t('versionLabel')),
                      h('th', { style: { ...headCell, width: ACTIONS_COL_WIDTH, textAlign: 'right' } }, t('actions')),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    unmanagedEntries.map((entry) =>
                      h(
                        'tr',
                        { key: entry.name },
                        h('td', { style: { ...cell, wordBreak: 'break-all' } }, entry.name),
                        h('td', { style: { ...cell, whiteSpace: 'nowrap' } }, entry.profiles.join(', ')),
                        h(
                          'td',
                          { style: { ...cell, whiteSpace: 'nowrap' } },
                          entry.core
                            ? `${entry.version ?? '—'} · ${t('coreBundle')}`
                            : entry.version ?? '—',
                        ),
                        h(
                          'td',
                          { style: { ...cell, textAlign: 'right' } },
                          smallButton(
                            () => adoptBundle(entry),
                            busy === `adopt:${entry.name}` ? '…' : t('adopt'),
                            Boolean(busy),
                          ),
                        ),
                      ),
                    ),
                  ),
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

        const tipEntry = tip === null ? null : entries.find((entry) => entry.key === tip.key) ?? null
        const tipCard =
          tipEntry === null
            ? null
            : h(
                'div',
                {
                  style: {
                    position: 'fixed',
                    left: tip.left,
                    top: tip.top,
                    width: 352,
                    zIndex: 1000,
                    pointerEvents: 'none',
                    padding: '10px 12px',
                    borderRadius: 10,
                    fontSize: 12,
                    lineHeight: '18px',
                    border: '1px solid var(--dsw-alias-border-1, rgba(127,127,127,0.25))',
                    background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
                    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.20)',
                    color: 'inherit',
                  },
                },
                h(
                  'div',
                  { style: { fontWeight: 600, fontSize: 13, wordBreak: 'break-all' } },
                  tipEntry.title ?? tipEntry.label,
                ),
                h(
                  'div',
                  { style: { opacity: 0.6, marginTop: 2 } },
                  t(KIND_LABEL[tipEntry.kind] ?? 'descItem'),
                ),
                h(
                  'div',
                  { style: { marginTop: 6, opacity: 0.85, whiteSpace: 'pre-wrap' } },
                  tipEntry.description ??
                    t(tipEntry.kind === 'bundle' ? 'descBundle' : tipEntry.kind === 'provider' ? 'descProvider' : 'descItem'),
                ),
                h(
                  'div',
                  {
                    style: {
                      marginTop: 8,
                      paddingTop: 6,
                      borderTop: '1px solid var(--dsw-alias-border-1, rgba(127,127,127,0.18))',
                      display: 'grid',
                      gridTemplateColumns: '76px 1fr',
                      gap: '2px 8px',
                    },
                  },
                  ...tipRows(tipEntry),
                ),
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
          dirtyBar,
          table,
          unmanagedBlock,
          planBlock,
          resultBlock,
          maintenanceBlock,
          doctorBlock,
          h('div', { style: { marginTop: 12, fontSize: 11, opacity: 0.55 } }, `${t('scopeCellHint')} ${t('outOfScopeHint')}`),
          tipCard,
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
