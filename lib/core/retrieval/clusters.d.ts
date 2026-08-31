/**
 * 会话聚类知识地图（轴线 13）：把全部历史会话自动组织成主题簇。
 *
 * 设计动机：会话列表是「时间流」，但知识是「主题网」——你可能在三周里
 * 分 5 次解决同一个部署问题、用 4 段对话啃同一个性能坑。时间流里这些
 * 分散为孤岛，聚类后它们变成 2 个簇，一眼回答三个问题：
 * - 「我重复解决过哪些问题」（簇规模 ≥2 = 重复投入，可合并/沉淀模板）；
 * - 「我的知识都分布在哪些主题」（簇列表 = 个人知识地图的目录页）;
 * - 「这段时期我在忙什么」（簇的时间跨度 + 规模 = 注意力流向）。
 *
 * 算法：**质心贪心聚类**（leader-follower）——文档按更新时间从新到旧
 * 依次归簇，与各簇质心做 trigram 哈希向量余弦，≥ 阈值则并入（质心增量
 * 累加），否则自立新簇。复杂度 O(n × k)（k = 簇数），远低于层次聚类的
 * O(n²)，千级会话毫秒完成；「新会话优先」的遍历序让簇由最新表述定义，
 * 旧表述向新表述靠拢（主题演化天然被吸收进簇，而非裂成两簇）。
 *
 * 簇标签：簇内文档频率 × 全局 IDF 打分取 top 词——「簇内常见且全局
 * 罕见」即该簇的判别性签名，与模块 F 实体抽取互补（F 抽语法实体，
 * 这里抽统计主题词）。
 *
 * 隐私红线：纯本地计算，聚类结果只存内存/响应，不落盘不外传。
 */
import { type IndexedDoc } from './engine.js';
/** 会话主题簇。 */
export interface SessionCluster {
    /** 簇 id（c1、c2…按簇规模降序编号）。 */
    readonly id: string;
    /** 簇标签（判别性主题词，`·` 连接）。 */
    readonly label: string;
    /** 簇内会话数。 */
    readonly size: number;
    /** 簇内会话 id（最近优先，封顶展示）。 */
    readonly sessionIds: readonly string[];
    /** 簇内最早/最晚创建时间（毫秒时间戳）。 */
    readonly from: number;
    readonly to: number;
    /** 判别性主题词（打分降序）。 */
    readonly topTerms: readonly string[];
}
/** 聚类选项。 */
export interface ClusterOptions {
    /** 并簇相似度阈值（缺省 0.3）。 */
    readonly threshold?: number;
    /** 簇标签词数（缺省 3）。 */
    readonly labelTerms?: number;
}
/**
 * 对全部已索引会话做主题聚类。
 * @param docs 索引文档集合（任意顺序；内部按 updatedAt 从新到旧遍历）。
 * @param options 阈值与标签词数。
 * @returns 簇列表（规模降序；单会话簇也在内，调用方按需过滤）。
 */
export declare function clusterSessions(docs: readonly IndexedDoc[], options?: ClusterOptions): SessionCluster[];
