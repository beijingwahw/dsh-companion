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
| `core/retrieval/engine.js` | `HybridRetrievalIndex`（BM25 + trigram 向量 + RRF 融合）, `buildIndexedDoc`, `sanitizeIndexedDoc`, `buildSnippet`, `IndexedDoc`, `HybridHit` |
| `core/retrieval/tokenize.js` | `tokenize`（词法分词）, `charTrigrams`（字符三元组计数）, `fnv1a32`（FNV-1a 哈希） |
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
- `GET  /export/turns?sessionId=` → `{ turns: [{ index, role, time, preview }] }`
  （回合选择面板数据源：index 为回合下标（0 起，与导出请求的 turns 数组对应）、
  preview 为折叠空白后截断 160 字符的纯文本预览。）
- `POST /export/run` `{ sessionId, format: 'markdown'|'pdf'|'json'|'png', timestamps?=true, redact?=false, turns?: number[] }`
  → `{ kind: 'file', fileName, mimeType, contentBase64 }`
  或 `{ kind: 'raster', target: 'png'|'pdf', fileName, html }`（客户端 canvas 光栅化：
  PNG 长图，或含非 Latin-1 字符的 PDF——免打印多页 PDF，无 window.print() 对话框）
  或（无光栅能力时的降级路径）`{ kind: 'print', fileName, html }`。
  HTTP 端点一律以 `raster: true` 调用服务函数（浏览器具备 canvas）；
  `format: 'png'` 仅光栅路径可用，命令面板（无 canvas）→ `400` 可读文案。
- `POST /export/run` 的 `turns`（回合级选择，吸收自 dsh-conv-export）：
  非空非负整数数组（去重升序规范化），违例 `400`；省略 = 导出全部回合
  （客户端全选状态省略该字段，请求体最小）；越界下标静默忽略
  （append-only 日志下旧回合下标稳定，宽容处理列表与导出间的漂移）；
  过滤后无可导出回合 → `400`。批量导出不支持该字段。
- `POST /export/batch` `{ sessionIds: string[], format, timestamps?, redact? }`
  → `{ kind: 'file', fileName, mimeType: 'application/zip', contentBase64 }`
  `sessionIds` 先去重，去重后超过 `MAX_BATCH_SESSIONS`（100）→ `400`；
  `format: 'png'` → `400`（光栅化需客户端逐张执行，不支持批量）；
  批量强制 `raster: false`：非 Latin-1 PDF 以 `.html` 入包；
  单会话读取失败跳过（404 文案含会话 id），系统性错误上抛 `500`。

### 模块 B（handoff）
- `POST /handoff/generate` `{ sessionId, template?, focus? }` → `{ summary, model, stats?, quality }`
  `quality` 为纯本地摘要体检（`modules/handoff/quality.js`）：词元覆盖（源转录头部显著词在场率 +
  `missingTerms` 漏词清单；角色标签等格式词剔除）、四段式结构完整（核心结论/已解决/背景/待办）、
  长度纪律（500 字预算，每超 10% 扣 1 分）、压缩充分（源 ≥1000 字时要求 ≥3× 压缩比；短源中立）。
  verdict 三档 strong/fair/weak；与生成模型无关——换模型/模板/Prompt 后同一把尺子可横向比较。
  `template` 可选：指定且存在时以该模板为摘要指令文本（支持 `{conversation_content}` 占位符，
  缺占位符则模板后追加"对话内容："段）；未指定/不存在回退固定契约 Prompt。
  `focus` 可选（轴线 2）：查询聚焦主题（≤ `FOCUS_MAX_CHARS` 字符），摘要定向保留相关内容。
  转录在 `TRANSCRIPT_CHAR_BUDGET`（60000）内：单发路径；
  超预算：map-reduce 分层摘要（分块抽取 → 段级缓存复用 → 递归归并，不再丢弃中段），
  响应附 `stats`（层数 / 分块数 / 缓存命中数 / LLM 调用数）。
- `GET  /handoff/templates` → `{ templates: [{ name, content, updatedAt }] }`
- `POST /handoff/templates` `{ name, content }` → `{ ok: true }`
- `DELETE /handoff/templates` `{ name }` → `{ ok: true }`
- `POST /handoff/import` `{ summary, sessionId?, sourceSessionId? }` → `{ ok: true, sessionId: string | null }`
  （无 sessionId = 武装给"下一个新对话"；pending 武装携带世代快照与 24h 有效期，见第 8 节；
  `sourceSessionId` 可选（轴线 2）：摘要来源会话，记录继承图谱边——pending 悬边待投递解析）
- `GET  /handoff/lineage?sessionId=` → `{ ancestors: LineageNode[], descendants: LineageNode[] }`
  `LineageNode = { sessionId, depth, excerpt, linkedAt }`（depth 自 1 起算，excerpt 为传播所用摘要首行摘录）。
  上下文血缘图谱（轴线 2）：摘要跨会话传播链路的祖先/后代，环安全遍历、近源优先。
- `GET  /handoff/armed` → `{ armed: [{ sessionId: string | null, summary, armedAt }], receipts: [{ sessionId, injectedAt }] }`
  `receipts` 为 pending 摘要的投递回执（按注入时间降序，滚动保留最近 20 条）。
- `DELETE /handoff/armed` `{ sessionId? }` → `{ ok: true }`
- `GET  /handoff/context-health?sessionId=` → `{ sessionId, turns, estimatedTokens, windowTokens, ratio, avgTurnTokens, remainingTurns, level, suggestion }`
  上下文压力监测（轴线 6）：token 估算（CJK×0.6 + 其余÷4 启发式，含每回合固定开销 6 token，
  窗口 65536、输出预留 4096）、耗尽预测（近 10 回合平均增速外推 `remainingTurns`，
  不足 2 回合返回 null）、四级健康分级 `level`（healthy <50% / watch ≥50% / advice ≥75% /
  critical ≥90%）与交接建议文案。`sessionId` 必填（空串 `400`）。

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
- `GET    /cost/forecast?days=30&horizon=7` → `{ points: [{ day, forecastCny }], monthEndProjectionCny?, ... }`
  预测性成本智能（轴线 3）：OLS 线性回归外推未来 `horizon` 天支出 + 月末投影。
  `days` ∈ [1, 365]（回看窗口），`horizon` ∈ [1, 30]；非法参数 `400`。
- `GET    /cost/anomalies?days=30` → `{ anomalies: [{ day, spendCny, zScore, ... }], baseline, mad }`
  异常检测：中位数 + MAD 鲁棒 z 分数（|z| > 3 判异常），对离群日与新装用户冷启动稳健。
- `POST   /cost/what-if` `{ days?, callVolumeFactor?, cacheHitRatio?, modelShift? }` → what-if 模拟结果
  场景沙盘：`callVolumeFactor` ∈ (0, 100]（调用量倍数）、`cacheHitRatio` ∈ [0, 1]
  （缓存命中率）、`modelShift`（模型迁移，如 `{ from: 'deepseek-chat', to: 'deepseek-reasoner' }`）；
  单价按计价引擎实时解析（峰谷感知）。任一参数非法 → `400`。
- `GET    /cost/attribution?days=7` → 按模型分解的费用变化（当前窗口 vs 上一等长窗口）
- `GET    /cost/advice` → `{ snapshot, cards, potentialSavingCny, summary }`
  节能顾问（`modules/cost/advice.js`，纯函数决策层）：快照由用量表 + forecast 引擎 + 当前价表组装，
  输出按严重度与节省金额排序的建议卡——`budget-pacing`（月末投影超支 → 剩余天数摊平日预算）、
  `off-peak-shift`（高峰时段可延迟占比 × 价差 → 峰谷迁移月度节省）、`cache-uplift`（命中率 +10 点
  的节省潜力）、`model-shift`（同厂商低价候选，保守提示不自动切换）。零副作用——采纳与否由用户决定。
  变化归因：定位"这个月多花的钱去哪了"（各模型用量/单价贡献分解）。
  `days` ∈ [1, 90]。

### 模块 D（search）
- `GET  /search?query=&from=&to=&range=&tags=a,b&limit=50` → `{ hits: [{ session, snippet?, tags }] }`
  `range` 为自然语言时间范围（`modules/search/timeRange.js`）：`近7天` / `昨天` / `上周`（周一起点）/
  `本月` / `last week` 等中英表达 → 北京时间自然日对齐的闭区间；仅在未显式给 from/to 时生效，
  未识别的表达静默忽略。
  `limit` 封顶 `MAX_SEARCH_LIMIT`（200）；`from`/`to` 历法非法 → `400`；
  有 `tags` 时向引擎取 `min(limit*10, 1000)` 候选再本地全命中过滤，避免引擎提前截断漏命中。
- `GET  /tags?sessionId=` → `{ tags: string[] }`（缺省返回 `{ tags: Record<string, string[]> }`）
- `POST /tags` `{ sessionId, add?, remove? }` → `{ tags: string[] }`

### 模块 E（retrieval）
- `GET  /retrieval/search?query=&from=&to=&limit=50` → `{ hits: [...], negations? }`
  查询支持负向词修饰符（`core/retrieval/negate.js`）：`-词` 从查询剥离进排除清单，命中排除词元
  （与索引同源分词）的文档在排序前整体出局——排除是硬约束不是降权；`negations` 字段回传排除词
  原形（溯源可回退）。裸 `-` 不视为修饰符。
  纯本地混合检索（轴线 1）：BM25 词法 + 字符 trigram 哈希向量语义近似 + RRF 倒数排名融合。
  `query` 必填（空串 `400`）；`from`/`to` 支持毫秒时间戳或 `YYYY-MM-DD`（北京时间，
  from 取当日零点、to 取当日末尾），历法非法或 `from > to` → `400`；`limit` 封顶 200。
  `snippet` 仅头部命中（前 12 条）生成（读取原文定位最佳查询窗口，控制检索延迟）。
- `GET  /retrieval/status` → `{ indexed, lastSyncAt }`（索引规模与最近对账时间）
- `POST /retrieval/reindex` → `{ ok: true, indexed, updated, removed }`（强制全量对账重建）
- `GET  /retrieval/suggest?q=` → `{ suggestions: RetrievalSuggestion[] }`
  查询建议（轴线 14）：语料前缀补全 + 共现续写 + 点击画像加权；空 `q` 合法（返回空数组，
  输入框每键一请求）。
- `POST /retrieval/feedback` `{ query, sessionId }` → `{ ok: true, clicks }`
  相关性反馈学习（轴线 11）：查询词并入该会话点击画像（饱和计数 + 90 天半衰 + 35% 加成封顶）；
  `sessionId` 不在索引中 → `404`。
- `GET  /retrieval/clusters?minSize=1` → 知识地图（轴线 13）：全部会话质心贪心聚类的主题簇
  （簇标签 / 成员数 / 代表会话）；`minSize` 正整数，非法 `400`。
- `GET  /retrieval/blindspots` → `{ totalMisses, blindSpots: [{ anchor, searches, queries[], lastAt, score, advice }], summary }`
  检索盲区分析（轴线 19）：零命中（且救援失败）查询的词元级聚合——评分 =
  搜索次数 × log(1 + 首末停留天数) × 新近度（90 天半衰），孤例（< 2 次）不推送。
- `GET  /retrieval/insights` → `{ cards: [{ category, severity, text, action?, source }], summary, generatedAt }`
  主动脉搏（轴线 18）：主动洞察引擎——信号提供者注入式聚合盲区缺口 / 反馈学习画像 /
  索引健康三类信号源，severity（critical/watch/info）排序、封顶 6 条、单源失败静默隔离。

### 模块 F（knowledge）
- `GET  /knowledge/status` → `{ sessions, entities, updated, removed, lastSyncAt }`
  实体倒排索引状态（已分析会话数 / 实体总数 / 最近对账增删量）。
- `GET  /knowledge/entities?type=&limit=50` → `{ entities: [{ name, type, sessionCount, totalFreq, sampleSessions }] }`
  全局实体图谱（按覆盖会话数降序）。`type` ∈ 六类实体之一（command/path/tech/code/term/version，
  非法值 `400`）；`limit` 封顶 200。
- `GET  /knowledge/analyze?sessionId=` → `{ sessionId, analyzed, entities, suggestedTags }`
  单会话知识资产：实体列表（按显著性 = freq × 类型权重 × IDF 降序，含全局覆盖数）
  与建议标签（头部实体名，仅建议不写入——尊重现有标签系统与用户判断）。
  `sessionId` 必填（空串 `400`）。
- `GET  /knowledge/related?sessionId=&limit=5` → `{ sessionId, related: [{ sessionId, title?, createdAt, score, sharedEntities }] }`
  关联会话推荐：实体重叠 + IDF 加权 + 余弦式归一（除以两会话实体集规模的几何平均），
  `sharedEntities` 为贡献最大的共享实体（最多 5 个）。`limit` 封顶 20。
- `POST /knowledge/reanalyze` → `{ ok: true, sessions, entities, updated, removed }`
  强制全量重建索引（清空版本与实体记录后重新分析全部会话）。
- `GET  /knowledge/trends?days=14&limit=12` → `{ days, generatedAt, trends: [{ name, type, direction, momentum, recentSessions, previousSessions, recentFreq, previousFreq, series }] }`
  主题趋势演化（轴线 7）：实体动量 =（近 `days` 天频次 − 上一等长窗口频次）/（上一窗口频次 + 1），
  方向判定 rising（momentum > 0.5 且近窗口 ≥2 会话）/ falling（上一窗口 ≥2 会话且（近窗口为 0 或
  momentum < −0.6））/ stable（其余）；`series` 为最近 8 周逐周覆盖会话数（旧→新）。
  排序键 |momentum| × log(1 + 总频次)（小样本噪声抑制）。
  `days` ∈ [1, 90]（默认 14），`limit` ∈ [1, 50]（默认 12）；非法参数 `400`。
- `GET  /knowledge/cognition` → `{ intentions: { due, upcoming }, reviews: DueReview[], plan?, forecast?, rhythm?, stats }`
  认知总览（认知三轴 + 元认知三轴，单次请求驱动客户端认知面板）：到期/即将到来的前瞻意图、
  到期复习卡片与认知统计；`plan`（轴线 25 负荷计划）、`forecast`（轴线 23 遗忘预测报告）、
  `rhythm`（轴线 24 节律摘要）为元认知扩展字段（旧客户端可忽略）。
- `GET  /knowledge/intentions` → `{ due, upcoming }`（完整意图清单：到期 30 条 + 即将到来 15 条）
  前瞻记忆引擎（轴线 20）：句子级扫描提取未兑现意图——时间标记（明天=1 天/后天=2/周末=5/
  下周=7/下个月=30，模糊标记 回头/以后/有空 取 7 天缺省视界）× 意图动词（试试/优化/修复/
  部署…）共现；独立 TODO 标记（TODO/别忘了/记得要）无需动词共现、取 1 天视界；问句排除
  （「怎么修复？」是求助不是承诺）；到期即浮现（`createdAt + horizonDays ≤ now`），
  超期越久排序越靠前。切分保留终结符（捕获组）以正确判定问句。
- `POST /knowledge/review/grade` `{ episodeId, remembered }` → `{ ok: true, stage, nextDueAt, nextIntervalDays, ease }`
  间隔重复巩固（轴线 21 + 24，SM2 精简版）：片段即复习卡片，间隔阶梯 1/3/7/14/30/60 天 ×
  当前节律系数 ease（四舍五入、至少 1 天）——「记得」升档、「忘了」归零次日重来；新片段创建
  1 天后首复习（先沉一晚）。评分同时计入节律闭环（轴线 24）：累计命中率偏离 85% 目标时
  按比例调整 ease（∈ [0.5, 2.0]，样本不足 3 次不动系数），响应返回更新后的系数；
  复习状态记录排程时的 ease，保证到期时间纯函数重算与排程一致。
  `episodeId` 格式非法 `400`，不在片段索引中 `404`（可能已被重新分析）。
- `GET  /knowledge/analogy?q=` → `{ queryShape, analogies: [{ episodeId, sessionId, title?, problem, solution, score, sharedConstraints, sharedResolutions, crossDomain, termOverlap, createdAt }], summary }`
  类比检索（轴线 22）：把问题抽象为结构形状（约束类别 × 解法类别），做形状级匹配——
  相似度 = 0.7 × 约束重叠系数 + 0.3 × 解法重叠系数（重叠系数 = 交集/较小集，
  查询侧偶发约束不稀释同构判定）；主题词元重叠低 + 形状分高 → **跨域类比**
  （领域不同而结构相同——主题检索永远找不到的先例），重叠高 → 同域先例。
  `q` 必填且 ≤500 字符；查询识别不出结构时返回空结果 + 引导文案。
- `GET  /knowledge/pulse` → `{ cards, summary, generatedAt }`
  认知脉搏（轴线 18 的认知信号源）：到期意图（critical/watch）、到期复习、片段资产
  （空库/积累中/跨域就绪三态）、遗忘预测（critical/watch/info/静默四态）、记忆节律
  （显著偏离才播报，冷启动静默）、认知负荷（仅顺延发生时开口）六类信号提供者，
  与检索侧脉搏在客户端合并。
- `GET  /knowledge/forecast` → `{ now, ease, critical: ForgettingForecast[], warning: ForgettingForecast[], criticalCount, warningCount, stableCount, summary }`
  遗忘预测引擎（轴线 23）：为全库每条片段计算连续保持率 `R(t) = exp(-t/S)`——
  稳定性 S = 档位间隔 × 当前节律 ease × 标定因子 `1/-ln(0.7)`（保证到期时刻的
  预测保持率恰等于 70% 阈值，与轴线 21 调度数学自洽）；三档分区：≥70% 稳定 /
  30–70% 滑落区（最佳巩固窗口）/ <30% 深度遗忘区；`warning` 按保持率升序
  （最危险在前）、`critical` 按创建时间新→旧（最近丢失的最相关），每桶封顶 10 条；
  `daysToThreshold` = S·ln(R/T)（距跌破阈值的剩余天数，负 = 已跌破）。
  覆盖从未复习的片段（按会话创建时间起算）——旧知识的衰减无人看管问题在此解决；
  预测用当前 ease 重算已按历史 ease 排程的日程 → 节律漂移预警（日程未到期，
  记忆已滑落）。
- `GET  /knowledge/rhythm` → `{ profile: { remembered, forgotten, ease, updatedAt }, summary, hitRate, targetHitRate, ladder: [{ stage, baseDays, adaptedDays }] }`
  记忆节律画像（轴线 24）：闭环比例控制器以 85% 命中率（合意困难工作点）为目标——
  `ease += (hitRate − 0.85) × 1.5`，收敛区间 [0.5, 2.0]，样本不足 3 次冷启动保护；
  `ladder` 为投影间隔阶梯（标准档位 → 你的档位）；存储净化：计数非法整体丢弃，
  ease 越界收敛修复。
- `GET  /knowledge/load?cap=8` → `{ cap, totalDue, today: [{ review, retention, priority, reason }], deferredCount, health, summary }`
  认知负荷调度（轴线 25）：到期复习分诊打分——优先级 = 紧迫度（距阈值下坠深度）×
  救援权重（滑落区 1 / 深度遗忘 0.25）× 投资系数（1 + 巩固度）；排序后封顶
  `cap` 条（缺省 8，∈ [1, 50]，非法 `400`），超出部分明确顺延；
  `health`：clear（无到期）/ normal（容量内）/ overload（发生顺延）；
  保持率查表来自轴线 23 的 `retentionIndex`，查不到按阈值中性处理。
- `GET  /knowledge/continents?limit=8` → `{ modularity, levels, communities: [{ id, size, sessionCount, internalWeight, topEntities, entities }], graph, summary }`
  知识大陆（轴线 26）：实体倒排 → `buildEntityGraph` 共现图（边权 = 共现会话数）
  → Louvain 两阶段迭代（局部移动 + 社区聚合）模块度最大化；枢纽实体只归属
  连接最紧密的大陆；`limit` ∈ [1, 20]（默认 8），每块大陆成员封顶 12 实体。
- `GET  /knowledge/starmap?q=&limit=15` → `{ seeds, nodes: [{ key, name, type, gravity, hopDistance, seed }], summary }`
  星图导航（轴线 27）：查询命中实体为种子，带重启个性化 PageRank（阻尼 0.85）
  算稳态引力分布 + BFS 跳数标注；多跳（2–3 跳）高分实体 = 图上隐性关联。
  `q` 必填 ≤200 字符；种子未命中返回引导文案。
- `GET  /knowledge/drift?lambda=16` → `{ lambda, changePoints, currentSegment, segments, summary }`
  主题漂移（轴线 30）：会话流（标题 + 实体名投影）BOCPD 变点检测——
  unigram 语言模型逐会话意外度 + 前向后向平滑；`lambda` ∈ [6, 96]（期望段长，
  小 = 对切换更敏感）。
- `GET  /knowledge/consolidation` → `{ items, clusters: [{ representativeId, representativeProblem, memberIds, reinforcement, firstSeenAt, lastSeenAt, cohesion }], duplicates, unique, compression, summary }`
  记忆固化（轴线 31）：片段问题面 MinHash-LSH 近重复聚类（128 维签名 ×
  16 带 × 8 行，S 曲线阈值 ≈ 0.71，真实 Jaccard ≥ 0.65 验证，并查集传递归并）；
  簇数封顶 20。
- `GET  /knowledge/archaeology?windows=4` → `{ windows: [{ index, sessions, fromAt, toAt, entities, edges, modularity, continents: [{ id, size, sessionCount, topEntities, memberKeys }] }], events: [{ kind, fromWindow, toWindow, topEntities, strength, description }], stats, summary }`
  知识考古（轴线 32）：会话流按 index 均分为 N 个纪元（`windows` ∈ [2, 12]，默认 4；
  实际取 min(请求值, floor(会话数/2))，不足 4 个含实体会话返回引导文案），
  每纪元独立共现图 + 同源 Louvain，相邻纪元社区按成员实体键集合 Jaccard
  建立血脉（阈值 0.3）；血脉结构分类五类板块事件：birth（无前置血脉）/
  continuation（一对一血脉，strength = 成员重叠率）/ split（一对多血脉）/
  merge（多对一血脉）/ dissolve（无后继血脉）；单实体社区（成员 < 2）不参与
  事件分析。与轴线 30 分工：漂移看会话级注意力切换（浪），考古看纪元级
  知识域结构变迁（洋流）。
- `GET  /knowledge/radar?days=30` → `{ sessions, clusters: [{ representativeId, representativeTitle, memberIds, occurrences, firstSeenAt, lastSeenAt, recurrenceDays, cohesion, action }], duplicates, echoRateWindowDays, recentTotal, recentEchoes, echoRate, medianRecurrenceDays, summary }`
  回声雷达（轴线 33）：会话级文本投影（标题 + 实体名，零转录重读）过
  轴线 31 同源 MinHash-LSH（阈值 0.55——会话比片段更长更杂，阈值略宽）；
  `recurrenceDays` = 首末间隔 / (次数 − 1)（≥3 次才有周期，两次无法估）；
  `echoRate` = 近 `days`（∈ [1, 365]，默认 30）天新会话中命中历史回声
  （簇内非时间序首个）的占比；`action`：template（≥3 次，建议固化交接模板）/
  watch（2 次）；簇数封顶 20。
- `GET  /knowledge/darkmatter?limit=20` → `{ graph: { nodes, edges }, links: [{ u, v, uKey, vKey, commonNeighbors, adamicAdar, resourceAllocation, score, evidence, interpretation }], candidates, budgetExhausted, summary }`
  知识暗物质（轴线 34）：实体共现图上的链路预测（Liben-Nowell & Kleinberg
  局部指数族）——对每个**未连接**且存在共同邻居的实体对计算 CN / Adamic-Adar
  （`Σ 1/ln(deg)`，对数度数折扣）/ Resource Allocation（`Σ 1/deg`，线性折扣）
  三指数，融合分 = 0.5 × AA 归一 + 0.5 × RA 归一；候选对按桥节点（度数 ∈ (1, 40]）
  展开，枢纽不作证据，预算熔断（默认 200k 对）防御病态稠密图；
  `limit` ∈ [1, 50]（默认 20）。暗连接 = 研究建议（下一场对话值得把谁和谁
  放到一起），与轴线 27 分工：星图沿已有边扩散（已知连接深挖），
  暗物质预测缺失边（未知连接发现）。

### 模块 G（synthesis）
- `POST /synthesis/preview` `{ question }` → `{ question, evidence: [{ index, sessionId, title?, createdAt, score, snippet }], sources, coverage, stats: { candidates, chunks, evidenceChunks, evidenceChars, estimatedPromptTokens }, note }`
  研究预演（零 LLM）：证据收集管线（召回 → 块级检索 → 次模选择）跑到底但不进模型——先看将采用的
  证据（编号与合成时的 [n] 引用一致）、方面覆盖与 token 预算占用（粗估 ~2 字符/token），再决定是否
  调 `/synthesis/answer` 花钱合成。证据为空时返回引导文案而非报错。
- `POST /synthesis/answer` `{ question }` → `{ answer, model, sources: [{ sessionId, title?, createdAt, snippet }], stats: { candidates, chunks, evidenceChunks, evidenceChars } }`
  跨会话知识合成（轴线 5，Deep Research）：
  - **召回**：FTS 关键词召回（`searchSessions`，24 个）+ 近期会话兜底（12 个），
    按 id 去重合并、总数封顶 32（FTS 对长问句召回不稳，近期兜底保证覆盖；两通道各自容错）；
  - **转录预算**：单会话截断至 `TRANSCRIPT_CHAR_BUDGET`（40000）字符——超长保首尾回合
    （中段舍弃），与"首部背景 + 尾部最新结论"的信号分布对齐；
  - **分块**：按回合边界贪心组块（`CHUNK_CHAR_TARGET` = 1800 字符/块，回合不跨块、
    单回合超目标独立成块——引用边界可解释）；
  - **打分**：词法命中率 + trigram 余弦双通道各 50%（`scoreText`，复用 core/retrieval 分词器）；
  - **证据选择**：分数降序贪心装入（`MAX_EVIDENCE_CHUNKS` = 10 块）+ 单会话块数封顶
    （`PER_SESSION_CHUNK_CAP` = 3，防垄断）+ 总字符预算（`EVIDENCE_CHAR_BUDGET` = 26000，
    剩余 <200 字符提前收束，尾部块截断而非整块丢弃）；
  - **合成**：契约式 Prompt（只用证据 + `[编号]` 引用 + 证据不足明示 + 结论先行 + 矛盾明示），
    经成本网关（taskHint '研究' / priority 'high'，交互式不参与峰谷延迟）调用 DeepSeek，
    `maxTokens` 1600；
  - `question` ≤ `QUESTION_MAX_CHARS`（500）字符，违例 `400`；无相关证据 → `404` 可读文案。
  `sources` 为去重后的证据会话（snippet 为块文本空白折叠后截断 160 字符）。
  `evolution` 为知识演化追踪（轴线 17，纯本地零 LLM 开销）：证据块提取主题锚（技术专名）
  + 版本号/数值声明，同锚不同值 → 演化事件 `{ anchor, kind: upgrade|downgrade|change,
  from, to, fromAt, toAt, fromSession, toSession }`；语义化版本比较（v2.10 > v2.9，
  数字段逐段）判定方向，事件按时间升序排成信念时间线（`{ events[], summary }`）。

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
| `find` | E | 语义检索历史对话（混合排序，本地计算；input: `<检索词>`） |
| `map` | E | 知识地图：会话主题聚类（input: `[minSize]`，缺省 1） |
| `blindspots` | E | 知识盲区：反复搜索但历史无覆盖的主题（需求缺口清单） |
| `pulse` | E | 主动脉搏：主动洞察（检索盲区 + 反馈学习 + 索引健康，本地计算） |
| `insight` | F | 知识资产报告（input: `[会话ID]`，缺省输出全局实体图谱与主题趋势，
  带会话 id 时输出该会话实体 / 建议标签 / 关联会话） |
| `todo` | F | 前瞻记忆：到期的未兑现意图清单（轴线 20，本地计算；附即将到来栏） |
| `review` | F | 间隔重复：到期「问题→解法」复习清单（轴线 21，本地计算；
  input: `[记得|忘了] [片段ID]` 评分并告知下次间隔） |
| `analogy` | F | 类比检索：按问题结构形状找同构先例（轴线 22，本地计算；
  input: `<问题描述>`，跨域类比单独标注） |
| `forecast` | F | 遗忘预测体检：滑落区/深度遗忘区知识清单与保持率（轴线 23，
  本地计算；滑落区优先——最佳巩固窗口） |
| `rhythm` | F | 记忆节律报告：命中率、ease 系数与投影间隔阶梯（轴线 24，
  本地计算；标准曲线 → 你的曲线） |
| `continents` | F | 知识大陆：实体共现图 Louvain 社区发现（轴线 26，本地计算；
  input: `[limit]`，缺省 8） |
| `starmap` | F | 星图导航：个性化 PageRank 多跳隐性关联（轴线 27，本地计算；
  input: `<查询实体>`） |
| `drift` | F | 主题漂移：BOCPD 变点检测定位注意力切换（轴线 30，本地计算；
  input: `[lambda]` ∈ [6, 96]，缺省 16） |
| `consolidate` | F | 记忆固化：MinHash-LSH 近重复聚类报告（轴线 31，本地计算） |
| `archaeology` | F | 知识考古：纪元切片回放大陆形成史，板块事件五类分类（轴线 32，
  本地计算；新生/延续/分裂/合并/消亡） |
| `radar` | F | 回声雷达：会话级复发检测——回声簇 / 复发周期 / 回声率（轴线 33，
  本地计算；≥3 次复发建议固化为交接模板） |
| `darkmatter` | F | 知识暗物质：共现图链路预测——CN/AA/RA 三指数发现该连而未连的
  实体对（轴线 34，本地计算；input: `[limit]`，缺省 20） |
| `research` | G | 跨会话深度研究（input: `<研究问题>`；块级检索历史对话并合成
  带 `[编号]` 引用来源的回答，附证据来源列表） |

命令 handler 与 HTTP 端点复用同一套模块内服务函数，不重复实现逻辑。

## 6. 客户端（src/client/）

- 入口 `src/client/index.tsx`：`export const name` + `export function apply(ctx: ClientContext)`。
- UI 只经 slots 组合（官方纪律），所有注册组件经 `SlotErrorBoundary` 包裹（渲染错误降级为提示文案，不波及宿主）：
  - `'conversation.session.header.actions'`：导出按钮、交接摘要按钮、对话内搜索按钮；
  - `'conversation.input.dock'`：导入历史摘要入口；
  - `'conversation.view'`：全局检索视图页、成本报表视图页。
- 轴线 1（E 模块）客户端：`SearchView` 含语义/关键词模式一键切换（`semantic` 状态，
  语义模式走 `/retrieval/search`，关键词模式走 `/search`）、语义排名徽章
  （词法 #n · 语义 #n）。开关状态切换即重查（依赖数组含 `semantic`）。
- 轴线 2（B 模块）客户端：`HandoffDialog` 含查询聚焦输入（`focus` 字段）、
  分层摘要统计（层数/分块数/缓存命中）、上下文血缘图谱（`/handoff/lineage`
  的祖先/后代链路可视化）；`ImportSummaryDock` 携带 `sourceSessionId` 记录继承边。
- 轴线 4（F 模块）客户端：`KnowledgePanel`（全局实体图谱 + 单会话实体列表 +
  建议标签一键应用 + 关联会话推荐），经 `SearchView` 结果项的「知识」按钮展开；
  点击实体名直接发起检索（知识变检索入口）、点击关联会话直达对话。
- 轴线 5（G 模块）客户端：`SearchView` 工具栏「深度研究」按钮 → 研究面板
  （回答 + 证据来源列表 + 统计行）；`askSynthesis` 超时放宽至 120s（检索 + 合成耗时），
  请求在途时按钮禁用并显示 Spinner；证据来源行点击 `openSession` 直达原会话
  （每个论断可回溯验证）；「收起」清空面板。
- 轴线 6（B 模块）客户端：`HandoffDialog` 顶部上下文压力仪表（`/handoff/context-health`）：
  占用百分比进度条 + 估算 token + 耗尽预测（"按当前增速约还可 N 回合"）+ 四级分级
  配色（healthy 绿 / watch 黄 / advice 橙 / critical 红）与建议文案；随会话切换自动刷新。
- 轴线 7（F 模块）客户端：`KnowledgePanel` 顶部主题趋势区块（`/knowledge/trends`）：
  动量榜行（类型徽章 + 实体名 + rising/falling/stable 方向标签 + 动量百分比 +
  8 周迷你柱状图），点击趋势行以实体名发起检索。
- 轴线 17（G 模块）客户端：`SearchView` 深度研究结果的「知识演化」区块——
  信念时间线行（锚: 旧值 → 新值 + 升级/回退/变化标签 + 时间），附演化摘要。
- 轴线 18/19（E 模块）客户端：`SearchView` 工具栏「主动脉搏」按钮 → 洞察卡片面板
  （`/retrieval/insights`，每次打开重新合成）：severity 三级配色（critical/watch/info）
  + 文本 + 行动建议 + 信号源标注；认知三轴扩展后并行拉取 `/knowledge/pulse`，
  两源卡片按 severity 合并重排，认知源失败静默降级。
- 认知三轴（轴线 20/21/22，F 模块）客户端：`SearchView` 工具栏「认知面板」按钮 →
  `CognitionPanel`（`/knowledge/cognition` 单次请求驱动）：到期意图列表（超期徽章，
  ≥14 天转红，点击直达来源会话）+ 即将到来预告行；到期复习为检索式练习卡片
  （先看问题回忆 →「回想后看解法」翻开 → 「记得/忘了」评分，Toast 告知下次间隔，
  评分后卡片离队）；类比检索输入框 + 命中卡片（跨域类比/同域先例徽章 + 结构相似度 +
  共享约束类别 Pill，点击直达来源会话）。
- 元认知三轴（轴线 23/24/25，F 模块）客户端：认知面板新增遗忘预测区——保持率进度条
  （分区语义色：stable 绿 / warning 橙 / critical 红）+ 分区徽章 + 距跌破阈值倒计时，
  滑落区优先展示（最佳巩固窗口），顶部计数行「稳定 N · 滑落 N · 深忘 N」，点击直达
  来源会话；复习区升级为负荷感知——每张卡片带分诊结论（保持率 + 理由），洪峰时顶部
  显示顺延徽章（复习洪峰：N 条顺延）与负荷摘要，节律标记（节律 ×N.NN）常驻标题行；
  评分 Toast 附节律系数注记，面板内 rhythm 状态同步更新（不重拉全量）；
  `plan`/`forecast`/`rhythm` 字段可选——旧服务端缺省时对应区块静默降级。
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

- **回合级选择导出**（吸收自 dsh-conv-export）：`GET /export/turns` 的下标与
  `transcriptFromLog` 输出顺序一致（按 seq 稳定排序）；append-only 日志下
  旧回合下标不漂移，新回合只追加在列表末尾。客户端默认全选（此时导出请求
  省略 turns 字段）；部分选择传选中下标，导出内容的元信息（消息轮次等）
  自动反映过滤后的回合集合。批量导出与命令面板不参与回合选择。
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

语义检索模块（模块 E）行为契约：

- **纯本地计算红线**：BM25 词法统计、字符 trigram 哈希向量、RRF 融合全部在本地完成，
  零外部嵌入服务、零网络请求（隐私不出域）。语义近似 = 字符三元组重叠的哈希向量
  余弦相似度——同义词不可达（无外部世界知识），但拼写变体/中英混合/词形漂移显著鲁棒。
- **惰性增量索引**：每次检索前对账 `listSessions()` 与已索引快照（`updatedAt` 漂移检测，
  缺省回退 `createdAt`），仅重读变更会话；已消失会话清理索引。5 秒节流
  （距上次成功对账不足窗口时直接返回缓存统计）；在途对账 promise 去重
  （并发检索只跑一次对账）。索引持久化 `retrieval-index` 表，启动时恢复内存索引。
- **超长转录截断**：转录超 `INDEX_TRANSCRIPT_BUDGET`（80000）时保首尾截中段
  （中段附提示行）——与模块 B 的截断策略对齐。
- **单会话容错**：对账或片段生成中单会话读取失败静默跳过（保留旧统计 / 该条无片段），
  不阻塞整体结果。
- **强制重建**：`POST /retrieval/reindex` 清内存统计后全量对账（force=true 绕过节流），
  持久化表逐条覆盖。

知识资产模块（模块 F）行为契约：

- **纯本地规则抽取**：六类实体（command/path/tech/code/term/version）全部经正则规则
  抽取，零 LLM 调用、零网络请求。有序消费策略：URL 先整体让位（避免被 path/code 规则
  误吞），各规则按优先级标记消费区间后不再重复提取；同一名称命中多类型时归并到
  优先级最高的类型（command > path > tech > code > term > version）。
- **噪声治理**：全大写缩写停用表（TODO/NOTE 等注释标记）、首字母大写停用表
  （英文句首虚词）、中文术语停用表（引号内的常见非术语）；首字母大写词需频次 ≥2
  才采纳（一次性句首大写多为假阳性）。单会话实体条数封顶（按分数截取）。
- **倒排索引增量维护**：会话旧频次与新抽取结果做 diff，只写发生变化的实体记录
  （未受影响的记录零 IO）；实体全部会话频次归零时删除记录。索引持久化
  `knowledge-entities` 表（`v/<sessionId>` 版本记录 + `e/<type>:<小写名>` 倒排记录）。
- **标签建议只建议不写入**：`suggestedTags` 仅返回头部实体名（长度对齐 TagStore 规范），
  写入须经模块 D 的 `/tags` 端点由用户确认——尊重现有标签系统与用户判断。
- **关联会话归一**：相似度 = 共享实体 IDF 加权分 ÷ 两会话实体集规模的几何平均
  （余弦式归一，避免实体多的会话占尽便宜）；稀有实体的重叠权重更高
  （更说明"在谈同一件事"）。
- **对账策略**：与模块 E 对齐（5 秒节流 + 在途去重 + updatedAt 漂移检测）；
  `POST /knowledge/reanalyze` 清空全部状态后全量重建。

核心服务行为契约：

- `ready` 失败后可重试（存储域恢复后下次访问重新 open），并挂兜底 catch 杜绝未处理 rejection。
- HTTP 请求体读取有 30s 超时（408）；错误响应路径对已发送头的连接直接结束/销毁，不产生未处理 rejection。
- 峰谷窗口支持跨午夜（`start > end`）；脱敏覆盖带分隔符的手机号/银行卡，身份证正则含生日段合法性校验。
