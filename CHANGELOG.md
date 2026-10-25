# Changelog

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
