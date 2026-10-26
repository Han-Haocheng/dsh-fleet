# Changelog

## 未发布

### 新增

- **TUI `/settings` 里的「多 Profile 管理」页签**：可改清单路径、自动安装缺失插件、`dsh` 命令三项，改动即保存。
  做法是给宿主行声明 `Config` schema（三个字段标 `.volatile()`，否则 `dsh-settings` 不会为它建命名空间），
  并在 `apply()` 里通过 `tuiSettingsSections` 注册分区——TUI 的设置屏只渲染插件主动注册的分区，
  不会从命名空间自动生成。矩阵本身仍在 `fleet.yml`，TUI 的四种控件装不下。
- provider 模型元数据按 id 继承：清单里的模型条目只写 `id` / `name` 时，渲染用该 profile 自己 `llm-pi-ai` 行里
  同一模型的 `reasoningEfforts` / `contextWindow` / `maxTokens` / `input` / `output` 补全（清单值优先，
  `reasoningEfforts: false` 是显式关闭）。此前清单比现状“薄”时，受管块整段替换会静默抹掉推理强度，
  TUI 的模型选择器于是对所有模型显示“不支持”。
- 行配置改为按需解析（`resolveEnv()` 在每次工具调用 / HTTP 请求时读取），非 volatile 语义下也不会读到过期快照。
- 浏览器侧不再被设置服务自动生成一张与自定义页重复的卡片：启动时 `settings.configure({ auto: false })`。
- 新增依赖 `@deepseek-ai/schemastery`（`Config` schema 需要；与其它插件一致）。

### 修复

- `fleet` Agent 工具的返回值不再携带 `undefined` 属性。Harness 会把每个工具结果快照成无损 JSON，
  对象里出现一个 `undefined` 属性就抛 `tool "fleet" returned invalid output: value is not lossless JSON`。
  受影响动作：`status`（必失败，恰好是文档里的第一步）以及 `scope` / `adopt` / `restore`
  （文件已改完后才失败，调用方无法判断是否生效）。现在工具边界统一 `stripUndefinedJson()` 清理：
  `undefined`（不存在）丢弃并保留 `null`（已知为空），数组里的空位转 `null`，`Date` 转 ISO 串。
  HTTP 路由不受影响（`JSON.stringify` 本来就会丢 `undefined`）。
- 修正 Host 半注释：TUI profile 实际会挂载 `webServer`（`127.0.0.1:0`，无浏览器前端），
  `/api/fleet/*` 会被注册但无人可达；原先“TUI has no webServer”的判断不成立。

### 测试

- 新增 `test/tool-output.test.js`：按 Harness 的规则（无 `undefined` + JSON 往返不变）校验
  `status` / `plan` / `doctor` / 干跑 `apply` 的工具输出，并覆盖 `stripUndefinedJson()` 本身。
- 新增 `test/settings-ui.test.js`：校验 `Config` 默认值/类型拒绝、TUI 分区形状（ns、页签、三个字段的 kind）、
  `auto: false` 抑制，以及没有 settings 服务时（web/headless）不报错。
- 新增 `test/inherit-model-meta.test.js`：校验元数据继承的来源（只读受管块之外）、重复行后者优先、
  清单值优先、`reasoningEfforts: false` 不被覆盖，以及没有可继承数据时渲染字节不变。

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
