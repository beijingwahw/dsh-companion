/** RRF 融合常数（业界惯用 60：排名越靠前边际收益衰减越快）。 */
export declare const RRF_K = 60;
/** 索引文档的持久化形状（JSON 友好；存 companion 域 retrieval-index 表）。 */
export interface IndexedDoc {
    /** 会话 id（存储键）。 */
    sessionId: string;
    /** 会话标题（索引时刻快照，用于展示）。 */
    title: string;
    /** 会话创建/更新时间（索引时刻快照，用于时间过滤与展示）。 */
    createdAt: number;
    updatedAt: number;
    /** 词元 → 频次（tokenize 输出的稀疏统计）。 */
    termFreqs: Record<string, number>;
    /** 词元总数（termFreqs 值之和，BM25 文档长度）。 */
    length: number;
    /** 字符 trigram → 频次（哈希向量的原始稀疏输入）。 */
    grams: Record<string, number>;
}
/** 混合检索单条命中。 */
export interface HybridHit {
    sessionId: string;
    /** 时序加权后的融合分（两路排名倒数和 × 新近度加成；越大越相关）。 */
    score: number;
    /** BM25 词法排名（1 起；未进词法候选池为 undefined）。 */
    lexicalRank?: number;
    /** 向量语义排名（1 起；未进语义候选池为 undefined）。 */
    semanticRank?: number;
}
/** 时序感知选项（轴线 9）：对融合分做新近度乘性加成。 */
export interface RecencyOptions {
    /** 当前时间基准（毫秒时间戳）。 */
    readonly now: number;
    /** 半衰期（天）；缺省 30。 */
    readonly halfLifeDays?: number;
    /** 加成强度（0 = 关闭）；缺省 0.25。 */
    readonly boost?: number;
}
/**
 * 计算文档的时序加成（乘性增量，与 search 内部同式同参）：
 * 导出供命中解释器（轴线 15）做加成分解，避免常量两处维护。
 */
export declare function recencyBoostFor(doc: IndexedDoc, recency: RecencyOptions): number;
/** 从损坏/旧格式记录恢复时的收窄辅助：静默丢弃非法记录。 */
export declare function sanitizeIndexedDoc(raw: unknown): IndexedDoc | undefined;
/** 把一篇会话转录文本构建为索引文档（统计形态；IDF 留待查询时算）。 */
export declare function buildIndexedDoc(meta: {
    sessionId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
}, text: string): IndexedDoc;
/**
 * 混合检索索引：内存持有全量文档统计，查询时对「过滤后的文档视图」
 * 计算 BM25 与余弦两路排名并 RRF 融合。不做任何 IO——持久化由调用方
 * （模块层）负责。
 */
export declare class HybridRetrievalIndex {
    private readonly docs;
    /** 全量词元文档频率（增量维护；无过滤查询的 BM25 IDF 直读缓存）。 */
    private readonly termDf;
    /** 全量 trigram 文档频率（增量维护；语义通道 IDF 直读缓存）。 */
    private readonly gramDf;
    /** 词元 → 会话 id 倒排表（增量维护；查询扩展共现扫描直达，免全量遍历）。 */
    private readonly postings;
    /** 全量文档词元总数（增量维护；BM25 平均长度基准）。 */
    private totalLength;
    /** 当前已索引文档数。 */
    get size(): number;
    /** 全部文档（键值对数组；供持久化与调试）。 */
    entries(): [string, IndexedDoc][];
    /** 读取单个文档统计（存在时）。 */
    get(sessionId: string): IndexedDoc | undefined;
    /** 全量词表（词元 → 文档频率）只读视图：查询智能（轴线 8）消费。 */
    termDfSnapshot(): ReadonlyMap<string, number>;
    /** 包含指定词元的文档迭代器（倒排表直达）：共现扩展消费。 */
    docsWithTerm(term: string): Generator<IndexedDoc, void, undefined>;
    /** 写入/覆盖一篇文档（同一会话重索引即覆盖；统计与倒排同步增减）。 */
    put(doc: IndexedDoc): void;
    /** 删除一篇文档；不存在时静默（统计与倒排同步回滚）。 */
    delete(sessionId: string): void;
    /** 批量替换内存文档集（持久化恢复路径；统计与倒排全量重建）。 */
    load(docs: readonly IndexedDoc[]): void;
    /** 累加一篇文档的全量统计与倒排项。 */
    private addStats;
    /** 回滚一篇文档的全量统计与倒排项（覆盖/删除前调用）。 */
    private removeStats;
    /** 无过滤查询的全量统计（增量维护，查询时零扫描）。 */
    private globalStats;
    /** 过滤视图的即时统计（时间过滤路径少见，保持精确语义）。 */
    private viewStatsOf;
    /**
     * 混合检索：两路排名各取 top-K（候选池）→ RRF 融合 → 可选时序加成 →
     * 按最终分降序。
     *
     * 性能设计：无过滤查询直读增量维护的全量统计（termDf/gramDf/平均长度），
     * 免去每次查询的全语料扫描；带过滤时对视图即时计算（保持 IDF 与视图
     * 一致的精确语义）。两条路径数值完全等价。
     *
     * @param queryText 查询文本（任意中英混合，可含扩展词）。
     * @param limit 返回条数上限。
     * @param filter 可选的文档预过滤（时间范围等，模块层语义）。
     * @param recency 可选的时序感知选项（轴线 9）：融合分乘性新近度加成。
     */
    search(queryText: string, limit: number, filter?: (doc: IndexedDoc) => boolean, recency?: RecencyOptions): HybridHit[];
    /**
     * BM25 词法排名（语料统计由调用方注入：全量缓存或过滤视图）：
     * IDF 采用标准式 `ln(1 + (N - df + 0.5) / (df + 0.5))`；查询词不在
     * 语料中（df=0）时该词在任何文档 tf=0，实际不产生得分（无需特判）。
     */
    private lexicalRankingOf;
    /**
     * 向量语义排名（语料统计由调用方注入）：查询与文档都做
     * 「trigram → 哈希桶 → TF-IDF → L2 归一」，余弦即归一化点积。
     * signed hashing（哈希值第 16 位取符号）让碰撞近似成对抵消，
     * 缓解固定维度下的偏置聚集。
     */
    private semanticRankingOf;
}
/**
 * 文档的哈希稀疏向量（signed hashing 到 512 维，TF 直读、不做 IDF 加权）：
 * 供文档间相似度计算（轴线 12 多样性重排、轴线 13 会话聚类）复用——
 * 与语义通道的查询-文档匹配不同，文档-文档的形状比较不需要查询侧
 * 稀有度加权，TF + L2 归一已是充分的形状签名。
 */
export declare function docGramVector(doc: IndexedDoc): Map<number, number>;
/**
 * 任意文本的哈希稀疏向量（与 docGramVector 同构：TF 直读 + signed hashing）：
 * 供命中解释器（轴线 15）计算查询与文档的形状相似度——同一构造保证
 * 余弦可比性。docGramVector(doc) ≡ textGramVector(建索引时的原文)。
 */
export declare function textGramVector(text: string): Map<number, number>;
/** 两个稀疏向量的余弦相似度（[0, 1]；signed hashing 下可为负，钳到 0）。 */
export declare function sparseCosine(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): number;
/**
 * 摘要片段生成：在原文中定位查询词元的最密集命中窗口。
 * 策略：滑窗（窗口宽 160 字符，步长 40）内统计查询词元命中数，
 * 取命中最多的窗口，前后以 `…` 标注截断；无命中回退原文头部。
 * @param text 会话转录原文。
 * @param queryText 查询文本。
 */
export declare function buildSnippet(text: string, queryText: string): string;
