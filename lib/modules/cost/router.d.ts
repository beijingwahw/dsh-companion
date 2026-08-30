/**
 * 模型路由：按任务提示词选择简单/复杂模型，从源头降低成本。
 *
 * 判定优先级：
 * 1. 自定义规则（customRules）：pattern 作子串或正则匹配；
 * 2. 关键词启发式：简单类关键词 → simpleModel；复杂类关键词 → complexModel；
 * 3. 缺省：simpleModel。
 *
 * ReDoS 防护：用户自定义 pattern 在保存入口（/cost/settings）即预编译校验，
 * 编译失败拒绝保存（400）；语法合法但“星高”> MAX_STAR_HEIGHT 的模式
 * （如 (a+)+，嵌套无界量词在部分输入上回溯指数爆炸）同样拒绝保存；
 * 规则数 ≤ MAX_CUSTOM_RULES、pattern 长度 ≤ MAX_RULE_PATTERN_LENGTH；
 * 运行期正则经 ModelRouter 内部缓存预编译复用，不在热路径重复
 * new RegExp，且对绕过保存入口的规则来源做同样的星高兜底拒绝，
 * 并对正则测试输入长度设上界（MAX_REGEX_TEST_INPUT），为已接受
 * 模式的最坏回溯工作量封顶。
 */
import type { CostCustomRule, CostSettings } from './settings.js';
/** 自定义路由规则数量上限（保存入口校验）。 */
export declare const MAX_CUSTOM_RULES = 20;
/** 自定义路由规则 pattern 最大长度（字符，保存入口校验）。 */
export declare const MAX_RULE_PATTERN_LENGTH = 200;
/**
 * 允许的最大正则“星高”（无界量词嵌套深度）。
 * 星高 >1 的模式（如 (a+)+）在特定输入上回溯工作量随输入长度
 * 指数增长（ReDoS），保存入口与运行期双双拒绝。
 */
export declare const MAX_STAR_HEIGHT = 1;
/** 运行期正则测试的输入长度上限（字符）：为已接受模式的最坏情况封顶。 */
export declare const MAX_REGEX_TEST_INPUT = 10000;
/** 路由判定结果。 */
export interface RouteDecision {
    /** 应使用的模型名。 */
    model: string;
    /** 判定原因（供日志与诊断展示）。 */
    reason: string;
}
/** 携带预编译正则的路由规则对象。 */
export interface CompiledCustomRule {
    pattern: string;
    model: string;
    /** 预编译的正则（大小写不敏感）。 */
    regex: RegExp;
}
/**
 * 批量预编译自定义路由规则：为每条规则携带编译好的正则。
 * @throws SyntaxError 任一 pattern 不是合法正则时（调用方应拒绝保存并返回 400）。
 * @throws Error 任一 pattern 星高超过 MAX_STAR_HEIGHT（合法但存在 ReDoS 风险）。
 */
export declare function compileCustomRules(rules: readonly CostCustomRule[]): CompiledCustomRule[];
/** 模型路由器（规则正则预编译缓存于实例内部）。 */
export declare class ModelRouter {
    /** 预编译正则缓存：pattern → 编译好的 RegExp，热路径不重复 new RegExp。 */
    private readonly regexCache;
    /**
     * 解析应使用的模型。
     * @param taskHint 调用方给出的任务提示词（可缺省）。
     * @param settings 当前成本设置（提供模型名与自定义规则）。
     * @returns 模型与判定原因。
     */
    resolve(taskHint: string | undefined, settings: CostSettings): RouteDecision;
    /**
     * pattern 是否命中 hint：先大小写不敏感子串匹配，
     * 再用缓存的预编译正则（大小写不敏感）匹配；非法正则视为未命中
     * （保存入口已校验，此处为绕过入口的规则来源兜底）。正则测试的
     * 输入截断至 MAX_REGEX_TEST_INPUT：为已接受模式的回溯工作量封顶
     * （taskHint 远短于此上限，截断仅在异常超长输入时生效）。
     */
    private matchPattern;
    /**
     * 取或编译 pattern 对应的正则并缓存；编译失败或星高超限
     * （ReDoS 兜底，与保存入口同规则）返回 undefined。
     */
    private compilePattern;
}
