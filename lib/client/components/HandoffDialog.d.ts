import type { ReactElement } from 'react';
/** 组件 props：sessionId 由 slot 的 inject 注入。 */
export interface HandoffDialogProps {
    /** 当前会话 id；存在时打开对话框自动生成摘要。 */
    readonly sessionId?: string;
    readonly open: boolean;
    readonly onClose: () => void;
}
/** 交接摘要对话框：生成/编辑摘要 + 模板管理 + 武装到新对话。 */
export declare function HandoffDialog(props: HandoffDialogProps): ReactElement;
