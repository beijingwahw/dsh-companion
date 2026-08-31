/**
 * 对话知识资产核心（轴线 4）：从会话转录中抽取结构化实体。
 *
 * 纯函数、零 LLM 调用、零网络请求——与轴线 1 同一条设计红线：
 * 所有计算本地完成，隐私不出域。
 *
 * 抽取目标（六类实体，按信号强度降序）：
 * - **command**：命令行（行首动词表命中，如 `git commit`、`npm install`）；
 * - **path**：文件路径（含斜杠 + 扩展名，如 `src/core/service.ts`）；
 * - **tech**：技术专名（全大写缩写如 HTTP/JSON；内部大写的驼峰如
 *   JavaScript/OpenAI；出现 ≥2 次的首字母大写词如 DeepSeek）；
 * - **code**：代码标识符（小写驼峰、snake_case、反引号包裹的行内代码、
 *   点号链式标识符如 `ctx.effect`）；
 * - **term**：中文术语（书名号/引号/方头括号包裹，如「上下文工程」）；
 * - **version**：版本号（v1.2.3 / 2.0）。
 *
 * 抽取采用"有序消费"策略：URL 先整体让位（避免被 path/code 规则误吞），
 * 各规则按优先级匹配后标记消费区间，后续规则不再重复提取同一段文本；
 * 同一名称命中多个类型时归并到优先级最高的类型（command > path >
 * tech > code > term > version）。
 *
 * 显著性打分：freq × 类型权重。类型权重反映先验信号强度——一条命令
 * 的知识密度高于一个普通标识符。全局稀有度（IDF）由调用方结合
 * 实体倒排索引补充计算，本模块不感知语料级统计。
 */
/** 实体类型（按优先级降序排列，索引即优先级）。 */
export type EntityType = 'command' | 'path' | 'tech' | 'code' | 'term' | 'version';
/** 全部实体类型（有序）。 */
export declare const ENTITY_TYPES: readonly EntityType[];
/** 抽取出的单个实体（未含全局统计）。 */
export interface ExtractedEntity {
    /** 展示名（众数原形，保留大小写）。 */
    name: string;
    type: EntityType;
    /** 会话内出现次数。 */
    freq: number;
    /** 显著性分 = freq × 类型权重。 */
    score: number;
    /** 倒排索引规范化键（type:小写名；跨会话聚合的稳定标识）。 */
    key: string;
}
/** 实体在倒排索引中的规范化键（type 与 name 冒号分隔；name 可含任意字符）。 */
export declare function entityKey(type: EntityType, name: string): string;
/** 从倒排键解析回 (type, name)；非法键返回 undefined。 */
export declare function parseEntityKey(key: string): {
    type: EntityType;
    name: string;
} | undefined;
/**
 * 从会话转录文本抽取实体。
 * @param text 会话转录（formatTranscript 输出；任意中英混合）。
 * @returns 按分数降序的实体列表（≤ MAX_ENTITIES_PER_SESSION 条）。
 */
export declare function extractEntities(text: string): ExtractedEntity[];
/** 实体的类型权重（打分与展示徽章共用）。 */
export declare function entityTypeWeight(type: EntityType): number;
