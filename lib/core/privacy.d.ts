/**
 * 隐私脱敏：导出对话前对手机号、邮箱、身份证号、银行卡号自动打码。
 * 全部在本地完成，脱敏后的文本才会进入导出文件。
 */
export interface RedactionStats {
    phone: number;
    email: number;
    idCard: number;
    bankCard: number;
}
/**
 * 对文本执行脱敏。
 * @param text 原始文本。
 * @returns 脱敏后的文本与各类命中计数。
 */
export declare function redactText(text: string): {
    text: string;
    stats: RedactionStats;
};
/** 是否发生过任何脱敏。 */
export declare function hasRedactions(stats: RedactionStats): boolean;
