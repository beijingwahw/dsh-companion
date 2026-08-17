/**
 * 单例控制器。一个页面只承载一个对话面板，模块级实例即正确的所有权；
 * cordis 的 install/uninstall 括起其 DOM 效果。
 */
declare class SearchController {
    private state;
    private bar;
    private input;
    private countEl;
    private prevBtn;
    private nextBtn;
    private caseBtn;
    private wordBtn;
    private searchTimer;
    private mutationTimer;
    private observer;
    private observedScope;
    private installed;
    /** 内存查询历史（最新在前），上限 HISTORY_LIMIT。 */
    private history;
    /** 历史浏览游标；-1=未在浏览。 */
    private historyCursor;
    /** 开始浏览历史前暂存的输入值。 */
    private historyDraft;
    /** 上次变更重同步前激活命中的身份。 */
    private anchor;
    /** 搜索栏当前是否打开（供头部按钮读取）。 */
    get isOpen(): boolean;
    /** 安装 document 级效果：样式表、搜索栏 DOM、Ctrl+F/Esc 按键捕获（幂等）。 */
    install(): void;
    /** 移除全部安装效果并清除绘制（幂等）。 */
    uninstall(): void;
    /** 打开搜索栏（无对话渲染时无操作）。 */
    open(): void;
    /** 关闭搜索栏、丢弃游标并清除全部高亮。 */
    close(): void;
    /** 开关切换（头部按钮手势）。 */
    toggle(): void;
    /**
     * 将打开状态镜像到头部按钮（纯 DOM 旁路——React 按钮只渲染一次，
     * 不应为此重渲染）。
     */
    private syncActionButton;
    /** 前进到下一个命中（环绕）。 */
    next(): void;
    /** 回退到上一个命中（环绕）。 */
    prev(): void;
    /** 构建一次浮动搜索栏并隐藏，直到打开。 */
    private mountBar;
    /**
     * 构建一个紧凑文本开关（Aa=区分大小写，ab=全词匹配）。
     * 纯文本字形保持搜索栏零依赖且 16px 下清晰可辨。
     */
    private toggleButton;
    /** 翻转一个匹配选项、同步开关按钮并立即重跑当前查询（显式手势不防抖）。 */
    private toggleOption;
    /**
     * 构建一个 16px 图标按钮（内联 SVG path，零图标依赖——
     * 搜索栏是纯 DOM，不得引入 React 图标组件）。
     */
    private iconButton;
    /** 记录当前非空查询进历史（最新在前、去重、限长）；Enter 提交时调用。 */
    private commitHistory;
    /**
     * 步进浏览查询历史：ArrowUp 向更旧，ArrowDown 回到暂存草稿；
     * 每步重跑搜索。
     * @param delta +1=更旧，-1=更新。
     */
    private browseHistory;
    /**
     * 对渲染中的转录执行一次搜索遍历并重绘。
     * @param jumpToFirst 是否同时把游标移到最佳初始命中（当前阅读位置
     * 之下最近的第一个命中，没有则回绕到最前）。变更重同步传 false——
     * 绝不能抢走读者的滚动位置。
     */
    private runSearch;
    /** 快照激活命中的身份（文本节点 + 起始偏移），供后续变更重同步重新定位。 */
    private anchorOf;
    /**
     * 在全新结果集中定位先前激活的命中：优先完全相同的文本节点 + 偏移
     * （命中原样存活）；退而求同一文本节点（命中在节点内移动，如流式追加）；
     * 都找不到则钳制下标，让读者留在原地而不是跳走。
     */
    private relocateIndex;
    /**
     * 选取初始激活命中：滚动视口顶边（读者当前位置）之下最近的第一个，
     * 没有则回绕到整体第一个。无 Range 几何的运行环境退回第一个命中。
     */
    private initialIndex;
    /** 游标步进一格（环绕）、重绘并滚动。零结果时搜索栏重新抖动作答。 */
    private step;
    /** 更新 “n / total” 计数、导航按钮可用态与无结果视觉状态。 */
    private renderCount;
    /**
     * 切换无结果提示：状态属性由样式表渲染为红色计数与一次性搜索栏抖动。
     * 已置位时再次置位会重新触发抖动——这正是对零结果查询反复按 Enter
     * 应当给出的回应。
     */
    private setNoResult;
    /**
     * 在当前滚动视口上挂 MutationObserver：流式输出、工具卡片与加载更早
     * 消息都会触发高亮重同步。作用域元素变化（切换会话）时重新附着。
     */
    private watchScope;
    /** 断开变更监视。 */
    private unwatchScope;
    /**
     * document 级捕获阶段按键处理器。捕获顺序至关重要：先于任何目标监听器
     * 运行，因此即使输入框持有焦点，Esc 也能关闭搜索栏（输入框自己的
     * 处理器只负责 Enter）。
     *
     * - Ctrl/Cmd+F：打开（仅在对话已渲染时；否则保留浏览器原生查找）；
     * - Esc：打开状态下始终关闭；
     * - F3 / Ctrl/Cmd+G（+Shift 反向）：打开状态下导航命中。
     */
    private readonly onKeyDown;
}
/** 页面级控制器单例。 */
export declare const convSearchController: SearchController;
export {};
