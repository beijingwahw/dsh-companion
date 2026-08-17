import type { ReactElement } from 'react';
/** 组件 props：sessionId 由 slot 的 inject 注入（本视图不使用，仅为统一注入约定）。 */
export interface SearchViewProps {
    readonly sessionId?: string;
}
/** 全局对话检索视图页。 */
export declare function SearchView(_props: SearchViewProps): ReactElement;
