/**
 * 隐私脱敏：导出对话前对手机号、邮箱、身份证号、银行卡号自动打码。
 * 全部在本地完成，脱敏后的文本才会进入导出文件。
 */
/** 中国大陆手机号：保留前 3 位与后 4 位。 */
const PHONE_RE = /\b(1[3-9]\d)\d{4}(\d{4})\b/g;
/** 邮箱：本地部分仅保留首字符。 */
const EMAIL_RE = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
/**
 * 18 位身份证号：保留前 6 位与后 4 位。
 * 生日段要求合法（月 01-12、日 01-31），避免 18 位银行卡号被误判为身份证。
 */
const ID_CARD_RE = /\b(\d{6})\d{4}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(\d{3}[\dXx])\b/g;
/** 16-19 位银行卡号：保留前 4 位与后 4 位。 */
const BANK_CARD_RE = /\b(\d{4})\d{8,12}(\d{4})\b/g;
/**
 * 数字段分隔符归一化：去掉数字之间的空格与连字符，
 * 使 `138-1234-5678`、`6222 0202 0000 1234` 这类分组写法可被识别。
 * 仅处理 11–19 位的数字段（手机号/身份证/银行卡的位宽区间），
 * 避免误伤日期（如 2024-01-01）等无关数字文本。
 */
function normalizeDigitSeparators(text) {
    return text.replace(/\d(?:[\s-]*\d)+/g, (run) => {
        const digitCount = run.replace(/\D/g, '').length;
        if (digitCount < 11 || digitCount > 19)
            return run;
        return run.replace(/[\s-]+/g, '');
    });
}
/**
 * 对文本执行脱敏。
 * @param text 原始文本。
 * @returns 脱敏后的文本与各类命中计数。
 */
export function redactText(text) {
    const stats = { phone: 0, email: 0, idCard: 0, bankCard: 0 };
    // 匹配前先归一化数字分隔符（空格/连字符），覆盖分组书写的号码。
    const normalized = normalizeDigitSeparators(text);
    // 顺序敏感：先 18 位身份证，再 16-19 位银行卡，避免长数字串被误判。
    let result = normalized.replace(ID_CARD_RE, (_m, head, _month, _day, tail) => {
        stats.idCard += 1;
        return `${head}********${tail}`;
    });
    result = result.replace(BANK_CARD_RE, (_m, head, tail) => {
        stats.bankCard += 1;
        return `${head} **** **** ${tail}`;
    });
    result = result.replace(PHONE_RE, (_m, head, tail) => {
        stats.phone += 1;
        return `${head}****${tail}`;
    });
    result = result.replace(EMAIL_RE, (_m, head, domain) => {
        stats.email += 1;
        return `${head}***@${domain}`;
    });
    return { text: result, stats };
}
/** 是否发生过任何脱敏。 */
export function hasRedactions(stats) {
    return stats.phone + stats.email + stats.idCard + stats.bankCard > 0;
}
