# dsh-fleet

一份清单，统一管理本机所有 DSH profile 的**插件包、模型 provider、配置行**，并给每个条目加上**适用范围锁**。
同一份代码装进 `web`、`dsh-tui`、`desktop`，共享唯一真源 `$DSH_HOME/fleet.yml`。

```
~/.dsh/fleet.yml  ──render──▶  每个 profile 的 cordis.patch.yml 受管块
      │                        每个 profile 的 dsh.profile.bundles 选择
      │
      ├─ 浏览器侧栏面板（侧栏图标 → 多 Profile 管理）
      ├─ Agent 工具 `fleet`（TUI 里也可用）
      └─ 离线 CLI `scripts/fleet.mjs`（引导/恢复）
```

## 解决什么问题

- 同一个插件不再需要在每个 profile 里手动装一遍、开一遍。
- 模型 provider 目录（`llm-pi-ai`）和默认模型不再各 profile 各写一份。
- 配置行（`ui-theme`、`permission`、`mnemon`、`web` 等）集中维护，避免同一行在多个 profile 里漂移。
- 每个条目声明 `scope`：**不在范围内的 profile 不会写入、不会安装、不会生效**。
- 悬空引用（例如 `web.searchProvider: ddg` 却没有装 `dsh-free-search`）在写文件前被校验器拒绝。
- 版本漂移（清单 `spec` 与已安装版本不一致）会被标出，`apply` 时先升级再写配置。
- profile 里已启用、但清单里没有的插件会列在「未纳管」里，可一键纳入清单。
- 误操作可以回滚到最近一次 `apply` 前的备份；`doctor` 一次检查 home 层覆盖、残留锁、缺失 profile、安装能力与版本。

## 作用域语义（重点）

| 条目类型 | 范围内 | 范围外 |
|---|---|---|
| `bundles` | 安装 + 加入该 profile 的 `dsh.profile.bundles` | 从选择列表移除（依赖保留），**强制** |
| `providers` | 并入该 profile 的 `llm-pi-ai.config.providers` | 从聚合中省略，**强制** |
| `items`（配置行） | 写入受管块，整段替换该行 `config` | **不写入、不触碰**；只有显式 `enforce: true` 才写 `disabled: true` |

- 配置行的“锁”含义是**不应用**：范围外的 profile 保留它自己的层/bundle 默认值，而不是被强行关闭。
- 需要“范围外必须关闭”时给该条条目加 `enforce: true`（且该行在目标 profile 的组合中存在）。
- `overrides` 允许按 profile 覆盖，保留各端现状（例如 TUI 的 `retryPolicy`、Desktop 的默认模型）。

## Manifest 参考

```yaml
version: 1
profiles: [web, dsh-tui, desktop]

providers:
  - key: openmodel
    scope: [all]                    # 所有 profile
    description: 'OpenModel 模型目录（68 个模型）'
    config: { displayName, apiKeyEnv, api, baseURL, models: [...] }
    overrides:
      dsh-tui: { config: { retryPolicy: {...} } }   # 浅合并

bundles:
  - name: dsh-free-search
    spec: dsh-free-search@0.9.15    # 安装 spec；@deepseek-ai/* 用包名即可（随 DSH 提供）
    scope: [all]
    title: '免费搜索'
    description: '免费搜索与抓取（DDG / fs-quality-fetch）'
    provides: [ddg, fs-quality-fetch]   # 供校验器检查配置引用

items:
  - id: web                         # loader 行 id
    name: '@deepseek-ai/dsh-web'    # 可选断言
    scope: [all]
    description: 'web 搜索与抓取供应商'
    config: { searchProvider: ddg, fetchProvider: fs-quality-fetch }
    overrides:
      dsh-tui: { config: { searchProvider: deepseek-search-api, fetchProvider: http } }
    requires: [dsh-free-search]     # 缺这个 bundle 就拒绝写入
  - id: agent-default-model
    scope: [web, desktop]
    config: { provider: opencode-go, model: deepseek-v4-pro, reasoningEffort: high }
    overrides:
      desktop: { config: { provider: openmodel, model: deepseek-v4.1-flash, reasoningEffort: low } }
  - id: dsh-tui                     # 带 !!js 的行请留在 profile 本地，不要纳入清单
```

`config` 与 DSH patch 语义一致：**整段替换，不做深合并**。`overrides` 是唯一例外：与基座浅合并。

provider 的模型条目有**按模型 id 的元数据继承**：清单里只写 `id` / `name` 时，渲染会用该 profile
自己 `llm-pi-ai` 行里同一模型的 `reasoningEfforts`、`contextWindow`、`maxTokens`、`input`、`output`
补全（清单显式写的值优先）。这样清单只当“选哪些模型”，不必复述模型能力；删掉字段不会把已有能力抹掉，
要显式关闭推理强度就写 `reasoningEfforts: false`。补全用的是**受管块之外**的行，所以不会把自己上一轮的输出当来源。
`title` 与 `description` 是三个类型都支持的可选字段，只用于设置页展示（行内显示 title，悬浮卡显示 description），不参与渲染；两者都必须是字符串。
`title` 会覆盖插件包自带的中文名（`locale/zh.json` 的 `meta.title`），没有 title 时回退到包名。

## 安装到各 profile

发布版从 GitHub tag 安装（web / dsh-tui）：

```bash
dsh plugin --profile web add "github:Han-Haocheng/dsh-fleet#v0.1.2"
dsh plugin --profile dsh-tui add "github:Han-Haocheng/dsh-fleet#v0.1.2"
```

本地开发时把 spec 换成 checkout 路径：

```bash
dsh plugin --profile web add /path/to/dsh-fleet
dsh plugin --profile dsh-tui add /path/to/dsh-fleet
```

`desktop` 是保留 profile，CLI 拒绝启动/安装，必须在运行中的 desktop 实例里完成：

```text
plugin_manager install_bundle(target="/path/to/dsh-fleet")
# 或者：设置页 → 插件 → 安装（GitHub URL / 本地目录）
```

然后再把 `dsh-fleet` 自身加入 manifest 的 `bundles`（`scope: [all]`），运行一次 `apply`。

## 使用

### 浏览器（web / desktop）

点侧栏的 **多 Profile 管理** 图标（不再放在设置里——设置是用来控制插件的，fleet 控制的是同步）：

- 顶部三张 profile 状态卡：当前 profile、问题数、待应用数、清单路径、写锁、上次应用时间；
- 主体按 **插件包 / 模型接入 / 配置行** 三个页签分开，不再混在一张长表里，页签上带条目数；
- 每个页签内支持按名称/标识搜索、勾选“只看问题”，表格按 profile 列展示状态；
- 每列勾选框直接切换该条目是否写入该 profile，改完行尾才出现「保存」；有问题的单元格显示 ⚠️，悬浮查看原因；
- 条目显示插件的中文名（读取包的 `locale/zh.json` 中 `meta.title`，没有则回退到包名）；
- 鼠标悬浮**条目名称**显示详情卡：全名、版本、描述、安装 spec、provider / 配置要点、范围与各 profile 当前状态；
- 描述优先级：清单条目的 `description` > 包的 `locale/zh.json` `meta.description` > 包的 `package.json` `description`；
- 多行改动后可点「保存全部」；有未保存修改时刷新或关闭页面会弹离开确认；
- 插件包页签底部列出「未纳管插件」，带版本与所在 profile，可一键「纳入清单」；
- 「诊断」按钮输出环境检查（清单、home 层、写锁、profile、安装能力、版本、备份）；
- 有可用备份时显示「回滚上次应用」，回滚前会先备份当前内容，回滚本身也可撤销；
- “预览变更 / 应用”在底部给出待应用清单、待安装包、备份与需重启提示。

### Agent 工具（三个 profile 都可用，TUI 也适用）

```
fleet(action="status")                          # 矩阵
fleet(action="plan")                            # 干跑
fleet(action="apply", profiles=["desktop"])     # 安装缺包 + 写受管块
fleet(action="scope", key="item:web", scope=["web","desktop"])
fleet(action="adopt", name="dsh-extra-bundle")  # 把已在 profile 启用的包纳入清单
fleet(action="restore")                         # 回滚到最近一次 apply 前的备份
fleet(action="doctor")                          # 环境诊断
fleet(action="install")                         # 只补装缺包
```

### 同步：以当前端为准

清单可以只描述「谁和谁共享」，值以**你当前所在的 profile** 为准推到其它端：

```yaml
sync:
  targets: [all]          # 默认目标端
  exclude: [llm-pi-ai]    # 不参与同步的行 id
  overrides:              # 逐行改目标，或整行关掉
    mnemon: { targets: [desktop] }
    web-ui-pet: { enabled: false }
```

- `fleet(action="sync")` / `GET /api/fleet/sync`：**只读预览**，逐行列出将写入的字段与 `from → to`；
- 清单启用 `sync` 时，`apply` 以当前 profile 为源写其它端（`dryRun` 仍只预览）；
- 源端读取：运行态用 `configEditor`，离线用 `dsh --profile <p> --dump-config`；
- 目标端差异以**有效配置**为基准；读不到该端的合成配置时回退受管块并给出告警；
- 自动排除：fleet 自己、含 `!!js` 的行、不在任何 profile patch 里的行（DSH 核心行）、空配置行；
- **三方基线**：上次同步的值记在 `$DSH_HOME/fleet.sync.json`。有基线时只推**源端真正改过的字段**；
  目标端也改过同一字段 → 判冲突（`action:'conflict'`，列出 `base/source/target`），该行整份不写；
  源端没改的字段永不覆盖目标端。首次同步（服务端还没有基线）才整行推送并标 `firstSync`。
- **可用性门禁**：包在目标端的 profile 与安装锚点里都解析不到 → 该目标跳过（`plugin-missing`）；
  两端版本不同 → 照常同步但告警（`version-mismatch`），不会把新版本的配置硬塞给旧版本的端。
- 基线只在 `apply` 成功（且非 `dryRun`）后更新；`restore` 成功后清空。基线文件损坏时 `apply` 直接中止，
  避免把「读不出来」当成「全都没同步过」而整行覆盖。

### TUI（`dsh-tui` 的 `/settings`）

`/settings` 里有一个 **「多 Profile 管理」** 页签，可改三个行配置项：

| 字段 | 含义 |
|---|---|
| 清单路径 | `fleet.yml` 的位置；`~` 指 DSH home，相对路径按它解析 |
| 自动安装缺失插件 | `apply` 前是否先补装缺包 |
| dsh 命令 | 向其它 CLI profile 安装时用的 `dsh` 可执行文件 |
| 启动时提示待应用 | `notifyOnDrift`：启动后做一次**只读**检查，清单与本 profile 不一致时在页脚显示 `fleet: N 待应用` 并写一条警告；不会写文件 |

改动即保存（写进该 profile 的 `cordis.patch.yml`，插件随即重启生效）。矩阵本身仍在 `fleet.yml` 里：

> **生效时机**：fleet 没有 watcher——`fleet.yml` 的改动只在 `apply` 时落到各 profile。为了让「改完忘了应用」可见，
> 插件启动后会延迟做一次只读 `plan`（`notifyOnDrift`，默认开）：有漂移就写日志并在 TUI 页脚显示 `fleet: N 待应用`，
> `fleet status` 的返回里也带 `drift: { pending, byProfile }`；`apply` 成功后会自动复检并清掉提示。它不会写任何文件。

TUI 设置屏只支持 text / number / boolean / select 四种控件，装不下整张矩阵，**它不是 fleet 设置页的等价物**。
看矩阵、批量改 scope、预览/应用请用 `fleet` 工具或浏览器侧栏面板。

> 实现说明：本插件的宿主行声明了 `Config` schema（字段标 `.volatile()`），因此它同时是一个 dsh settings 命名空间；
> TUI 只在插件主动注册 `tuiSettingsSections` 时才渲染分区，所以 `index.js` 里同时做了分区注册。
> 浏览器入口注册在 `sidebar.panellist`（图标）+ `main`（同名面板），不再占用 `settings.section`；为避免设置服务自动生成一张重复卡片，插件启动时仍调用 `settings.configure({ auto: false })`。

### 离线 CLI（引导 / 恢复；不依赖已安装的插件）

```bash
node scripts/fleet.mjs status
node scripts/fleet.mjs plan
node scripts/fleet.mjs apply --profiles web,dsh-tui
node scripts/fleet.mjs apply --dry-run
node scripts/fleet.mjs restore --profiles web   # 恢复最近一次 apply 前的备份
node scripts/fleet.mjs restore --stamp <ts>
node scripts/fleet.mjs doctor
```

离线 CLI 的安装能力：当前机器上的 CLI profile 走 `dsh plugin --profile <p> add`；
desktop 会标为 `manual`，必须在 desktop 进程内执行。

## 写协议与安全

- 每个 profile 的 `cordis.patch.yml` 末尾追加一个带注释标记的受管块：
  `# >>> dsh-fleet v1 sha256:<hash>` … `# <<< dsh-fleet`，每次整体重写；块外手写内容一字不动。
- **块内的外部行会被搬走，不会丢**：设置服务（TUI `/settings`、内置插件管理器）保存带行 id 的配置时是
  追加到 profile patch 末尾，而受管块正好在末尾，于是那一行会落进块里。`apply` 重写块时会把
  **清单里没有的 id** 搬到块后（`# preserved by dsh-fleet` 分隔），清单管理的 id 仍按清单来（范围外就删）。
  所以「在 TUI 里改 fleet 自己的行配置」能活过 apply；而在块里手改**清单管理的行**仍会被清单覆盖。
- 受管块在同层 patch 中位于最后，因此覆盖同文件里更早的同 id 行；但 home 层
  （`~/.dsh/cordis.patch.yml`）优先级更高，若在那里定义相同 id 会覆盖 fleet，fleet 会告警。
- 写前备份：`<file>.bak-fleet-<时间戳>`，每个文件保留最近 5 份。
- 并发：`$DSH_HOME/fleet.lock`（O_EXCL + pid，10 分钟或进程消失视为失效）。
- 密钥不写入 manifest，只写 `apiKeyEnv` 变量名；真实密钥仍由 DSH 凭据服务管理。
- 悬空校验：bundle 可解析、`requires` 满足、`agent-default-model` 的 provider 在目录里、
  受管行在目标组合中存在、home 层无 id 冲突。

## 首次引导（从既有 profile 生成清单）

```bash
node scripts/seed.mjs --dry-run    # 预览
node scripts/seed.mjs             # 写 ~/.dsh/fleet.yml（已有则先备份）
```

`seed.mjs` 是**一次性迁移工具**，scope 表是设计决策而不是现状转储；生成后 manifest 即真源。

## 回滚 / 卸载

每次 `apply` 前会备份 `package.json` 与 `cordis.patch.yml`（`*.bak-fleet-<时间戳>`，每个文件保留最近 5 份）。

```bash
node scripts/fleet.mjs restore --profiles web,dsh-tui   # 恢复每个 profile 最近一份备份
node scripts/fleet.mjs restore --stamp <时间戳>          # 恢复指定一代备份
```

侧栏面板底部在有备份时显示「回滚上次应用」。回滚前还会把当前内容再备份一次，所以回滚本身也可以撤销。

```bash
# 手动移除受管块：删掉 # >>> dsh-fleet … # <<< dsh-fleet 之间的内容
# 卸载插件包：plugin_manager remove_bundle（或 dsh plugin --profile <p> remove dsh-fleet）
```

## 已知限制

- 一个条目在其 scope 内只有一份 `config`；差异用 `overrides` 表达。带 `!!js` 表达式的行
  （如 TUI 的 `dsh-tui` 行）不纳入清单，留在 profile 本地。
- desktop 的安装必须由运行在 desktop 内的实例发起；离线 CLI 只写文件。
- 修改其他 profile 的文件由该 profile 的 HMR 在下次重组时生效；包安装可能需要重启。
- 内置插件管理器仍可单独改受管行；下次 `apply` 会检测漂移并恢复。
- 需要构建脚本的包（如 `cloudflared` / `ssh2`）在 pnpm 默认策略下会被拦成 `build-blocked`：
  先在插件管理器里显式批准这些构建（或 `plugin_manager install_bundle` 传 `approvedBuilds`），
  本插件的 `apply` 不会替你静默批准。
- 清单里 `dsh-fleet` 自身的 `spec` 是本机绝对路径；移动仓库目录后需要同步改这一行。
- 版本检测只对 `name@x.y.z` 形式的 spec 生效；git、路径、无版本 spec 不参与版本比较。
- 元数据继承只覆盖上面五个字段，且来源是 profile 里已有的行：某个模型在任何 profile 里都没有元数据时，
  它仍然只会被写成 `id` / `name`——TUI 里会如实显示“不支持推理强度”，这不是同步失败。
- 清单里同一 bundle 只有一个 `spec`（`overrides` 只合并 `config` / `disabled`）：各 profile 已装版本不一致时，
  `apply` 会按 spec 统一安装，包括把较新的版本降回合约版本。
- 未纳管检测目前只覆盖 `dsh.profile.bundles` 的选择，不覆盖手写配置行 / provider。
- HTTP 接口仅监听回环并要求同源来源（`127.0.0.1`、`localhost`、`[::1]` 视为同一本地源；
  带 `Sec-Fetch-Site: same-origin` 或 DSH 会话 Cookie 的同源请求也放行）；跨源与反向代理来源的写操作会被拒绝（读状态仍可用）。
  被拒绝的请求会以一行 JSON 记到 `$DSH_HOME/fleet.reject.log`（含 host/origin/sec-fetch-site，不含 Cookie 值），便于定位。

## 开发

```bash
node --test test/          # 单测（纯函数 + fixture profile）
node --check index.js && node --check client.js
node scripts/fleet.mjs plan --json
```

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
