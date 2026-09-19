/**
 * 负向词排除（检索查询修饰符）：`-词` 从结果中剔除含该词的会话。
 *
 * 设计动机：混合检索的查询全是"要什么"；但检索意图常含"不要什么"——
 * "docker 网络 -k8s"（k8s 的网络方案看得够多了）、"python 性能 -numpy"。
 * 此前用户只能翻页跳过噪声；负向词把排除意图显式化：
 *
 * - **语法**：以 `-` 开头的空白分隔词元为排除词（`-k8s`、`-容器`）；
 *   `-` 单独出现不视为修饰符（列表破折号场景不误伤）；
 * - **同源分词**：排除词经与索引一致的 tokenize 分词后按词元判定
 *   （中文排除词天然支持——判定口径与正向匹配完全一致）；
 * - **语义**：命中"包含任一排除词元"的文档整体出局（先排除、后排序，
 *   排除词不参与打分——排除是硬约束不是降权）；
 * - **溯源**：剥离后的查询与排除词清单随响应返回（`negations` 字段），
 *   行为可解释、可回退。
 *
 * 纯函数、无状态、确定性。
 */

import { tokenize } from './tokenize.js'

/** 负向词解析结果。 */
export interface ParsedNegations {
  /** 剥离排除词后的剩余查询（原样保留大小写与顺序；可能为空串）。 */
  readonly queryText: string
  /** 排除词原形（按出现顺序去重）。 */
  readonly negations: readonly string[]
}

/**
 * 解析查询中的负向词修饰符。
 * @param queryText 原始查询（任意中英混合）。
 */
export function parseNegations(queryText: string): ParsedNegations {
  const kept: string[] = []
  const negations: string[] = []
  const seen = new Set<string>()
  for (const token of queryText.split(/\s+/)) {
    if (token.length > 1 && token.startsWith('-')) {
      const term = token.slice(1)
      if (!seen.has(term)) {
        seen.add(term)
        negations.push(term)
      }
      continue
    }
    kept.push(token)
  }
  return { queryText: kept.join(' ').trim(), negations }
}

/**
 * 构造排除判定谓词：文档词元集合命中任一排除词的任一词元 → 排除。
 * @param negations 排除词原形（空数组返回 undefined——零开销短路）。
 * @returns (termFreqs) => boolean，true 表示**保留**。
 */
export function negationFilterOf(
  negations: readonly string[],
): ((termFreqs: Readonly<Record<string, number>>) => boolean) | undefined {
  if (negations.length === 0) return undefined
  // 预分词：每个排除词展开为词元集合（一次性成本，检索时纯查表）。
  const tokenSets = negations.map((term) => new Set(tokenize(term)))
  return (termFreqs) => {
    for (const tokens of tokenSets) {
      for (const token of tokens) {
        if ((termFreqs[token] ?? 0) > 0) return false
      }
    }
    return true
  }
}
