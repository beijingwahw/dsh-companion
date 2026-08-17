import type { ReactElement } from 'react';
/** 组件 props：sessionId 由 slot 的 inject 注入。 */
export interface ImportSummaryDockProps {
    /** 当前会话 id；存在时摘要导入该会话，否则武装给下一个新对话。 */
    readonly sessionId?: string;
}
/** 输入区 dock 行：导入历史摘要入口 + 已武装摘要徽标与移除操作。 */
export declare function ImportSummaryDock(props: ImportSummaryDockProps): ReactElement;
