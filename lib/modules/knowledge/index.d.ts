/**
 * 模块 F：对话知识资产（knowledge）插件——轴线 4/7/20–25 的宿主侧接线。
 *
 * 把对话从"一次性的消息流"升级为"可积累的知识资产"：
 * - **实体抽取**（轴线 4）：纯本地规则从会话转录抽取六类实体
 *   （命令/路径/技术专名/代码标识符/中文术语/版本号），零 LLM 调用；
 * - **自动标签建议**：按 freq × 类型权重 × IDF 对会话实体打分，
 *   推荐头部实体为标签（只建议不写入——尊重现有标签系统与用户判断）；
 * - **关联会话**：基于实体倒排索引计算会话间的实体重叠相似度
 *   （IDF 加权 + 余弦式归一），回答"还有哪些对话在谈同一件事"；
 * - **前瞻记忆**（轴线 20）：从转录提取未兑现意图（「明天试试」「回头
 *   重构」），到期浮现——对话历史不再说过就忘；
 * - **间隔重复巩固**（轴线 21）：问题→解决片段即复习卡片，1/3/7/14/30/60
 *   天阶梯间隔调度，「记得」升档「忘了」归零——遗忘曲线对抗；
 * - **类比检索**（轴线 22）：按问题结构形状（约束类别 × 解法类别）跨域
 *   匹配历史经验——"你三个月前解决过同构问题，虽然在完全不同的领域"；
 * - **遗忘预测**（轴线 23）：艾宾浩斯衰减模型为每条片段给出连续的
 *   保持率画像（≥70% 健康 / 30–70% 滑落区 / <30% 深度遗忘区），
 *   用当前节律重算——日程过期（节律变差）的知识被提前预警；
 * - **个体节律自适应**（轴线 24）：命中率 → ease 闭环比例控制
 *   （目标 85% 合意困难），间隔按你的遗忘速度伸缩——你不再是
 *   "平均人类"；
 * - **认知负荷调度**（轴线 25）：到期复习按可救性 × 巩固投资分诊，
 *   每日封顶 + 洪峰顺延——复习是一份每日计划，不是一场倾倒。
 *
 * 组成：
 * - 惰性增量倒排索引：每次查询前对账 sessionQuery.listSessions() 与
 *   已分析版本（updatedAt 漂移检测），仅重读变更会话；5 秒节流
 *   （对齐模块 E 的同步策略）；同一次转录读取同时喂实体/意图/片段
 *   三路提取（零额外 IO）；
 * - HTTP 端点：`GET /knowledge/status`（索引状态）、`GET
 *   /knowledge/entities`（全局实体图谱）、`GET /knowledge/analyze`
 *   （单会话实体 + 标签建议）、`GET /knowledge/related`（关联会话）、
 *   `POST /knowledge/reanalyze`（全量重建）、`GET /knowledge/cognition`
 *   （认知总览：意图 + 复习 + 元认知三轴）、`GET /knowledge/intentions`
 *   （意图清单）、`POST /knowledge/review/grade`（复习评分 + 节律更新）、
 *   `GET /knowledge/analogy?q=`（类比检索）、`GET /knowledge/pulse`
 *   （模块 F 主动洞察：意图/复习/片段/预测/节律/负荷六类信号源）、
 *   `GET /knowledge/forecast`（遗忘预测报告）、`GET /knowledge/rhythm`
 *   （记忆节律画像）、`GET /knowledge/load?cap=`（今日负荷计划）；
 * - 命令 `insight`：知识资产文本报告；`todo`：到期意图；`review`：
 *   今日分诊后的复习安排（`review <片段ID> ok|no` 评分）；
 *   `analogy <问题描述>`：同构经验检索；`forecast`：遗忘预测体检；
 *   `rhythm`：记忆节律报告。
 *
 * 索引持久化：companion 域 `knowledge-entities` 表——
 * - 键 `v/<sessionId>` → 已分析版本（updatedAt 快照，漂移检测基准）；
 * - 键 `e/<type>:<小写名>` → 实体倒排记录 { name, type, sessions }。
 * 认知持久化：`knowledge-intentions` 表（键 = sessionId → 意图记录）、
 * `knowledge-episodes` 表（键 = sessionId → 片段记录）、
 * `knowledge-review` 表（键 = `sessionId:hash` → 复习调度状态）、
 * `knowledge-rhythm` 表（单记录 'profile' → 记忆节律档案）。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名（Cordis fiber 诊断名）。 */
export declare const name = "companion-knowledge";
/** 依赖声明：核心服务 + 会话查询 + 命令面板。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
