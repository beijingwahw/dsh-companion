/**
 * 模块 G：跨会话知识合成（synthesis）——轴线 5/29「Deep Research over 历史对话」。
 *
 * 把"问自己的历史"变成一次研究流程：
 * 1. **召回**：FTS 关键词召回（sessionQuery.searchSessions）+ 近期会话兜底，
 *    合并去重为候选池（FTS 对长自然语言问句召回不稳，近期会话保证覆盖）；
 * 2. **块级检索**：逐会话读取转录 → 按回合边界分块 → 词法 + trigram
 *    双通道打分（复用 core/retrieval 分词器），片段粒度精排；
 * 3. **次模证据选择**（轴线 29）：设施选址次模目标（相关性 + 问题方面
 *    覆盖 × 稀有度权重）最大化，惰性贪婪（CELF）在「块数 × 单会话
 *    上限 × 字符预算」三重约束下选取——互补证据优于同义重复，冗余被
 *    目标函数自动惩罚，(1−1/e) 理论保证；
 * 4. **合成**：契约式 Prompt（只用证据 / 编号引用 / 结论先行 / 指出矛盾）
 *    经成本网关（或直连）调用 LLM，回答带 [编号] 引用；
 * 5. **来源回链**：每个贡献证据的会话生成来源视图（标题/日期/片段），
 *    点击可直达原会话——合成的每个论断都可回溯验证。
 *
 * 隐私边界：仅转录文本进入 DeepSeek API（与模块 B 摘要同一边界），
 * 不外发任何索引/实体/统计数据。
 *
 * HTTP 端点：`POST /synthesis/answer`（形状见 DESIGN.md 第 4 节）；
 * 命令 `research` 与端点复用同一服务函数。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type EvolutionReport } from '../../core/synthesis/evolution.js';
/** 插件名（Cordis fiber 诊断名）。 */
export declare const name = "companion-synthesis";
/** 依赖声明：核心服务 + 会话查询 + 命令面板。 */
export declare const inject: string[];
/** 合成来源（贡献证据的会话视图）。 */
export interface SynthesisSource {
    readonly sessionId: string;
    readonly title?: string;
    readonly createdAt: number;
    readonly snippet: string;
}
/** 合成结果。 */
export interface SynthesisResult {
    readonly answer: string;
    readonly model: string;
    readonly sources: readonly SynthesisSource[];
    /** 知识演化追踪（轴线 17：证据中的跨会话信念变化；无演化时 events 为空）。 */
    readonly evolution: EvolutionReport;
    /** 检索与合成统计（客户端展示沙盘透明度）。 */
    readonly stats: {
        readonly candidates: number;
        readonly chunks: number;
        readonly evidenceChunks: number;
        readonly evidenceChars: number;
        /** 次模选择诊断（轴线 29）。 */
        readonly selection: {
            /** 问题方面覆盖率（[0,1]）。 */
            readonly coverage: number;
            /** 惰性贪婪边际增益评估次数（效率证据）。 */
            readonly evaluations: number;
            /** 候选方面总数。 */
            readonly aspects: number;
        };
    };
}
/** 研究预演结果（零 LLM）：证据预览 + 覆盖 + 预算占用，供"先看后买"。 */
export interface SynthesisPreview {
    readonly question: string;
    /** 采用的证据块预览（编号与合成时的 [n] 引用一致）。 */
    readonly evidence: ReadonlyArray<{
        readonly index: number;
        readonly sessionId: string;
        readonly title?: string;
        readonly createdAt: number;
        readonly score: number;
        readonly snippet: string;
    }>;
    readonly sources: readonly SynthesisSource[];
    /** 问题方面覆盖率（[0,1]；次模选择诊断）。 */
    readonly coverage: number;
    readonly stats: {
        readonly candidates: number;
        readonly chunks: number;
        readonly evidenceChunks: number;
        readonly evidenceChars: number;
        readonly estimatedPromptTokens: number;
    };
    readonly note: string;
}
/** 插件入口。 */
export declare function apply(ctx: Context): void;
