/**
 * 对话内搜索引擎（能力吸收自 dsh-conv-search，基于 CSS Custom Highlight API）。
 *
 * 为什么用 Highlight API 而不是注入 <mark>：转录 DOM 归 React 所有，
 * 模型流式输出期间持续重渲染；用 <mark> 包裹命中会改动 React 管理的
 * 文本节点并与协调算法对抗。Custom Highlight API 以覆盖层绘制 range，
 * 不触碰 DOM 树，天然扛住一切重渲染，也无需清理 React 子节点。
 *
 * 作用域纪律：匹配只走对话滚动视口（[data-conversation-scroll]），
 * 跳过输入区 seat 与本插件自己的浮动搜索栏，避免命中 UI 外壳文字
 * 或用户自己的草稿产生幻影结果。
 *
 * 不依赖 cordis 与 React，纯 DOM 助手，可对着 jsdom 单测。
 */
/** 全部命中的高亮名。 */
export declare const HL_ALL = "companion-conv-search";
/** 当前激活（聚焦）命中的高亮名。 */
export declare const HL_ACTIVE = "companion-conv-search-active";
/** 对话滚动视口选择器（引擎的作用域）。 */
export declare const SCROLL_SELECTOR = "[data-conversation-scroll]";
/** 排除在匹配之外的输入区 seat 选择器。 */
export declare const COMPOSER_SELECTOR = "[data-composer-seat]";
/** 排除在匹配之外的本插件浮动搜索栏选择器。 */
export declare const BAR_SELECTOR = "[data-companion-search-bar]";
/** 定位到的单个命中：range 本身。 */
export interface MatchRange {
    /** 高亮文本范围（startContainer 为文本节点）。 */
    readonly range: Range;
}
/** 匹配行为开关（对齐浏览器/IDE 查找栏）。 */
export interface MatchOptions {
    /** 区分大小写（关=不区分，缺省）。 */
    readonly caseSensitive: boolean;
    /** 仅匹配两侧为非词字符界定的出现。 */
    readonly wholeWord: boolean;
}
/** 缺省匹配行为：不区分大小写的子串匹配。 */
export declare const DEFAULT_MATCH_OPTIONS: MatchOptions;
/** 一次搜索遍历的结果。 */
export interface SearchResult {
    /** 按文档顺序排列的全部命中。 */
    readonly matches: readonly MatchRange[];
    /** 命中总数（matches.length）。 */
    readonly total: number;
}
/** 特性检测 CSS Custom Highlight API 是否可用。 */
export declare function highlightsSupported(): boolean;
/**
 * 从文档任意位置解析对话滚动视口。
 * @param from 任意元素或 document 本身。
 * @returns 滚动视口元素；当前没有对话渲染时为 null。
 */
export declare function resolveScope(from?: ParentNode): HTMLElement | null;
/**
 * 在作用域全部文本节点中定位查询串的每个出现，按文档顺序返回 range。
 * @param scope 对话滚动视口。
 * @param query 原始查询（已 trim、非空）。
 * @param options 匹配行为（大小写、全词）。
 */
export declare function findMatches(scope: HTMLElement, query: string, options?: MatchOptions): SearchResult;
/**
 * 绘制命中：全部命中挂 {@link HL_ALL}，激活命中额外挂 {@link HL_ACTIVE}。
 * 每次调用替换上一次绘制。
 * @param result 待绘制的命中。
 * @param activeIndex 聚焦命中下标；-1 表示无。
 */
export declare function paint(result: SearchResult, activeIndex: number): void;
/** 清除本插件绘制的全部高亮（幂等）。 */
export declare function clearPaint(): void;
/**
 * 将激活命中滚动到视口中央。无 Range 几何的运行环境（部分测试环境）
 * 降级为无操作。
 * @param result 当前命中集。
 * @param index 聚焦命中下标。
 */
export declare function scrollToMatch(result: SearchResult, index: number): void;
