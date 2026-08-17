/**
 * 对话内搜索样式注入（能力吸收自 dsh-conv-search）：浮动搜索栏外观 +
 * CSS Custom Highlight API 的两条 ::highlight() 绘制规则。以稳定 id 注入
 * document.head，插件重复加载不会重复注入。
 */
/** 注入样式表（幂等，可从多个挂载路径安全调用）。 */
export declare function adoptStyles(): void;
