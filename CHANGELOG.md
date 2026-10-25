# Changelog

## 0.1.2 — 插件元数据、版本漂移与回滚

### 新增

- 插件条目显示包自带的中文名（`locale/zh.json` 的 `meta.title`，缺失时回退包名），悬浮卡显示全名、版本与描述；
  描述优先级为清单 `description` > 包 `locale/zh.json` > `package.json`。清单条目新增可选 `title` / `description`（三种类型都支持）。
- 版本漂移检测：已安装版本与 `name@x.y.z` spec 不一致时状态标为「版本不一致」，`apply` 会先升级再写配置。
- 未纳管插件：列出 profile 已启用但清单没有的 bundle，可一键「纳入清单」（自动带版本与所在 profile）。
- 回滚：`restore` 动作 / CLI 命令 / 设置页按钮，恢复最近一次 apply 前的 `package.json` 与 `cordis.patch.yml`；回滚前再备份当前内容。
- `doctor` 诊断：清单校验、home 层覆盖、写锁残留、profile 缺失、安装能力、版本漂移、未纳管、备份、拒绝日志体积。
- 批量保存「保存全部」与未保存修改的离开确认。

### 修复

- 清单 `spec` 变更此前被静默忽略（只按包名判断是否已装），现在会检测并升级。
- 版本解析补充到 profile 状态，供状态矩阵与诊断复用。

### 说明

- 版本比较仅适用于 `name@x.y.z` 形式的 spec；git / 路径 spec 不参与。
- 未纳管检测目前覆盖 bundle 选择，不覆盖手写配置行与 provider。

## 0.1.1 — 首个公开发布

### 新增

- 一份 `$DSH_HOME/fleet.yml` 管理多个 profile 的插件包、模型 provider 与配置行，每个条目可锁定适用范围（`scope`）。
- 设置页：顶部 profile 状态卡（当前 profile、问题数、待应用数），主体按 **插件包 / 模型接入 / 配置行** 三个页签分开，支持搜索与「只看问题」。
- `fleet` Agent 工具（`status | plan | apply | scope | install`）与离线 CLI `scripts/fleet.mjs`。
- 安全协议：安装先行、失败即中止；全局写锁；`# >>> dsh-fleet` 受管块之外逐字节保留；`.bak-fleet-<ts>` 备份保留 5 份。
- HTTP API 同源校验（`x-fleet-guard: 2`），拒绝日志写入 `$DSH_HOME/fleet.reject.log`。

### 修复

- 预览只比较受管块头部 hash：块正文被外部编辑但头部未变时检测不到漂移，导致「应用」不重写。现在会解析正文并按内容 hash 比较。
- `llm-pi-ai` 行不在某 profile 范围时，provider 状态误报漂移；现在跟随载体行显示为「范围外」。
- 离线 CLI 误判安装锚点，导致大量虚假的 install 变更；改为沿 `PATH` 解析 `dsh` 位置。
- 安装变更在预览中重复出现；现在只列一次。

### 说明

- `desktop` 是保留 profile：安装与启动只能由 desktop 进程内的 `plugin_manager` 完成，CLI 会拒绝。
- 受管块内的行请通过 `fleet.yml` 修改；直接改块内容会在下次应用时被覆盖。
