# DeepSeek Companion（精简版）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness-orange)](https://github.com/deepseek-ai/deepseek-harness)

> **版本说明**：本仓库为**精简版**，包含 A–D 四大基础模块（对话导出 / 交接摘要 / 成本优化 / 全局检索）。
> 开发者版（A–J 九大模块，含执行轨迹分析、Prompt 工作台、多模型竞技场、任务编排、安全审计）请见 [beijingwahw/dsh-companion-dev](https://github.com/beijingwahw/dsh-companion-dev)。

**DeepSeek Harness 官方伴侣插件** —— 基于 Cordis 框架与 Harness Plugin SDK 构建，为 DeepSeek Harness 平台提供对话智能导出、上下文交接摘要、API 成本优化与全局对话检索四大能力。

- 开发语言：TypeScript（`strict: true`，ESM）
- 运行框架：DeepSeek Harness（Cordis ≥ 4.0，一切皆插件）
- API 直连：DeepSeek 官方 API（`https://api.deepseek.com`）
- 数据安全：所有用户数据仅存于 Harness 插件沙箱本地，API Key 以 AES-256-GCM 加密落盘

---

## 功能总览

| 模块 | 能力 | 独立开关 |
|---|---|---|
| **A · 对话智能导出** | Markdown / PDF / JSON / **PNG 长图**导出、时间戳开关、隐私脱敏（手机号/邮箱/身份证/银行卡自动打码）、多会话批量 ZIP 打包；含中文的 PDF 由客户端 canvas 光栅化为**免打印多页 PDF**（无 `window.print()` 对话框冻结） | `enableExport` |
| **B · 上下文交接摘要** | 一键生成 ≤500 字四段式交接摘要、可编辑、复制到剪贴板、保存为模板、导入摘要作为新对话的 system 首条消息实现上下文继承 | `enableHandoff` |
| **C · API 成本优化（开发者模式）** | API Key 加密托管、**官方动态计价引擎**（每小时抓取 DeepSeek 与国产厂商官方定价页，新模型/调价自动导入，抓取失败静默降级内置快照）、**峰谷分时计价**（高峰时段按高峰价计费）、峰谷自动调度（高峰窗口实时解析自官方定价页）、模型智能路由、**日/月双档预算** 80%/100% 预警并自动暂停非必要调用、缓存命中折扣计费、每日/每周 Token 消耗与费用报表 | `enableCost` |
| **D · 全局对话检索 + 对话内搜索** | 关键词模糊搜索、时间范围筛选、自定义标签增删与按标签过滤、结果点击直达对话；**对话内搜索**（Ctrl+F 浮动查找栏，CSS Custom Highlight API 无侵入高亮，大小写/全词开关、查询历史、流式输出期间自动重同步） | `enableSearch` |

四个模块均为独立 Cordis 子插件，可任意组合启停，互不影响。

---

## 安装

### 前置要求
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `>= 0.1.0`
- Node.js `^22.19 || >=24`
- pnpm（`npm install -g pnpm`）

### 一键安装

```bash
dsh plugin add beijingwahw/dsh-companion --profile web
```

启动后插件面板自动加载：

```bash
dsh web
```

验证：在 Harness 命令面板执行 `usage`，返回本月用量报告即安装成功。

> 常用进阶命令：升级 `dsh plugin upgrade dsh-companion --profile web`；卸载 `dsh plugin remove dsh-companion --profile web`；本地路径安装 `dsh plugin add ./dsh-companion --profile web`。更多方式见「开发期热更新」后附。

---

## 开发期热更新（HMR）

| 层 | 方法 | 生效范围 |
|---|---|---|
| 运行配置 | 编辑 dsh 用户层 `cordis.patch.yml`（`~/.dsh/profiles/<name>/` 或 `~/.dsh/`），保存即生效 | dsh 原生监视用户层，事务性重载该行（bundle 层默认值已全量列出，照抄整行覆盖即可） |
| 开发期代码 | `npm run dev` 起独立 cordis + HMR 进程 | 保存 `src/` 下任意文件或 `cordis.yml` → 旧实例卸载（effect 回卷）→ 新代码挂载，无需重启 |
| 安装产物 | 改代码 → `pnpm build` → 重新 `dsh plugin add beijingwahw/dsh-companion --profile web` → 重启 dsh | 更新已安装的插件 |

`npm run dev` 的组成：仓库根 `cordis.yml` 依次挂 logger / timer / hmr / 宿主桩 / 本插件（直接加载 `src/index.ts`，config 与 `cordis.patch.yml` 逐键一致）；
`dev/host-stubs.ts` 提供 dsh 宿主 7 个服务的最小桩（webServer / storageDomain / credentials / sessionQuery / commands / settings / systemPrompt）——存储域为内存版且按名缓存，热重载后开发数据不丢。

> 注意：开发 HMR 需 Node ≥ 24.11（24.1.0 等早期 24.x 的 Node 内部接口与 cordis-plugin-loader 1.0.2 不兼容，表现为编辑文件不触发重载）。

### 从源码构建安装（贡献者 / 离线场景）

```bash
git clone https://github.com/beijingwahw/dsh-companion.git
cd dsh-companion
pnpm install
pnpm run build
dsh plugin add . --profile web
```

---

## 使用说明

### 配置 DeepSeek API Key（模块 C 前置）

1. 打开插件设置页的「开发者模式」总开关。
2. 在「API Key 管理」输入框粘贴你的 DeepSeek API Key 并保存。
   - Key 通过 AES-256-GCM 加密后存入 Harness 插件沙箱的 `companion` 存储域；
   - 任何接口响应、日志、事件中均不会出现 Key 明文（`/cost/state` 仅返回 `apiKeyConfigured` 布尔）。
3. 可选：点击「测试连接」验证 Key 有效性（对应 `/cost/test-call`）。

### 模块 A：导出对话

- **单次导出**：对话界面头部操作区点击「导出」，或命令面板执行 `export`。选择格式（Markdown / PDF / JSON / PNG 长图），勾选是否保留时间戳（默认开启）、是否隐私脱敏，确认后文件经浏览器下载到本地。
- **PNG 长图**：整篇对话经客户端 canvas 光栅化（SVG foreignObject，2x 视网膜）为一张纵向长图直接下载；仅客户端界面可用（命令面板无 canvas），不参与批量 ZIP。
- **批量导出**：历史对话列表勾选多个会话，点击「批量导出」（或命令 `export-batch`），自动打包为 ZIP 下载（单次最多 100 个会话，自动去重）。
- PDF 说明：纯 Latin-1 内容直接生成结构化 PDF 文件；含中文等非 Latin-1 字符时由客户端光栅化为免打印多页 PDF（A4 分页、JPEG 编码、零依赖 PDF 组装），全程无 `window.print()` 对话框——该路径在部分平台（尤其 Windows Chrome）会冻结整个浏览器；无光栅能力的环境（命令面板）退回打印视图由浏览器另存为 PDF。

### 模块 B：交接摘要

- **生成**：对话头部点击「交接摘要」按钮（或命令 `handoff`），插件调用 DeepSeek API 按固定四段式 Prompt 生成摘要：核心结论 / 已解决的问题 / 关键背景信息 / 待办事项与未解决问题（≤500 字）。
- **编辑与复用**：摘要在可编辑弹窗中展示，支持「复制到剪贴板」与「保存为模板」；模板可后续查看、删除，生成摘要时也可指定已有模板作为指令文本（缺省回退固定契约 Prompt）。
- **导入继承**：新建对话时通过输入区 dock 的「导入历史摘要」入口（或命令 `handoff-import`）粘贴摘要。插件将其武装给下一个新对话，自动作为 `system` 角色第一条消息注入，实现跨对话上下文继承。

### 模块 C：成本优化

- **官方动态计价**：计价引擎每小时抓取 DeepSeek 官方定价页（含峰谷分时计划）与智谱/百度文心/字节豆包/Kimi 等国产厂商定价页，自动发现带价模型并导入；官方价格内容变化时持久化新快照，重启后沿用；抓取失败静默降级为内置刊例价快照，不影响实时计价。用户可按模型 id 自定义单价覆盖（最长前缀匹配）。
- **峰谷分时计价**：官方定价页声明的高峰时段（缺省北京时间 9:00–12:00、14:00–18:00）按高峰价计费，空闲时段按空闲价；缓存命中的输入按折扣价计费。
- **峰谷自动调度**：开启后，任务可标记「紧急 / 普通」。「普通」任务在高峰时段进入延迟队列（容量上限 100），自动等到空闲时段再发起 API 调用；高峰窗口优先取计价引擎对官方定价页的实时解析，异常时回退内置缺省窗口；预算暂停期间排队任务会在执行前被复检拦截；交互式操作（如生成交接摘要）按「紧急」处理，不参与延迟。
- **模型智能路由**：开启后按任务类型自动选模 —— 翻译、摘要等简单任务走 `deepseek-chat`，代码生成、推理等复杂任务走 `deepseek-coder`；支持自定义路由规则覆盖默认策略。
- **日/月双档预算**：分别设置日预算与月预算上限（CNY，0=不限）。任一档消耗达 80% 时通过 Harness 通知系统提醒；达 100% 时再次提醒并自动暂停非必要 API 调用（必要调用仍放行但持续告警）。
- **成本报表**：独立视图页展示每日/每周 Token 消耗、费用估算（动态计价引擎实时解析）、日/月预算进度条（80% 黄、100% 红）、定价来源（官方实时/内置快照）与峰谷计划，支持手动触发官方定价刷新，以及峰谷调度节省的金额。命令 `usage` 可在面板内快速查看本月文本报告。

### 模块 D：全局检索与对话内搜索

- 历史对话列表顶部注入全局搜索框（或命令 `search`）：
  - **关键词**：模糊匹配全部历史对话内容；
  - **时间**：日期选择器按范围过滤；
  - **标签**：命令 `tag` 或结果页为会话增删自定义标签，支持按标签筛选。
- 搜索结果以列表呈现，附命中片段，点击直达对应对话。
- **对话内搜索**（吸收自 dsh-conv-search）：对话头部点击「对话内搜索」或按 `Ctrl/Cmd+F` 打开浮动查找栏：
  - `Enter` / `Shift+Enter`、`F3` / `Ctrl+G`：下一个 / 上一个命中（环绕）；`Esc` 关闭；`↑` / `↓` 浏览查询历史；
  - `Aa` / `ab` 开关：区分大小写 / 全词匹配；
  - 高亮经 CSS Custom Highlight API 以覆盖层绘制，不触碰 React 管理的转录 DOM；模型流式输出或加载更早消息时经 MutationObserver 自动重同步，激活命中按「文本节点 + 偏移」身份保持，不跳动读者的滚动位置；
  - 匹配只扫描对话滚动视口，自动排除输入区草稿与搜索栏自身，无幻影命中。

---

## 配置参考

根配置（`cordis.patch.yml` 可覆盖任意字段）：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enableExport` | boolean | `true` | 启用模块 A |
| `enableHandoff` | boolean | `true` | 启用模块 B |
| `enableCost` | boolean | `true` | 启用模块 C |
| `enableSearch` | boolean | `true` | 启用模块 D |
| `apiBaseUrl` | string | `https://api.deepseek.com` | DeepSeek API 基址（manifest 已放行该域名） |
| `apiTimeoutMs` | number | `60000` | 单次 API 调用超时（毫秒） |

停用单个模块：将对应开关置为 `false`（配置层），或在 `manifest.json` 的模块声明中关闭。模块之间零耦合，停用一个不影响其余模块。

---

## 架构简介

```
src/
├── index.ts              # 宿主入口：挂载核心服务 + 按配置挂载四个模块子插件
├── config.ts             # 根配置 schema（schemastery 校验）
├── core/                 # 核心基础设施
│   ├── service.ts        #   CompanionCore 根服务（ctx.companion，持有动态计价引擎）
│   ├── vault.ts          #   SecretVault：AES-256-GCM 加密保险库
│   ├── crypto.ts         #   AES-256-GCM 原语（Node crypto）
│   ├── deepseek.ts       #   DeepSeek Chat Completions 客户端
│   ├── usage.ts          #   用量记账存储（日粒度，含缓存命中 tokens）
│   ├── pricing.ts        #   计价桥接层（官方 usage → 计价引擎用量形状）
│   ├── price/            #   动态计价引擎（移植自 dsh-usage-ledger）：
│   │                     #   types / catalog（多厂商刊例价目录）/ scrapers（官方定价页解析）/ service
│   ├── time.ts           #   北京时间峰谷窗口计算
│   ├── transcript.ts     #   对话转录格式化（MD/JSON）
│   ├── privacy.ts        #   隐私脱敏（手机/邮箱/身份证/银行卡）
│   ├── pdf.ts / zip.ts   #   零依赖 PDF 生成 / ZIP 打包
│   └── http.ts           #   私有 HTTP 路由器（前缀 /companion）
├── modules/
│   ├── export/           # 模块 A：导出 + 批量 ZIP + 光栅载荷（PNG/免打印 PDF）
│   ├── handoff/          # 模块 B：摘要生成 / 模板 / 武装导入
│   ├── cost/             # 模块 C：网关 / 调度器 / 路由 / 日/月双档预算 / 设置
│   └── search/           # 模块 D：检索 + 标签
├── client/               # 浏览器端 UI（slots 注入，官方组件库）
│   ├── index.tsx         #   客户端入口：slot 注册 + 对话内搜索控制器生命周期
│   ├── raster.ts         #   客户端光栅导出引擎（移植自 dsh-conv-export）：
│   │                     #   PNG 长图 / 免打印多页 PDF（foreignObject → canvas → JPEG → PDF 组装）
│   ├── convsearch/       #   对话内搜索（移植自 dsh-conv-search）：
│   │                     #   engine（Highlight API）/ controller（浮动栏+快捷键）/ styles
│   └── components/       #   导出弹窗 / 摘要弹窗 / 导入 dock / 检索视图 / 报表视图
└── types/                # Harness 子系统适配层类型声明
```

关键设计：

- **一切皆插件**：宿主入口只做挂载编排；每个功能模块是独立 Cordis 函数插件，注册即 effect，生命周期由 Cordis 自动回卷。
- **单一服务门面**：模块间不互相 import，跨模块协作一律经 `ctx.companion`（核心服务）或 `ctx.companionCost`（成本网关）。
- **双通道同构**：命令面板 handler 与私有 HTTP 端点（`/companion/*`）复用同一套模块服务函数，无重复逻辑。
- **UI 非侵入**：所有界面经 Harness slots 注入（`conversation.session.header.actions`、`conversation.input.dock`、`conversation.view`），组件取自官方 UI 原语库，颜色仅用语义令牌，无悬浮窗、无全局样式。

完整的内部契约（服务签名、HTTP API、命令表、slot 清单）见 [DESIGN.md](./DESIGN.md)。

---

## 安全与隐私

| 要求 | 实现 |
|---|---|
| 数据本地化 | 对话内容、设置、API Key 仅写入 Harness 插件沙箱的 `companion` 存储域，不上传任何第三方服务器 |
| API Key 加密 | AES-256-GCM（12 字节随机 IV + 认证标签），自描述载荷 `v1.<iv>.<tag>.<ciphertext>`；密钥与密文分离存储 |
| 网络权限 | `manifest.json` 全量放行 DeepSeek 官方 API、全部国产与海外主流模型厂商端点、各厂商定价页及常见中转/聚合网关，供动态计价引擎实时抓取；存储域仅 `companion`；服务清单逐项列明 |
| 无追踪 | 无任何遥测 / 行为分析代码；`manifest.json` 显式声明 `tracking: false, telemetry: false` |
| Key 不外泄 | 任何响应、日志、事件中不出现 Key 明文；导出与摘要内容仅在浏览器本地生成 |

---

## 交付物清单

- [x] 完整 Harness 插件源码（`src/`，TypeScript strict）
- [x] `manifest.json`（权限与隐私声明）、`package.json`、`cordis.patch.yml`（bundle patch 层）、`tsconfig.json`
- [x] `README.md`（本文件）：功能介绍、安装指南、使用说明
- [x] `DESIGN.md`：架构契约与开发规范
- [x] 四模块独立启停：配置开关 + 独立子插件 + manifest 模块声明三层保障

---

## 能力来源

本插件在原有四大模块基础上，吸收并整合了以下三个同系仓库的核心能力：

| 来源仓库 | 吸收的能力 | 落点 |
|---|---|---|
| `dsh-usage-ledger` | 官方定价页动态计价引擎（实时抓取/解析/兜底快照）、峰谷分时计价、多厂商价格目录与专用解析器、缓存命中折扣、日/月双档预算 | `src/core/price/`、`src/modules/cost/` |
| `dsh-conv-export` | PNG 长图光栅导出、免打印对话框多页 PDF（foreignObject → canvas → JPEG → 零依赖 PDF 组装）、图片 data-URL 内联 | `src/client/raster.ts`、`src/modules/export/`（kind:'raster' 载荷） |
| `dsh-conv-search` | 对话内搜索引擎（CSS Custom Highlight API 无侵入高亮）、浮动查找栏（快捷键/查询历史/大小写与全词开关）、流式输出 MutationObserver 重同步与命中锚点保持 | `src/client/convsearch/` |

移植时统一了命名空间（`companion-*`）、注释语言与错误处理纪律，并按本插件的 slots/双通道架构重新接线；全部改动通过 `tsc --noEmit` 严格类型检查与 39 项冒烟断言。

## 许可

MIT
