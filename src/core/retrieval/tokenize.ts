/**
 * 检索分词器：混合检索引擎的文本规范化层（纯函数，无状态，可单测）。
 *
 * 设计：
 * - Latin 词：连续的字母/数字/`_`/`.`/`-` 序列（保留技术标识符完整性，
 *   如 `ctx.effect`、`dsh-companion` 整体为一个词元），统一小写化；
 * - CJK：二元组（bigram）切分——中文无空格分界，bigram 在无词典条件下
 *   是召回与索引体积的最优折衷（unigram 噪声大，trigram 召回率低）；
 * - 停用词：小型中英高频词表过滤，降低索引体积与 BM25 噪声；
 * - 字符 trigram：供哈希向量做"语义近似"（拼写变体、词序无关的形状相似）。
 */
/** 判定单个字符码点是否为 CJK 表意文字（含扩展 A 区）。 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}

/** 判定是否为 Latin 词元字符（字母/数字/下划线/点/连字符）。 */
function isLatinWordChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x2e ||
    code === 0x2d
  )
}

/** 小型中英停用词表（高频虚词；完整表体积得不偿失，这里只去最重的噪声）。 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // 中文虚词与高频助词
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看',
  '好', '自己', '这', '那', '他', '她', '它', '们', '什么', '怎么', '可以',
  '因为', '所以', '但是', '如果', '还是', '以及', '或者', '这个', '那个',
  // 英文高频虚词
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
  'and', 'in', 'that', 'it', 'for', 'on', 'with', 'as', 'at', 'by', 'this',
  'or', 'from', 'but', 'not', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'shall', 'if',
  'then', 'than', 'so', 'we', 'you', 'they', 'i', 'me', 'my', 'our', 'your',
])

/**
 * 分词：Latin 词（小写化，保留 `.``-` 内部连接）+ CJK bigram，过滤停用词。
 * @param text 原始文本（任意混合中英文）。
 * @returns 词元数组（顺序保留，含重复——调用方自行统计词频）。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  let index = 0
  const length = lower.length
  while (index < length) {
    const code = lower.charCodeAt(index)
    if (isCjk(code)) {
      // CJK bigram：相邻两个表意字组成一个词元；孤立单字（串尾）丢弃
      //（单字噪声大于信号）。
      const next = index + 1 < length ? lower.charCodeAt(index + 1) : 0
      if (isCjk(next)) {
        tokens.push(lower.slice(index, index + 2))
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (isLatinWordChar(code)) {
      // Latin 词：贪心吃掉连续的词元字符；首尾的 `.`/`-` 修剪掉
      //（避免句尾句号污染，如 "end." → "end"）。
      let end = index
      while (end < length && isLatinWordChar(lower.charCodeAt(end))) end += 1
      let start = index
      while (start < end) {
        const c = lower.charCodeAt(start)
        if (c === 0x2e || c === 0x2d) start += 1
        else break
      }
      let stop = end
      while (stop > start) {
        const c = lower.charCodeAt(stop - 1)
        if (c === 0x2e || c === 0x2d) stop -= 1
        else break
      }
      const word = lower.slice(start, stop)
      if (word.length >= 2 && !STOPWORDS.has(word)) tokens.push(word)
      index = end
      continue
    }
    index += 1
  }
  return tokens
}

/**
 * 字符 trigram 统计：把文本滑窗切成 3 字符片段并计数。
 * 用于哈希向量——trigram 对拼写变体与字符组成敏感、对词序不敏感，
 * 在无嵌入模型的约束下提供"语义形状"的近似度量。
 * 空白归一为单个空格（连续空白不产生窗口膨胀）。
 * @param text 原始文本。
 * @returns trigram → 频次（稀疏映射）。
 */
export function charTrigrams(text: string): Map<string, number> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const grams = new Map<string, number>()
  if (normalized.length < 3) return grams
  for (let index = 0; index + 3 <= normalized.length; index += 1) {
    const gram = normalized.slice(index, index + 3)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  return grams
}

/** FNV-1a 32 位哈希（无依赖、分布均匀，供 trigram 桶映射使用）。 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}
