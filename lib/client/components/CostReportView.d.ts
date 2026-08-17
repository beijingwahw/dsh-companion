import type { ReactElement } from 'react';
/** 组件 props：sessionId 由 slot 的 inject 注入（本视图不使用，仅为统一注入约定）。 */
export interface CostReportViewProps {
    readonly sessionId?: string;
}
/** 成本报表视图页。 */
export declare function CostReportView(_props: CostReportViewProps): ReactElement;
