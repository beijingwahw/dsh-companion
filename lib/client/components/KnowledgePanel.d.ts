import type { ReactElement } from 'react';
/** 洞察目标会话（由检索结果行传入）。 */
export interface KnowledgeTarget {
    readonly id: string;
    readonly title?: string;
}
/** 组件 props。 */
export interface KnowledgePanelProps {
    /** 当前洞察的会话；null 时仅展示全局实体图谱。 */
    readonly target: KnowledgeTarget | null;
    /** 点击实体：以实体名发起检索。 */
    readonly onSearchEntity: (name: string) => void;
    /** 点击关联会话：请求主平台跳转。 */
    readonly onOpenSession: (sessionId: string) => void;
    /** 关闭单会话洞察。 */
    readonly onCloseTarget: () => void;
}
/** 对话知识资产面板。 */
export declare function KnowledgePanel({ target, onSearchEntity, onOpenSession, onCloseTarget, }: KnowledgePanelProps): ReactElement;
