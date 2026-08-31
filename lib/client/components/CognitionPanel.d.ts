import type { ReactElement } from 'react';
/** 组件 props。 */
export interface CognitionPanelProps {
    /** 点击来源会话（意图/类比命中）：请求主平台跳转。 */
    readonly onOpenSession: (sessionId: string) => void;
    /** 收起认知面板。 */
    readonly onClose: () => void;
}
/** 认知面板。 */
export declare function CognitionPanel({ onOpenSession, onClose }: CognitionPanelProps): ReactElement;
