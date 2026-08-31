/**
 * 分词：Latin 词（小写化，保留 `.``-` 内部连接）+ CJK bigram，过滤停用词。
 * @param text 原始文本（任意混合中英文）。
 * @returns 词元数组（顺序保留，含重复——调用方自行统计词频）。
 */
export declare function tokenize(text: string): string[];
/**
 * 字符 trigram 统计：把文本滑窗切成 3 字符片段并计数。
 * 用于哈希向量——trigram 对拼写变体与字符组成敏感、对词序不敏感，
 * 在无嵌入模型的约束下提供"语义形状"的近似度量。
 * 空白归一为单个空格（连续空白不产生窗口膨胀）。
 * @param text 原始文本。
 * @returns trigram → 频次（稀疏映射）。
 */
export declare function charTrigrams(text: string): Map<string, number>;
/** FNV-1a 32 位哈希（无依赖、分布均匀，供 trigram 桶映射使用）。 */
export declare function fnv1a32(text: string): number;
