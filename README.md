# dsh-fleet

一份清单，统一管理本机所有 DSH profile 的**插件包、模型 provider、配置行**，并给每个条目加上**适用范围锁**。
同一份代码装进 `web`、`dsh-tui`、`desktop`，共享唯一真源 `$DSH_HOME/fleet.yml`。

```
~/.dsh/fleet.yml  ──render──▶  每个 profile 的 cordis.patch.yml 受管块
      │                        每个 profile 的 dsh.profile.bundles 选择
      │
      ├─ 浏览器设置页（Settings → 多 Profile 管理）
      ├─ Agent 工具 `fleet`（TUI 里也可用）
      └─ 离线 CLI `scripts/fleet.mjs`（引导/恢复）
```

## 解决什么问题

- 同一个插件不再需要在每个 profile 里手动装一遍、开一遍。
- 模型 provider 目录（`llm-pi-ai`）和默认模型不再各 profile 各写一份。
- 配置行（`ui-theme`、`permission`、`mnemon`、`web` 等）集中维护，避免同一行在多个 profile 里漂移。
- 每个条目声明 `scope`：**不在范围内的 profile 不会写入、不会安装、不会生效**。
- 悬空引用（例如 `web.searchProvider: ddg` 却没有装 `dsh-free-search`）在写文件前被校验器拒绝。

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
    config: { displayName, apiKeyEnv, api, baseURL, models: [...] }
    overrides:
      dsh-tui: { config: { retryPolicy: {...} } }   # 浅合并

bundles:
  - name: dsh-free-search
    spec: dsh-free-search@0.9.15    # 安装 spec；@deepseek-ai/* 用包名即可（随 DSH 提供）
    scope: [all]
    provides: [ddg, fs-quality-fetch]   # 供校验器检查配置引用

items:
  - id: web                         # loader 行 id
    name: '@deepseek-ai/dsh-web'    # 可选断言
    scope: [all]
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

## 安装到各 profile

发布版从 GitHub tag 安装（web / dsh-tui）：

```bash
dsh plugin --profile web add "github:Han-Haocheng/dsh-fleet#v0.1.1"
dsh plugin --profile dsh-tui add "github:Han-Haocheng/dsh-fleet#v0.1.1"
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

Settings → **多 Profile 管理**：

- 顶部三张 profile 状态卡：当前 profile、问题数、待应用数、清单路径、写锁、上次应用时间；
- 主体按 **插件包 / 模型接入 / 配置行** 三个页签分开，不再混在一张长表里，页签上带条目数；
- 每个页签内支持按名称/标识搜索、勾选“只看问题”，表格按 profile 列展示状态；
- 每列勾选框直接切换该条目是否写入该 profile，改完行尾才出现「保存」；有问题的单元格显示 ⚠️，悬浮查看原因；
- “预览变更 / 应用”在底部给出待应用清单、待安装包、备份与需重启提示。

### Agent 工具（三个 profile 都可用，TUI 也适用）

```
fleet(action="status")                          # 矩阵
fleet(action="plan")                            # 干跑
fleet(action="apply", profiles=["desktop"])     # 安装缺包 + 写受管块
fleet(action="scope", key="item:web", scope=["web","desktop"])
fleet(action="install")                         # 只补装缺包
```

### 离线 CLI（引导 / 恢复；不依赖已安装的插件）

```bash
node scripts/fleet.mjs status
node scripts/fleet.mjs plan
node scripts/fleet.mjs apply --profiles web,dsh-tui
node scripts/fleet.mjs apply --dry-run
```

离线 CLI 的安装能力：当前机器上的 CLI profile 走 `dsh plugin --profile <p> add`；
desktop 会标为 `manual`，必须在 desktop 进程内执行。

## 写协议与安全

- 每个 profile 的 `cordis.patch.yml` 末尾追加一个带注释标记的受管块：
  `# >>> dsh-fleet v1 sha256:<hash>` … `# <<< dsh-fleet`，每次整体重写；块外手写内容一字不动。
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

```bash
# 恢复某个文件
cp ~/.dsh/profiles/web/cordis.patch.yml.bak-fleet-<ts> ~/.dsh/profiles/web/cordis.patch.yml

# 移除受管块：删掉 # >>> dsh-fleet … # <<< dsh-fleet 之间的内容
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
