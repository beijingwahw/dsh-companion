# DeepSeek Companion — 架构与契约（开发规范）

本文件是插件内部开发的唯一契约来源。所有模块必须遵守这里的约定；
与 DeepSeek Harness 官方文档的对齐点见 `src/types/*.d.ts` 头部注释。

## 1. 通用约定

- ESM（`"type": "module"`）；本地相对导入一律带 `.js` 后缀（NodeNext）。
- `strict: true`；不使用 `any`，确需宽松处用 `unknown` + 收窄。
- 每个文件、每个导出符号写简洁中文 JSDoc（说明契约，不复述代码）。
- 注册即 effect：所有命令/路由/提示词注册都返回 disposer，交给 Cordis 生命周期管理。
- 品牌 id 一律经 `src/core/ids.ts` 铸造（`SessionId(x)` 等），禁止裸 string 跨边界。
- 模块间不直接 import 彼此文件；跨模块协作只经过 `ctx.companion` / `ctx.companionCost` 服务。

## 2. 核心服务 API（已实现，勿改动签名）

### `ctx.companion`（CompanionCore，src/core/service.ts）

```ts
interface CompanionCore {
  readonly config: Config                    // 根配置（apiBaseUrl/apiTimeoutMs/模块开关）
  readonly http: CompanionRouter             // 私有 HTTP 路由（前缀 /companion）
  readonly ready: Promise<CompanionStore>    // { domain, vault, usage }
  getApiKey(): Promise<string | undefined>   // 保险库优先，其次 credentials seam
  setApiKey(value: string): Promise<void>
  clearApiKey(): Promise<void>
  callDeepSeek(params: CallParams): Promise<ChatResult>  // 直连 + 记账 + companion/usage 事件
  readonly prices: PriceService              // 动态计价引擎（官方定价页抓取/峰谷分时/多厂商目录）
  setPricingOverrides(table: PriceTable): void  // 用户自定义单价（模型 id → 单价，最长前缀匹配）
  notice(kind: 'info'|'success'|'warning'|'error', message: string): void
}
interface CallParams {
  messages: readonly ChatMessage[]; model?: string; temperature?: number
  maxTokens?: number; signal?: AbortSignal; source: string
}
```

### 核心工具（按需导入）

| 模块 | 导出 |
|---|---|
| `core/deepseek.js` | `chatCompletion`, `DeepSeekApiError`, `ChatMessage`, `ChatResult`, `TokenUsage` |
| `core/transcript.js` | `transcriptFromLog`, `formatTranscript`, `transcriptToMarkdown`, `transcriptToJson`, `extractContentText` |
| `core/privacy.js` | `redactText(text) → { text, stats }`, `hasRedactions` |
| `core/zip.js` | `buildZip(entries)`, `sanitizeFileName` |
| `core/pdf.js` | `isLatin1Safe`, `buildSimplePdf(title, lines)`, `buildPrintHtml(title, bodyHtml)`, `escapeHtml` |
| `core/time.js` | `isPeakTime`, `nextOffPeakStart`, `DEFAULT_PEAK_WINDOWS`, `beijingDayKey`, `beijingMonthKey`, `formatBeijingTime`, `PeakWindow` |
| `core/pricing.js` | `round4`, `tokenUsageToUsageLike`（官方 usage → 计价引擎用量形状） |
| `core/price/types.js` | `ModelPrice`, `PriceTable`, `ScheduledPricing`, `PriceSheet`, `UsageLike` |
| `core/price/catalog.js` | `CATALOG_TABLE`（多厂商刊例价快照）, `VENDORS`, `vendorOf`, `prefixesOf` |
| `core/price/scrapers.js` | `parseVendorSheet`, `parseErnieSheet`, `parseZhipuBundleSheet`, `parseDoubaoSheet`, `parseKimiSheet` |
| `core/price/service.js` | `PriceService`, `BUILTIN_SHEET`, `OFFICIAL_PRICING_URL`, `DEFAULT_PEAK_WINDOWS`, `resolvePrice`, `isPeakTimeAt`, `costOf`, `parsePriceSheet`, `sanitizePriceSheet`, `fetchText` |
| `core/usage.js` | `UsageStore`, `DailyUsage`（含 cacheHitTokens）, `UsageTotal` |
| `core/http.js` | `createRouter`, `sendJson`, `readJsonBody`, `HttpError`, `HttpHandler` |
| `core/vault.js` | `SecretVault` |
| `core/ids.js` | `SessionId`, `CredentialRef`, `ScopeKey`（类型 + 构造器） |

### Harness 服务（类型见 src/types/harness.d.ts）

`ctx.sessionQuery`（listSessions/readSession/searchSessions/filterSessions）、
`ctx.commands.register(CommandDefinition)`、`ctx.settings.register(ns, schema, opts)`、
`ctx.credentials`、`ctx.systemPrompt.section/context`、`ctx.webServer`、`ctx.userQuestions`。

## 3. 模块插件形态

每个模块是独立的 Cordis 函数插件（文件 `src/modules/<id>/index.ts`）：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'companion-<id>'
export const inject = ['companion', ...其他 harness 服务]

export function apply(ctx: Context): void {
  // 注册命令 / HTTP 端点 / 事件监听（全部经 effect，自动回卷）
}
```

模块只允许 inject：`companion` + 自己用到的 harness 服务。
`ctx.companion.ready` 是 Promise：在异步处理函数内 `const { vault, usage, domain } = await ctx.companion.ready`。

## 4. 私有 HTTP API（全部 JSON，前缀 /companion）

错误响应：非 2xx + `{ "error": string }`。字节内容一律 base64。

错误语义约定：参数/历法校验失败一律 `400`；系统性故障（存储域损坏等）`500`，不与"未找到"混用。

### 模块 A（export）
- `GET  /export/sessions` → `{ sessions: SessionRecord[] }`
- `POST /export/run` `{ sessionId, format: 'markdown'|'pdf'|'json'|'png', timestamps?=true, redact?=false }`
  → `{ kind: 'file', fileName, mimeType, contentBase64 }`
  或 `{ kind: 'raster', target: 'png'|'pdf', fileName, html }`（客户端 canvas 光栅化：
  PNG 长图，或含非 Latin-1 字符的 PDF——免打印多页 PDF，无 window.print() 对话框）
  或（无光栅能力时的降级路径）`{ kind: 'print', fileName, html }`。
  HTTP 端点一律以 `raster: true` 调用服务函数（浏览器具备 canvas）；
  `format: 'png'` 仅光栅路径可用，命令面板（无 canvas）→ `400` 可读文案。
- `POST /export/batch` `{ sessionIds: string[], format, timestamps?, redact? }`
  → `{ kind: 'file', fileName, mimeType: 'application/zip', contentBase64 }`
  `sessionIds` 先去重，去重后超过 `MAX_BATCH_SESSIONS`（100）→ `400`；
  `format: 'png'` → `400`（光栅化需客户端逐张执行，不支持批量）；
  批量强制 `raster: false`：非 Latin-1 PDF 以 `.html` 入包；
  单会话读取失败跳过（404 文案含会话 id），系统性错误上抛 `500`。

### 模块 B（handoff）
- `POST /handoff/generate` `{ sessionId, template? }` → `{ summary, model }`
  `template` 可选：指定且存在时以该模板为摘要指令文本（支持 `{conversation_content}` 占位符，
  缺占位符则模板后追加"对话内容："段）；未指定/不存在回退固定契约 Prompt。
  转录按 `TRANSCRIPT_CHAR_BUDGET`（60000）截断（保首尾、中段附提示行）。
- `GET  /handoff/templates` → `{ templates: [{ name, content, updatedAt }] }`
- `POST /handoff/templates` `{ name, content }` → `{ ok: true }`
- `DELETE /handoff/templates` `{ name }` → `{ ok: true }`
- `POST /handoff/import` `{ summary, sessionId? }` → `{ ok: true, sessionId: string | null }`
  （无 sessionId = 武装给"下一个新对话"；pending 武装携带世代快照与 24h 有效期，见第 8 节）
- `GET  /handoff/armed` → `{ armed: [{ sessionId: string | null, summary, armedAt }], receipts: [{ sessionId, injectedAt }] }`
  `receipts` 为 pending 摘要的投递回执（按注入时间降序，滚动保留最近 20 条）。
- `DELETE /handoff/armed` `{ sessionId? }` → `{ ok: true }`

### 模块 C（cost）
- `GET    /cost/state` → `{ devMode, apiKeyConfigured, peakScheduling, modelRouting, budget: { dailyCny, dailySpentCny, dailyRatio, monthlyCny, spentCny, ratio, paused, reservedCny }, rules, pricing }`
  `budget` 为日/月双档：`dailyCny`/`monthlyCny` 为 0 表示该档不限；`paused` 为任一档用尽。
  `reservedCny` 为在途预授权合计（调用期权协议，见第 8 节）。
- `POST   /cost/api-key` `{ apiKey }` → `{ ok: true }`；`DELETE /cost/api-key` → `{ ok: true }`
- `POST   /cost/settings`（稀疏补丁：devMode?/peakScheduling?/modelRouting?/dailyBudgetCny?/monthlyBudgetCny?/rules?/pricing?）→ `{ ok: true }`
  `rules` 校验：数量 ≤ `MAX_CUSTOM_RULES`（20）、pattern ≤ `MAX_RULE_PATTERN_LENGTH`（200）字符、
  pattern 必须可编译为正则，违反任一 → `400`。
  `pricing`（用户自定义单价覆盖，模型 id → ModelPrice）不属于设置 schema：
  持久化到 `cost-extra` 表并经 `ctx.companion.setPricingOverrides` 应用到计价引擎。
- `GET    /cost/report?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ days: DailyUsage[], total: UsageTotal }`
  `from`/`to` 历法非法（如 `2024-13-40`）→ `400`。
- `POST   /cost/test-call` → `{ ok: true, model, latencyMs }` | 错误
- `GET    /cost/pricing` → `{ source, sourceUrl?, fetchedAt?, lastChangedAt?, scheduled, overrides, vendors }`
  动态计价引擎面板数据：定价来源（live=官方页实时抓取 / builtin=内置快照）、
  峰谷分时计划、用户自定义单价覆盖、按厂商分组的全部已知定价。
- `POST   /cost/pricing/refresh` → 同 `GET /cost/pricing`（手动触发官方定价页刷新：
  DeepSeek + 全部国产厂商）。

### 模块 D（search）
- `GET  /search?query=&from=&to=&tags=a,b&limit=50` → `{ hits: [{ session, snippet?, tags }] }`
  `limit` 封顶 `MAX_SEARCH_LIMIT`（200）；`from`/`to` 历法非法 → `400`；
  有 `tags` 时向引擎取 `min(limit*10, 1000)` 候选再本地全命中过滤，避免引擎提前截断漏命中。
- `GET  /tags?sessionId=` → `{ tags: string[] }`（缺省返回 `{ tags: Record<string, string[]> }`）
- `POST /tags` `{ sessionId, add?, remove? }` → `{ tags: string[] }`

## 5. 命令面板（ctx.commands）

| 命令 | 模块 | 说明 |
|---|---|---|
| `export` | A | 导出当前/指定会话（input: 会话 id 与格式） |
| `export-batch` | A | 批量导出为 ZIP |
| `handoff` | B | 生成交接摘要 |
| `handoff-import` | B | 导入摘要武装到新对话 |
| `usage` | C | 输出本月用量文本报告 |
| `search` | D | 检索历史对话 |
| `tag` | D | 为会话增删标签 |

命令 handler 与 HTTP 端点复用同一套模块内服务函数，不重复实现逻辑。

## 6. 客户端（src/client/）

- 入口 `src/client/index.tsx`：`export const name` + `export function apply(ctx: ClientContext)`。
- UI 只经 slots 组合（官方纪律），所有注册组件经 `SlotErrorBoundary` 包裹（渲染错误降级为提示文案，不波及宿主）：
  - `'conversation.session.header.actions'`：导出按钮、交接摘要按钮、对话内搜索按钮；
  - `'conversation.input.dock'`：导入历史摘要入口；
  - `'conversation.view'`：全局检索视图页、成本报表视图页。
- 组件从 `@deepseek-ai/dsh-client-ui-primitives` 取（Button/Input/Select/Checkbox/Modal/Textarea/Spinner/Toast/Pill）。
- 样式：CSS Modules（`*.module.css`），颜色只用 `--dsw-alias-*` 语义令牌；不写全局样式。
  例外：`convsearch/styles.ts` 以稳定 id 注入一段全局样式（浮动搜索栏 + `::highlight()` 绘制规则，
  纯 DOM 组件无法走 CSS Modules）；`raster.ts` 不注入任何样式。
- 数据：同源 `fetch('/companion/...')`（见第 4 节），封装支持 `{ signal?, timeoutMs? }`（默认 30s 超时，
  网络失败归一化为友好错误）；下载 = base64 → Blob → objectURL → `<a download>`；
  `kind: 'print'` 响应 = 新窗口写入 html 并触发打印（仅降级路径）；
  `kind: 'raster'` 响应 = 交 `raster.ts` 客户端光栅化（`target: 'png'` → PNG 长图，
  `target: 'pdf'` → 免打印多页 PDF），全程无 window.print() 对话框。
- `raster.ts`（移植自 dsh-conv-export，流式重构）：打印 HTML → 离屏舞台（剥离 script，存活期内
  为克隆源）→ 分片光栅（foreignObject 窗口 translateY 位移，片高 = A4 页高 × 2）→ 2x canvas；
  图片先内联为 data: URL。PNG 走流式编码器（片级自适应行过滤 + CompressionStream('deflate')
  增量压缩 + Blob 直下）；PDF 按页切片、JPEG 编码、零依赖组装，页界与片界对齐。
  导出带分片进度回调与取消信号；无 CompressionStream 环境退回单 canvas 截断路径（16000px）。
  仅依赖浏览器内置能力，可单测。
- `convsearch/`（移植自 dsh-conv-search）：纯 DOM 浮动查找栏，不与宿主 React 版本耦合；
  控制器随 `ctx.effect` install/uninstall（卸载清除全部高亮与按键捕获）；
  高亮经 CSS Custom Highlight API 覆盖层绘制（不触碰 React 转录 DOM）；
  MutationObserver 监视对话滚动视口，流式输出/加载更早消息时按命中锚点（文本节点 + 偏移）重同步。
  作用域纪律：只扫 `[data-conversation-scroll]`，排除 `[data-composer-seat]` 与搜索栏自身。
- 所有异步操作必须有加载态（Spinner/按钮 disabled）与成功/失败 Toast；effect 内异步需 cancelled/abort 守卫；
  轮询用"完成后再排下一次"的链式 setTimeout。
- 跨组件同步：武装摘要变更后派发 `window` 自定义事件 `companion:armed-changed`，dock 监听刷新。

## 7. 安全红线

- 网络请求只允许 `config.apiBaseUrl`（默认 https://api.deepseek.com）。
- API Key 只经 `ctx.companion.setApiKey`（AES-256-GCM 落盘）或 credentials seam；
  任何响应、日志、事件中不得出现 Key 明文（`/cost/state` 只回 `apiKeyConfigured` 布尔）。
- 不引入任何追踪/遥测代码；所有数据仅写入 companion 存储域。

## 8. 行为契约与已知局限

成本模块（模块 C）行为契约：

- **动态计价引擎**：启动时先从 `cost-extra` 表恢复上次持久化的官方价格快照与用户覆盖，
  随后立即刷新官方定价页（DeepSeek + 全部国产厂商）；抓取失败静默降级——保留上一份有效表
  （实时计价不中断，只丢失重启后"沿用上次官方价"的能力）；官方价格内容变化时持久化新快照。
  单价解析优先级：用户覆盖（最长前缀匹配）→ DeepSeek 实时/分时表 → 厂商实时表 → 内置刊例价目录。
  费用一律按调用时刻解析（峰谷分时感知）；缓存命中的输入按 `inputCacheHit` 折扣价计。
- **日/月双档预算闸门**：调用前检查先日后月，任一档用尽即拦截非必要调用
  （`INSUFFICIENT_BALANCE`）；必要调用放行但持续告警。80% 告警不拦截，100% 告警并暂停。
  告警按「档位 + 周期键」进程内去重（`companion/budget-alert` 事件携带 `tier`/`period`），
  跨日/跨月自动重新告警；已花费短 TTL 内存缓存，跨日/跨月失效。
- **调用期权协议（预授权-结算两阶段提交）**：网关 invoke 时按估算金额 reserve 锁定额度，
  调用成功 settle(actual) 入账并释放差额、失败 release 全额释放。可用额度恒为
  `budget − spent − Σ在途预留`，不变式收紧为「最终支出 ≤ 预算 + Σ在途(实际−估算)⁺」。
  估算经 P95 估值器（模型 × 输入长度分桶滚动样本，冷启动用上界）；预留 TTL = apiTimeoutMs +
  30s，惰性清扫回收孤儿预留（无空闲定时器）；settle 同步推进 spent 缓存，15s TTL 缓存由此
  退化为全量扫描兜底。预授权投影口径（spent + 在途 + 估算）触发告警时文案标注「含在途调用预授权」。
  旧 TOCTOU 局限（并发集体过闸，超支 ≈ 并发数 × 单次全额）收敛为估算误差量级。
- **预算闸门覆盖延迟队列**：drain 执行每个排队任务前复检预算；暂停期间排队任务以
  `INSUFFICIENT_BALANCE` 被逐个 reject，延迟队列不是闸门旁路。预授权在任务真正执行
  （invoke）时锁定：排队期间不占额度，执行时的额度竞争由预留协议收敛。
- **调度器**：定时器按需一次性精确唤醒（队列空时无定时器）；队列容量上限 100，
  满时拒绝入队；执行前检查调用方 `signal`，已中止直接 reject 不发真实请求。
  高峰窗口优先取计价引擎对官方定价页的实时解析（`peakWindows`），空表/异常回退内置缺省窗口，
  调度永远有确定的窗口可用。
- **节省额口径**：`savedCny` 仅当 modelRouting 开启且实际路由到更便宜模型时计入；
  `deferredCalls` 仅当调度器真实延迟时计入（网关不预判）。
- **告警与记账健壮性**：告警写盘失败不阻塞调用、不永久吞告警；API 调用成功后的记账失败降级为
  warning notice，不反转成功结果。

交接模块（模块 B）行为契约：

- **世代门闩（generation latch）**：pending 武装（武装给"下一个新对话"）在 arm 时刻快照
  全部已知会话 ID（`knownSessions`）并携带 24h 有效期（`expiresAt`）。系统提示词装配回调
  只向「快照之外」且带具体会话作用域的装配投递摘要——旧会话无论怎么重建都在快照内，
  天然免疫误投递；无作用域的全局装配不消费摘要。超时未投递自动作废（防僵尸注入）。
  投递成功写入回执（`handoff-receipts` 表，按会话覆盖、滚动保留 20 条），
  `GET /handoff/armed` 附带回执供 dock 展示「已注入会话 X」。
  旧格式记录（无快照字段）回退 v0.1 近似：注入下一次系统提示词装配；
  快照失败（会话引擎异常）同样退化为无快照武装，不阻塞武装操作。

导出模块（模块 A）行为契约：

- **光栅路径归属**：PNG 长图与含非 Latin-1 字符的 PDF 由客户端 canvas 光栅化（kind:'raster'），
  服务端只产出打印 HTML；命令面板等无 canvas 环境：PNG → 400 可读文案，PDF → kind:'print' 降级。
- **批量纪律**：批量打包在服务端完成，强制 raster=false；PNG 不支持批量（400）；
  非 Latin-1 PDF 以 `.html` 入包，不阻塞其余会话。
- **分片光栅（tiled rasterization）**：整篇对话按片高（A4 页高 × 2）逐片光栅化，
  片内经 foreignObject 窗口（translateY 位移）渲染到独立 2x canvas；页界与片界对齐
  （页永不跨片），PDF 页数无上限，峰值内存恒为单片量级。导出带分片进度回调与取消信号。
- **流式 PNG 编码**：逐片取像素 → 逐行 PNG 过滤（片级自适应选过滤器，
  跨片行连续性经原始行携带）→ `CompressionStream('deflate')`（zlib，恰为 PNG 规范格式）
  增量压缩 → Blob 直下；PNG 规范无高度上限，产品理智上限 200,000 CSS px（≈176 页 A4）。
  无 CompressionStream 的环境退回旧单 canvas 截断路径（16000px）。
- **光栅引擎限制**：foreignObject 内脚本不执行（服务端打印页的自动打印 script 已在离屏舞台剥离）；
  外部图片先内联为 data: URL，不可达图片直接移除。

核心服务行为契约：

- `ready` 失败后可重试（存储域恢复后下次访问重新 open），并挂兜底 catch 杜绝未处理 rejection。
- HTTP 请求体读取有 30s 超时（408）；错误响应路径对已发送头的连接直接结束/销毁，不产生未处理 rejection。
- 峰谷窗口支持跨午夜（`start > end`）；脱敏覆盖带分隔符的手机号/银行卡，身份证正则含生日段合法性校验。
