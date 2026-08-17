import type { ModelPrice, PriceSheet, PriceTable, UsageLike, VendorPricing } from './types.js';
/** DeepSeek 官方 API 定价页（zh-CN）。 */
export declare const OFFICIAL_PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
/** 最小日志形状（结构兼容 cordis logger）。 */
export interface MinimalLogger {
    warn(...args: unknown[]): void;
    info(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
/**
 * 内置兜底价格表（元/百万 tokens）：
 * - deepseek-chat / deepseek-coder 为本插件实际调用的官方模型名，
 *   取自插件原静态计费表（官方调价时由实时抓取自动覆盖）；
 * - deepseek-v4-* 镜像官方定价页 2026-08-14 快照：现平价，
 *   2026-08-17 起启用峰谷分时。
 */
export declare const BUILTIN_SHEET: PriceSheet;
/** 缺省北京时间高峰窗口 [起始小时, 结束小时)（DeepSeek 官方约定）。 */
export declare const DEFAULT_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]>;
/**
 * 一次调用的费用（元）。缓存读按缓存命中价计；缓存写按未命中输入价计
 * （DeepSeek 将其并入普通输入）；未知价格计 0（tokens 仍被统计）。
 */
export declare function costOf(price: ModelPrice | undefined, usage: UsageLike): number;
/** 某北京时间时刻是否处于任一高峰窗口。 */
export declare function isPeakTimeAt(atMs: number, windows?: ReadonlyArray<readonly [number, number]>): boolean;
/** 在某价格表与时刻下解析模型单价（分时计划感知）。 */
export declare function resolvePrice(sheet: PriceSheet, model: string, atMs: number): ModelPrice | undefined;
/** 带超时抓取 URL 文本。 */
export declare function fetchText(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<string>;
/**
 * 解析 DeepSeek 定价页 HTML 为价格表。无可识别价格表时抛错
 * （调用方保留上一份有效表）。
 */
export declare function parsePriceSheet(html: string, url: string): PriceSheet;
/** 校验反序列化的持久化价格表快照；结构非法返回 undefined。 */
export declare function sanitizePriceSheet(raw: unknown): PriceSheet | undefined;
/** 持有实时价格表并负责刷新与兜底的所有权服务。 */
export declare class PriceService {
    private pricingUrl;
    private readonly timeoutMs;
    private readonly log;
    private sheet;
    private changedAt;
    private overrides;
    /** 各厂商官方定价页实时抓取表（新模型落在这里）。 */
    private vendorLive;
    /** 官方价格内容变化回调（供持久化与提示）。 */
    onChanged?: (sheet: PriceSheet) => void;
    constructor(pricingUrl: string, timeoutMs: number, log: MinimalLogger);
    /** 指向另一份定价页（设置实时更新）。 */
    setUrl(url: string): void;
    /** 当前定价页 URL。 */
    get url(): string;
    /** 替换用户价格覆盖（设置实时更新）。 */
    setOverrides(overrides: PriceTable): void;
    /** 当前用户价格覆盖（只读副本）。 */
    getOverrides(): Readonly<PriceTable>;
    /** 当前生效的价格表快照。 */
    get currentSheet(): PriceSheet;
    /** 官方页最近一次给出不同价格的时间（undefined = 从未）。 */
    get lastChangedAt(): number | undefined;
    /** 当前生效的高峰时段窗口（分时计划优先，缺省官方约定窗口）。 */
    activePeakWindows(): ReadonlyArray<readonly [number, number]>;
    /**
     * 恢复持久化的价格表快照（重启后首次抓取成功前沿用上次官方价格）。
     * 仅接受结构合法的快照；内置快照不被空表覆盖。
     */
    loadPersistedSheet(raw: unknown): boolean;
    /** 一次调用在某时刻的费用（元）：解析单价并经 costOf 计算。 */
    costOfCall(model: string, usage: UsageLike, atMs: number): number;
    /**
     * 某模型在某时刻的单价。优先级：用户覆盖 > DeepSeek 实时/内置表 >
     * 厂商实时表（自动导入的新模型）> 内置目录精确 > 最长前缀匹配
     * （覆盖 `glm-4.6-250414` 这类带日期快照名）。undefined 表示无价可计。
     */
    resolve(model: string, atMs: number): ModelPrice | undefined;
    /** 按厂商分组的全部已知定价（供面板与报表）。 */
    vendorPricing(atMs: number): VendorPricing[];
    /**
     * 抓取解析官方页；失败时保留上一份有效表。
     * 检测官方价格变更并显式记录，使公布的调价在下一次轮询即被自动采纳。
     */
    refresh(): Promise<void>;
    /**
     * 抓取某厂商的官方定价数据并自动导入其列出的全部带价模型。
     * 新模型与调价被显式记录；失败（网络、纯 JS 页）保留上一份表不变。
     *
     * 按 fetchKind 分派：
     *  - kimi-rsc: Kimi 客户端渲染文档；价格在 /pricing/chat* 子页的 RSC payload；
     *  - ernie-cdn: 百度 CDN page-data JSON（cloud.baidu.com 重置 TLS）；
     *  - zhipu-bundle: 智谱 SPA 壳；旗舰价内嵌 app.*.js，旧模型走公开运营位接口；
     *  - doubao-md: 火山文档中心接口返回服务端 Markdown；
     *  - html（缺省）: 定价页 HTML 的通用表格解析。
     */
    refreshVendor(vendorId: string): Promise<void>;
    /** 按 fetchKind 抓取解析某厂商的定价数据。 */
    private fetchVendorTable;
    /** 刷新 DeepSeek 与全部其他厂商的官方定价页。 */
    refreshAll(): Promise<void>;
}
