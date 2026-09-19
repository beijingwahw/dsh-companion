/**
 * 隐私脱敏：导出对话前对手机号、邮箱、身份证号、银行卡号、IP 地址、
 * API 密钥/令牌（含 JWT）自动打码。
 * 全部在本地完成，脱敏后的文本才会进入导出文件。
 */

export interface RedactionStats {
  phone: number
  email: number
  idCard: number
  bankCard: number
  /** IPv4 地址（保留前两段）。 */
  ipv4: number
  /** API 密钥 / Bearer 令牌 / JWT。 */
  secret: number
}

/** 中国大陆手机号：保留前 3 位与后 4 位。可选国家码前缀（86 / +86 / 086）。 */
const PHONE_RE = /(?<!\d)(\+?0?86[\s-]?)?(1[3-9]\d)\d{4}(\d{4})(?!\d)/g
/** 15 位老式身份证号（无校验位）：保留前 6 位与后 3 位。 */
const OLD_ID_CARD_RE = /(?<!\d)(\d{6})\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}(?!\d)/g
/** 邮箱：本地部分仅保留首字符。结尾允许数字等非字母字符（如 foo@bar.com1 仍命中）。 */
const EMAIL_RE = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![A-Za-z])/g
/**
 * 18 位身份证号：保留前 6 位与后 4 位。
 * 生日段要求合法（月 01-12、日 01-31），避免 18 位银行卡号被误判为身份证。
 */
const ID_CARD_RE = /(?<!\d)(\d{6})\d{4}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(\d{3}[\dXx])(?!\d)/g
/** 16-19 位银行卡号：保留前 4 位与后 4 位。 */
const BANK_CARD_RE = /(?<!\d)(\d{4})\d{8,12}(\d{4})(?!\d)/g
/**
 * IPv4 地址：保留前两段（内网拓扑通常足够定位，后两段是主机粒度隐私）。
 * 四段均 ≤ 255 才命中；紧跟字母数字或额外点号的（版本号 v1.2.3.4、
 * 语义化版本 1.2.3.4-beta 的前缀等）不命中——用 (?![\d.]) 与前置
 * 位移检查降低版本号误报，`v` 紧邻的显式跳过。
 */
const IPV4_RE = /(?<![\w.])(?<!v)(\d{1,3}\.\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])/g
/**
 * 已知前缀的 API 密钥：sk-（OpenAI/DeepSeek）、ghp_/gho_/ghu_/ghs_/ghr_
 * （GitHub）、github_pat_、AKIA（AWS 访问密钥）、xox[bpars]-（Slack）。
 * 保留前 4 字符前缀 + 掩码；长度门槛排除日常短词。
 */
const API_KEY_RE = /\b(sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AKIA|xox[bpars]-)([A-Za-z0-9_-]{12,})/g
/** Bearer 令牌：保留方案字 + 掩码（长度门槛排除短噪声）。 */
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi
/** JWT：三段 base64url（头.载荷.签名），全部掩码——任何一段都是敏感载荷。 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\b/g

/** 合并后仍能被某条规则命中的位宽（手机号 11、身份证 15/18、银行卡 16-19）。 */
const MERGEABLE_WIDTHS = new Set([11, 15, 16, 17, 18, 19])

/**
 * 数字段分隔符归一化：去掉数字之间的空格与连字符，
 * 使 `138-1234-5678`、`6222 0202 0000 1234` 这类分组写法可被识别。
 * 仅当合并后的位宽恰好命中某条规则的位宽时才合并；落在 12-14 位
 * 空窗区的分段保持原样——既避免把 `+86 13812345678` 粘合成无法
 * 匹配的 13 位长串（反而泄露手机号），也不破坏日期加短编号等文本。
 */
function normalizeDigitSeparators(text: string): string {
  return text.replace(/\d(?:[\s-]*\d)+/g, (run) => {
    const digitCount = run.replace(/\D/g, '').length
    if (!MERGEABLE_WIDTHS.has(digitCount)) return run
    return run.replace(/[\s-]+/g, '')
  })
}

/**
 * 对文本执行脱敏。
 * @param text 原始文本。
 * @returns 脱敏后的文本与各类命中计数。
 */
export function redactText(text: string): { text: string; stats: RedactionStats } {
  const stats: RedactionStats = { phone: 0, email: 0, idCard: 0, bankCard: 0, ipv4: 0, secret: 0 }

  // 匹配前先归一化数字分隔符（空格/连字符），覆盖分组书写的号码。
  const normalized = normalizeDigitSeparators(text)

  // 密钥/令牌最先处理：掩码后的文本不再暴露可被后续规则二次匹配的数字串。
  // JWT 先于 Bearer：`Bearer <jwt>` 场景下整体按 JWT 掩码一次，不重复计数。
  let result = normalized.replace(API_KEY_RE, (_m, prefix: string, _rest: string) => {
    stats.secret += 1
    return `${prefix}****`
  })
  result = result.replace(JWT_RE, () => {
    stats.secret += 1
    return 'eyJ****.****.****'
  })
  result = result.replace(BEARER_RE, (_m, scheme: string, _token: string) => {
    stats.secret += 1
    return `${scheme}****`
  })

  // 顺序敏感：先 18 位身份证，再 15 位老身份证，再 16-19 位银行卡，
  // 避免长数字串被误判；邮箱先于手机号，防止邮箱本地部分中的手机号
  // 被二次打码造成重复计数。
  result = result.replace(
    ID_CARD_RE,
    (_m, head: string, _month: string, _day: string, tail: string) => {
      stats.idCard += 1
      return `${head}********${tail}`
    },
  )
  result = result.replace(OLD_ID_CARD_RE, (_m, head: string, _month: string, _day: string, tail: string) => {
    stats.idCard += 1
    return `${head}********${tail}`
  })
  result = result.replace(BANK_CARD_RE, (_m, head: string, tail: string) => {
    stats.bankCard += 1
    return `${head} **** **** ${tail}`
  })
  result = result.replace(IPV4_RE, (match, head: string, c: string, d: string) => {
    // 各段 ≤ 255 才是合法 IPv4；否则保持原样（如 999.999.999.999）。
    const octets = [...head.split('.'), c, d].map((part) => Number(part))
    if (octets.some((value) => !Number.isInteger(value) || value > 255)) return match
    stats.ipv4 += 1
    return `${head}.*.*`
  })
  result = result.replace(EMAIL_RE, (_m, head: string, domain: string) => {
    stats.email += 1
    return `${head}***@${domain}`
  })
  result = result.replace(PHONE_RE, (_m, prefix: string | undefined, head: string, tail: string) => {
    stats.phone += 1
    return `${prefix ?? ''}${head}****${tail}`
  })
  return { text: result, stats }
}

/** 是否发生过任何脱敏。 */
export function hasRedactions(stats: RedactionStats): boolean {
  return (
    stats.phone + stats.email + stats.idCard + stats.bankCard + stats.ipv4 + stats.secret > 0
  )
}
