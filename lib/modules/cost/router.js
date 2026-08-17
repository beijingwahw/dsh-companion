/** 自定义路由规则数量上限（保存入口校验）。 */
export const MAX_CUSTOM_RULES = 20;
/** 自定义路由规则 pattern 最大长度（字符，保存入口校验）。 */
export const MAX_RULE_PATTERN_LENGTH = 200;
/**
 * 批量预编译自定义路由规则：为每条规则携带编译好的正则。
 * @throws SyntaxError 任一 pattern 不是合法正则时（调用方应拒绝保存并返回 400）。
 */
export function compileCustomRules(rules) {
    return rules.map((rule) => ({
        pattern: rule.pattern,
        model: rule.model,
        regex: new RegExp(rule.pattern, 'i'),
    }));
}
/** 简单任务关键词（小写，英文匹配大小写不敏感）。 */
const SIMPLE_KEYWORDS = [
    '翻译',
    '摘要',
    '总结',
    '润色',
    '改写',
    'translate',
    'summarize',
    'polish',
    'rewrite',
];
/** 复杂任务关键词（小写，英文匹配大小写不敏感）。 */
const COMPLEX_KEYWORDS = [
    '代码',
    'code',
    '实现',
    '重构',
    'debug',
    '推理',
    '证明',
    '数学',
    '算法',
    '架构',
    'reason',
];
/** 正则编译缓存条目上限：超限整体清空重建，防止无界增长。 */
const REGEX_CACHE_LIMIT = 64;
/** 模型路由器（规则正则预编译缓存于实例内部）。 */
export class ModelRouter {
    /** 预编译正则缓存：pattern → 编译好的 RegExp，热路径不重复 new RegExp。 */
    regexCache = new Map();
    /**
     * 解析应使用的模型。
     * @param taskHint 调用方给出的任务提示词（可缺省）。
     * @param settings 当前成本设置（提供模型名与自定义规则）。
     * @returns 模型与判定原因。
     */
    resolve(taskHint, settings) {
        const hint = (taskHint ?? '').trim();
        if (!hint) {
            return { model: settings.simpleModel, reason: '无任务提示，缺省使用简单模型' };
        }
        // 1. 自定义规则优先。
        for (const rule of settings.customRules) {
            const pattern = rule.pattern.trim();
            if (pattern && this.matchPattern(hint, pattern)) {
                return { model: rule.model, reason: `自定义规则命中：${pattern}` };
            }
        }
        // 2. 关键词启发式（先简单类，后复杂类）。
        const lowered = hint.toLowerCase();
        for (const keyword of SIMPLE_KEYWORDS) {
            if (lowered.includes(keyword)) {
                return { model: settings.simpleModel, reason: `简单任务关键词命中：${keyword}` };
            }
        }
        for (const keyword of COMPLEX_KEYWORDS) {
            if (lowered.includes(keyword)) {
                return { model: settings.complexModel, reason: `复杂任务关键词命中：${keyword}` };
            }
        }
        // 3. 缺省简单模型。
        return { model: settings.simpleModel, reason: '未命中关键词，缺省使用简单模型' };
    }
    /**
     * pattern 是否命中 hint：先大小写不敏感子串匹配，
     * 再用缓存的预编译正则（大小写不敏感）匹配；非法正则视为未命中
     * （保存入口已校验，此处为绕过入口的规则来源兜底）。
     */
    matchPattern(hint, pattern) {
        if (hint.toLowerCase().includes(pattern.toLowerCase()))
            return true;
        const regex = this.compilePattern(pattern);
        return regex !== undefined && regex.test(hint);
    }
    /** 取或编译 pattern 对应的正则并缓存；编译失败返回 undefined。 */
    compilePattern(pattern) {
        const cached = this.regexCache.get(pattern);
        if (cached !== undefined)
            return cached;
        let regex;
        try {
            regex = new RegExp(pattern, 'i');
        }
        catch {
            return undefined;
        }
        if (this.regexCache.size >= REGEX_CACHE_LIMIT)
            this.regexCache.clear();
        this.regexCache.set(pattern, regex);
        return regex;
    }
}
