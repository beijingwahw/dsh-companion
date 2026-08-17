export function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}
/**
 * 官方 usage → 计价引擎用量形状。
 * DeepSeek 的 prompt_tokens 已包含缓存命中部分：命中部分按缓存命中价计，
 * 其余输入按未命中价计。
 */
export function tokenUsageToUsageLike(usage) {
    const cacheHit = Math.min(usage.promptCacheHitTokens, usage.promptTokens);
    return {
        inputTokens: usage.promptTokens - cacheHit,
        outputTokens: usage.completionTokens,
        cacheReadTokens: cacheHit,
    };
}
