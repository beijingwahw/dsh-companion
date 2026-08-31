/**
 * 检索质量诊断（轴线 10）：把「这次检索结果可信吗」变成可计算的指标。
 * 纯函数、零依赖——输入命中列表与语料规模，输出四级判定与可执行建议。
 *
 * 设计动机：混合检索的 RRF 融合分对用户是黑盒数字（0.0328 是什么意思？）。
 * 本模块把它翻译成可解释的质量信号：
 *
 * - **相关度强度**：头部命中融合分 / 理论满分（两路皆第 1 名）的比值——
 *   ≥50% 判 strong、≥25% 判 fair、更低判 weak（结果「有」，但别太信）；
 * - **通道覆盖**：命中中带词法排名 / 语义排名的比例——词法覆盖低说明
 *   查询用词未在对话中字面出现（靠语义形状兜底），语义覆盖低说明字符
 *   形状差异大（检查拼写）；
 * - **区分度**：头部与尾部融合分的落差（gap 大 = 头部显著强于长尾，
 *   排序信息量高）；
 * - **空结果诊断**：区分「索引还没建好」与「查询写法问题」，给出
 *   可直接照做的建议（换短词 / 放宽过滤 / 切换关键词模式对照）。
 *
 * 这些指标同时服务两端：客户端展示一行人话提示；命令面板输出质量摘要。
 */
import { RRF_K } from './engine.js';
/** 相关度强度判定阈值（头部融合分 / 理论满分）。 */
const STRONG_RATIO = 0.5;
/** 相关度强度 fair 档阈值。 */
const FAIR_RATIO = 0.25;
/** 通道覆盖率的低覆盖警示线。 */
const LOW_COVERAGE = 0.3;
/**
 * 诊断一次混合检索的结果质量。
 * @param hits 引擎返回的命中列表（已按融合分降序）。
 * @param totalDocs 语料文档总数（区分「索引为空」与「查询无命中」）。
 */
export function diagnoseRetrieval(hits, totalDocs) {
    const maxScore = 2 / (RRF_K + 1);
    if (hits.length === 0) {
        return {
            verdict: 'empty',
            topScore: 0,
            maxScore,
            scoreGap: 0,
            lexicalCoverage: 0,
            semanticCoverage: 0,
            suggestions: totalDocs === 0
                ? ['语义索引尚未建立：稍候片刻等待自动对账，或通过命令面板执行重建']
                : [
                    '换个更简短的关键词，或把长问题拆成多个词分别检索',
                    '放宽或清除日期范围过滤后重试',
                    '切换为关键词检索模式对照验证（语义通道可能未覆盖该写法）',
                ],
        };
    }
    const topScore = hits[0].score;
    const strength = maxScore > 0 ? topScore / maxScore : 0;
    const lexicalHits = hits.filter((hit) => hit.lexicalRank !== undefined).length;
    const semanticHits = hits.filter((hit) => hit.semanticRank !== undefined).length;
    const lexicalCoverage = lexicalHits / hits.length;
    const semanticCoverage = semanticHits / hits.length;
    const verdict = strength >= STRONG_RATIO ? 'strong' : strength >= FAIR_RATIO ? 'fair' : 'weak';
    const suggestions = [];
    if (verdict === 'weak') {
        suggestions.push('头部命中相关度偏低：尝试更具体的术语，或把问题拆成多个关键词分别检索');
    }
    if (lexicalCoverage <= LOW_COVERAGE) {
        suggestions.push('词法通道命中少：查询用词可能未在对话中字面出现（语义通道已兜底），换用对话中出现过的原词可提升精度');
    }
    if (semanticCoverage <= LOW_COVERAGE) {
        suggestions.push('语义通道命中少：查询与命中内容字符形状差异大，检查拼写或改用标准写法');
    }
    return {
        verdict,
        topScore: Number(topScore.toFixed(5)),
        maxScore: Number(maxScore.toFixed(5)),
        scoreGap: Number((topScore - hits[hits.length - 1].score).toFixed(5)),
        lexicalCoverage: Number(lexicalCoverage.toFixed(4)),
        semanticCoverage: Number(semanticCoverage.toFixed(4)),
        suggestions,
    };
}
/** 质量判定的人话标签（命令面板与客户端共用）。 */
export const VERDICT_LABELS = {
    strong: '强',
    fair: '中',
    weak: '弱',
    empty: '空',
};
