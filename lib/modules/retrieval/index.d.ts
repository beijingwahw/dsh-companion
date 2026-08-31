/**
 * 模块 E：本地语义检索（retrieval）插件——轴线 1/8/9/10/11/12/13/14/15/16 的宿主侧接线。
 *
 * 能力：纯本地混合检索（BM25 词法 + trigram 哈希向量语义近似 + RRF 融合），
 * 检索质量显著超越纯 FTS 关键词匹配，且零外部依赖、零隐私外泄。
 *
 * 组成：
 * - 惰性增量索引：每次检索前对账 `sessionQuery.listSessions()` 与已索引
 *   快照（updatedAt 漂移检测），仅重读变更会话；5 秒节流避免高频全量对账；
 * - 查询智能（轴线 8）：检索前对查询做拼写纠错 + 语料共现扩展
 *   （倒排表直达，扩展词只追加不替换，响应携带溯源注记）；
 * - 时序感知（轴线 9）：融合分乘性新近度加成（半衰期 30 天、强度 25%）；
 * - 质量诊断（轴线 10）：每次检索返回四级判定 + 通道覆盖率 + 可执行建议；
 * - 反馈学习（轴线 11）：点击结果即反馈——查询词并入该会话的点击画像，
 *   后续检索对画像命中查询词的会话做乘性加成（封顶 35%、90 天半衰），
 *   检索器随使用越来越懂「你最终打开的是什么」；
 * - 多样性重排（轴线 12）：MMR 贪心选择（λ=0.7），头部结果从「最优的
 *   重复」变成「最优且互补的组合」；
 * - 知识地图（轴线 13）：全部会话质心贪心聚类为主题簇，回答「我重复
 *   解决过哪些问题 / 知识分布在哪些主题」；
 * - 查询建议（轴线 14）：输入框自动补全——前缀补全（语料词表 × df）+
 *   共现续写 + 点击画像加权，「你的语料告诉你该搜什么」；
 * - 命中解释（轴线 15）：每条命中携带透明账本（词法命中词 × tf、语义
 *   形状相似度、新近/反馈加成分解）+ 一句话人话摘要；
 * - 零命中救援（轴线 16）：检索失败时自动放宽查询（宽阈值纠错 0.35 +
 *   噪声词剔除）重试，救援结果明确标注、可回溯；
 * - HTTP 端点：`GET /retrieval/search`（混合检索 + 扩展 + 诊断 + 反馈 +
 *   多样性 + 解释 + 救援）、`GET /retrieval/suggest`（查询建议）、
 *   `GET /retrieval/status`（索引状态）、`POST /retrieval/reindex`
 *   （全量重建）、`POST /retrieval/feedback`（点击反馈）、
 *   `GET /retrieval/clusters`（主题簇知识地图）；
 * - 命令 `find`：语义检索历史对话（与 HTTP 复用同一服务函数，
 *   输出附扩展溯源、救援说明、命中解释与质量摘要）；命令 `map`：知识地图速览。
 *
 * 索引持久化：companion 域 `retrieval-index` 表（键 = 会话 id，
 * 值 = 文档统计形状，见 core/retrieval/engine.js）；启动时恢复内存索引。
 * 反馈持久化：companion 域 `retrieval-feedback` 表（键 = 会话 id，
 * 值 = 点击画像，见 core/retrieval/feedback.js）。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名（Cordis fiber 诊断名）。 */
export declare const name = "companion-retrieval";
/** 依赖声明：核心服务 + 会话查询 + 命令面板。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
