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
  （无 sessionId = 武装给"下一个新对话"）
- `GET  /handoff/armed` → `{ armed: [{ sessionId: string | null, summary, armedAt }] }`
- `DELETE /handoff/armed` `{ sessionId? }` → `{ ok: true }`

### 模块 C（cost）
- `GET    /cost/state` → `{ devMode, apiKeyConfigured, peakScheduling, modelRouting, budget: { dailyCny, dailySpentCny, dailyRatio, monthlyCny, spentCny, ratio, paused }, rules, pricing }`
  `budget` 为日/月双档：`dailyCny`/`monthlyCny` 为 0 表示该档不限；`paused` 为任一档用尽。
  已花费有短 TTL 内存缓存（跨日/跨月失效）。
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

### 模块 E（trace）
- `GET  /trace/sessions` → `{ sessions: SessionRecord[] }`
- `GET  /trace/derive?sessionId=` → `{ trace, anomalies, stats, slowest?, costliest? }`
  从会话日志派生轨迹：工具节点配对（已闭合节点不重复回填）、重试合并、
  异常标注（retry-loop / token-explosion / cache-miss / infinite-loop）。
- `POST /trace/ingest` `{ id?, trace }` → 同上（摄入 Harness 原生轨迹 JSON）。
- `GET  /trace/get?id=` → 同上（读取已摄入轨迹）。
- `POST /trace/diff` `{ old: { id?|sessionId? }, new: { id?|sessionId? }, format?='json'|'html' }`
  → `{ format: 'json', entries }` 或 `{ format: 'html', fileName, html }`（自包含对比报告）。
- `GET  /trace/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ days: TraceDailyStats[], baseline? }`
  日聚合趋势 + 历史基准线（偏离过大由客户端告警）。

### 模块 F（prompt）
- `GET    /prompt/versions` → `{ versions: PromptVersion[] }`
- `POST   /prompt/versions` `{ content, note?, tags? }` → `{ version }`（自动递增版本号）
- `POST   /prompt/rollback` `{ version, note? }` → `{ version }`（回滚生成新版本）
- `POST   /prompt/tags` `{ version, add?, remove? }` → `{ version }`
- `POST   /prompt/ab-test` `{ promptA, promptB, cases?, model? }` → `{ model, a, b, ratings }`
  批量用例逐条跑两侧，汇总成功率/平均输出长度/平均延迟/总 Token。
- `POST   /prompt/rate` `{ winner: 'A'|'B'|'tie', promptA?, promptB? }` → `{ ok: true, ratings }`
- `GET    /prompt/templates` → `{ templates: PromptTemplate[] }`（内置 + 用户，同名用户覆盖内置）
- `POST   /prompt/templates` `{ name, category?, content }` → `{ ok: true }`
- `DELETE /prompt/templates` `{ name }` → `{ ok: true }`
- `POST   /prompt/render` `{ template, variables? }` → `{ rendered }`（`{{var}}` 插值）
- `POST   /prompt/codegen` `{ prompt, language: 'python'|'nodejs'|'curl', model? }` → `{ code }`
- `POST   /prompt/validate` `{ prompt, schema, cases?, model? }`
  → `{ model, total, compliant, complianceRate, runs }`（JSON Schema 批量校验，逐条标注违规字段）。

### 模块 G（arena）
- `GET    /arena/models` → `{ models: ArenaModelInfo[] }`（含外部厂商 Key 配置状态，不回明文）
- `POST   /arena/keys` `{ modelId, apiKey, baseUrl? }` → `{ ok: true }`（AES-256-GCM 加密落盘）
- `DELETE /arena/keys` `{ modelId }` → `{ ok: true }`
- `POST   /arena/compare` `{ prompt, models }` → `{ prompt, results }`
  最多 `MAX_COMPARE_MODELS`（5）个模型并行；DeepSeek 走核心服务记账，外部走 OpenAI 兼容协议直连。
- `POST   /arena/leaderboard` `{ models, cases, format?='json'|'markdown'|'html' }`
  → `{ format: 'json', rows }` 或 `{ format, fileName, content }`；
  用例封顶 `MAX_LEADERBOARD_CASES`（30）；综合得分 = 成功率/延迟分位/Token/成本/合规率加权。
- `GET    /arena/recommend?taskType=&budgetPerCallCny=&latency=`
  → `{ taskType, taskTypeLabel, recommendations }`（峰谷定价感知，附推荐理由与单次成本估算）。

### 模块 H（orchestrator）
- `GET/POST /orchestrator/pipelines`、`DELETE /orchestrator/pipelines` `{ id }`
  步骤数封顶 `MAX_PIPELINE_STEPS`（20）；`POST` 携带 `id` 为更新。
- `GET  /orchestrator/pipelines/yaml?id=` → `{ id, yaml }`（自动生成 YAML 配置）。
- `POST /orchestrator/runs` `{ pipelineId }` → `202 { runId, status }`
  后台异步执行，立即返回；进度经 `GET /orchestrator/runs/get` 轮询。
- `POST /orchestrator/runs/resume` `{ runId }` → 断点续跑（仅 paused/failed/cancelled 可恢复，
  已完成步骤的中间结果直接复用不重跑）。
- `POST /orchestrator/runs/pause` / `/cancel` `{ runId }` → `{ ok: true }`
- `GET  /orchestrator/runs?pipelineId=` → `{ runs: [{ id, pipelineId, status, startedAt, endedAt, message, progress: { done, total } }] }`
- `GET  /orchestrator/runs/get?id=` → `{ run }`（含各步骤中间结果）；`DELETE /orchestrator/runs` `{ id }`
- `GET  /orchestrator/queue` → `{ tasks, counts }`；`GET /orchestrator/queue/counts` → `{ counts }`
- `POST /orchestrator/queue` `{ name, prompt, model?, priority?, deadline?, failurePolicy? }` → `{ task }`
  未完成任务封顶 `MAX_QUEUE_TASKS`（50）。
- `POST /orchestrator/queue/cancel|pause|resume` `{ id }`；
  `POST /orchestrator/queue/batch` `{ action: 'pause'|'resume'|'cancel' }` → `{ ok: true, changed }`；
  `DELETE /orchestrator/queue` `{ id }`（运行中任务需先取消）。
- `GET/POST /orchestrator/jobs`、`DELETE /orchestrator/jobs` `{ id }`
  定时任务封顶 `MAX_JOBS`（20）；`schedule` 接受标准 5 字段 Cron 或中文自然语言
  （「每天凌晨 2 点」「每隔 30 分钟」等），保存时统一转为 Cron；`offPeakOnly: true` 仅空闲时段执行。
- `POST /orchestrator/jobs/toggle` `{ id, enabled }` → `{ job }`
- `GET  /orchestrator/jobs/runs?jobId=` → `{ runs: ScheduledRun[] }`（历史归档）
- `POST /orchestrator/parse-schedule` `{ text }` → `{ cron, nextRunAt }`（解析预检）。

### 模块 J（security）
- `GET    /security/keys` → `{ keys: [{ name, note, createdAt, lastUsedAt, scope, configured, rotationDue }], rotationDays, activeConfigured }`
  安全红线：不回传 Key 明文。
- `POST   /security/keys` `{ name, apiKey, note?, scope? }` → `{ key }`（加密落盘，同名覆盖）
- `POST   /security/keys/activate` `{ name }` → `{ ok: true }`（切换激活 Key）
- `DELETE /security/keys` `{ name }` → `{ ok: true }`
- `POST   /security/keys/leak-check` `{ content }` → `{ leaked, safe }`（泄露检测）
- `GET    /security/keys/rotation` → `{ due: [{ name, ageDays }], thresholdDays }`（30 天轮换提醒）
- `GET    /security/audit?from=&to=&model=&status=&limit=` → `{ entries: AuditEntry[] }`
  Prompt 摘要（前 100 字）落盘前已经 DLP 规则脱敏。
- `GET    /security/audit/export?format=csv|json&from=&to=` → `{ format, fileName, content }`
- `GET    /security/dlp/state` → `{ settings, rules }`
- `POST   /security/dlp/settings` `{ enabled?, strict? }` → `{ settings }`
  严格模式下 beforeCall 钩子检测到敏感内容直接抛 403 拦截调用。
- `POST   /security/dlp/rules` `{ name, pattern, enabled? }` → `{ rules }`
  自定义规则封顶 `MAX_CUSTOM_RULES`（20）；内置规则不可修改/删除，仅可切换启用。
- `POST   /security/dlp/rules/toggle` `{ id, enabled }`；`DELETE /security/dlp/rules` `{ id }`
- `POST   /security/dlp/scan` `{ text }` → `{ findings, clean, settings }`（发送前预检）
- `GET    /security/report?from=YYYY-MM-DD&to=YYYY-MM-DD`
  → `{ from, to, totalCalls, totalCostCny, totalTokens, modelShare, blocks, blockTotal, alerts }`
- `GET    /security/report/export?from=&to=` → `{ format: 'html', fileName, content }`
  自包含 HTML，客户端经打印管线另存 PDF 提交审计。

集成点：`ctx.companion.addCallHook({ beforeCall, afterCall })`（core/service.ts）——
beforeCall 抛错即拦截调用（DLP 严格模式）；afterCall best-effort 记录审计与异常告警
（单次 Token > 100k、60 秒内调用 > 30 次）。

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
| `trace` | E | 分析会话执行轨迹（耗时/Token/异常） |
| `prompt` | F | 查看 Prompt 版本历史 |
| `tasks` | H | 查看任务队列与定时任务概览 |

命令 handler 与 HTTP 端点复用同一套模块内服务函数，不重复实现逻辑。

## 6. 客户端（src/client/）

- 入口 `src/client/index.tsx`：`export const name` + `export function apply(ctx: ClientContext)`。
- UI 只经 slots 组合（官方纪律），所有注册组件经 `SlotErrorBoundary` 包裹（渲染错误降级为提示文案，不波及宿主）：
  - `'conversation.session.header.actions'`：导出按钮、交接摘要按钮、对话内搜索按钮；
  - `'conversation.input.dock'`：导入历史摘要入口；
  - `'conversation.view'`：全局检索视图页、成本报表视图页、轨迹分析视图页、
    Prompt 工作台视图页、多模型竞技场视图页、任务编排视图页、安全与审计视图页。
- 组件从 `@deepseek-ai/dsh-client-ui-primitives` 取（Button/Input/Select/Checkbox/Modal/Textarea/Spinner/Toast/Pill）。
- 样式：CSS Modules（`*.module.css`），颜色只用 `--dsw-alias-*` 语义令牌；不写全局样式。
  例外：`convsearch/styles.ts` 以稳定 id 注入一段全局样式（浮动搜索栏 + `::highlight()` 绘制规则，
  纯 DOM 组件无法走 CSS Modules）；`raster.ts` 不注入任何样式。
- 数据：同源 `fetch('/companion/...')`（见第 4 节），封装支持 `{ signal?, timeoutMs? }`（默认 30s 超时，
  网络失败归一化为友好错误）；下载 = base64 → Blob → objectURL → `<a download>`；
  `kind: 'print'` 响应 = 新窗口写入 html 并触发打印（仅降级路径）；
  `kind: 'raster'` 响应 = 交 `raster.ts` 客户端光栅化（`target: 'png'` → PNG 长图，
  `target: 'pdf'` → 免打印多页 PDF），全程无 window.print() 对话框。
- `raster.ts`（移植自 dsh-conv-export）：打印 HTML → 离屏舞台（剥离 script）→ SVG foreignObject →
  2x canvas；图片先内联为 data: URL；PDF 按 A4 页高切片、JPEG 编码、零依赖组装。
  高度上限 16000px（canvas 限制）。仅依赖浏览器内置能力，可单测。
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
- **预算闸门覆盖延迟队列**：drain 执行每个排队任务前复检预算；暂停期间排队任务以
  `INSUFFICIENT_BALANCE` 被逐个 reject，延迟队列不是闸门旁路。
- **调度器**：定时器按需一次性精确唤醒（队列空时无定时器）；队列容量上限 100，
  满时拒绝入队；执行前检查调用方 `signal`，已中止直接 reject 不发真实请求。
  高峰窗口优先取计价引擎对官方定价页的实时解析（`peakWindows`），空表/异常回退内置缺省窗口，
  调度永远有确定的窗口可用。
- **节省额口径**：`savedCny` 仅当 modelRouting 开启且实际路由到更便宜模型时计入；
  `deferredCalls` 仅当调度器真实延迟时计入（网关不预判）。
- **告警与记账健壮性**：告警写盘失败不阻塞调用、不永久吞告警；API 调用成功后的记账失败降级为
  warning notice，不反转成功结果。
- **已知局限（TOCTOU）**：预算检查在调用前、记账在调用后，并发调用可能在临界点集体通过闸门，
  超支量级 ≈ 并发调用数 × 单次调用费用；已花费短 TTL 缓存属同一量级的已知近似。

导出模块（模块 A）行为契约：

- **光栅路径归属**：PNG 长图与含非 Latin-1 字符的 PDF 由客户端 canvas 光栅化（kind:'raster'），
  服务端只产出打印 HTML；命令面板等无 canvas 环境：PNG → 400 可读文案，PDF → kind:'print' 降级。
- **批量纪律**：批量打包在服务端完成，强制 raster=false；PNG 不支持批量（400）；
  非 Latin-1 PDF 以 `.html` 入包，不阻塞其余会话。
- **光栅引擎限制**：foreignObject 内脚本不执行（服务端打印页的自动打印 script 已在离屏舞台剥离）；
  外部图片先内联为 data: URL，不可达图片直接移除；光栅高度上限 16000px。

核心服务行为契约：

- `ready` 失败后可重试（存储域恢复后下次访问重新 open），并挂兜底 catch 杜绝未处理 rejection。
- HTTP 请求体读取有 30s 超时（408）；错误响应路径对已发送头的连接直接结束/销毁，不产生未处理 rejection。
- 峰谷窗口支持跨午夜（`start > end`）；脱敏覆盖带分隔符的手机号/银行卡，身份证正则含生日段合法性校验。
