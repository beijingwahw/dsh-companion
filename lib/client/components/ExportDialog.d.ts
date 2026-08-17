import type { ReactElement } from 'react';
/** 组件 props：sessionId 由 slot 的 inject 注入。 */
export interface ExportDialogProps {
    /** 当前会话 id；未勾选批量导出时导出该会话。 */
    readonly sessionId?: string;
    readonly open: boolean;
    readonly onClose: () => void;
}
/** 导出对话框：格式/选项 + 批量会话多选 + 加载态与 Toast 反馈。 */
export declare function ExportDialog(props: ExportDialogProps): ReactElement;
