import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 上下文交接 dock 行（模块 B 客户端 UI，挂载于 conversation.input.dock）：
 * - 左侧文案“上下文交接”，按钮“导入历史摘要”打开粘贴模态框；
 * - 粘贴摘要后 POST /handoff/import { summary, sessionId }；
 * - GET /handoff/armed 展示已武装徽标，可“移除”。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, Pill, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { dismissArmedHandoff, fetchArmedHandoffs, importHandoff } from '../api.js';
import styles from './ImportSummaryDock.module.css';
/** 截断过长文本用于徽标行内展示。 */
function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
/** 输入区 dock 行：导入历史摘要入口 + 已武装摘要徽标与移除操作。 */
export function ImportSummaryDock(props) {
    const [modalOpen, setModalOpen] = useState(false);
    const [summary, setSummary] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [armed, setArmed] = useState([]);
    const [armedLoading, setArmedLoading] = useState(false);
    const [armedError, setArmedError] = useState('');
    const [removing, setRemoving] = useState(false);
    /** 挂载标记：所有异步回调在 setState 前检查，防止卸载后更新状态。 */
    const mountedRef = useRef(true);
    // 维护 mountedRef：StrictMode 下 effect 会重执行，故在 effect 内重置。
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    /** 拉取已武装的交接摘要列表（mounted 守卫：卸载后不再 setState）。 */
    const loadArmed = useCallback(async () => {
        setArmedLoading(true);
        try {
            const response = await fetchArmedHandoffs();
            if (!mountedRef.current)
                return;
            setArmed(response.armed);
            setArmedError('');
        }
        catch (error) {
            if (!mountedRef.current)
                return;
            setArmedError(error instanceof Error ? error.message : '已武装摘要加载失败');
        }
        finally {
            if (mountedRef.current)
                setArmedLoading(false);
        }
    }, []);
    // 挂载时读取已武装状态
    useEffect(() => {
        void loadArmed();
    }, [loadArmed]);
    // 监听武装状态变化事件（HandoffDialog 武装成功 / 其他入口变更时派发），刷新徽标
    useEffect(() => {
        const onArmedChanged = () => {
            void loadArmed();
        };
        window.addEventListener('companion:armed-changed', onArmedChanged);
        return () => {
            window.removeEventListener('companion:armed-changed', onArmedChanged);
        };
    }, [loadArmed]);
    /** 提交粘贴的摘要：带 sessionId 注入当前会话，不带则武装给下一个新对话。 */
    const handleImport = useCallback(async () => {
        const text = summary.trim();
        if (!text) {
            Toast.push('请先粘贴历史摘要内容', 'warning');
            return;
        }
        setSubmitting(true);
        try {
            const result = await importHandoff({ summary: text, sessionId: props.sessionId });
            if (!mountedRef.current)
                return;
            Toast.push(result.sessionId ? '历史摘要已导入当前会话' : '历史摘要已武装给下一个新对话', 'success');
            setSummary('');
            setModalOpen(false);
            await loadArmed();
        }
        catch (error) {
            if (!mountedRef.current)
                return;
            Toast.push(error instanceof Error ? error.message : '导入失败', 'error');
        }
        finally {
            if (mountedRef.current)
                setSubmitting(false);
        }
    }, [summary, props.sessionId, loadArmed]);
    /** 移除一条已武装摘要；sessionId 为 null 时为全局武装（下一个新对话）。 */
    const handleRemove = useCallback(async (item) => {
        setRemoving(true);
        try {
            if (item.sessionId) {
                await dismissArmedHandoff({ sessionId: item.sessionId });
            }
            else {
                await dismissArmedHandoff({});
            }
            if (!mountedRef.current)
                return;
            Toast.push('已移除武装摘要', 'success');
            await loadArmed();
        }
        catch (error) {
            if (!mountedRef.current)
                return;
            Toast.push(error instanceof Error ? error.message : '移除失败', 'error');
        }
        finally {
            if (mountedRef.current)
                setRemoving(false);
        }
    }, [loadArmed]);
    return (_jsxs("div", { className: styles.dock, children: [_jsx("span", { className: styles.label, children: "\u4E0A\u4E0B\u6587\u4EA4\u63A5" }), armedLoading ? _jsx(Spinner, { label: "\u52A0\u8F7D\u5DF2\u6B66\u88C5\u6458\u8981\u2026" }) : null, !armedLoading && armedError ? _jsx("span", { className: styles.error, children: armedError }) : null, armed.map((item) => (_jsxs("div", { className: styles.armed, children: [_jsx(Pill, { className: styles.armedBadge, children: "\u5DF2\u6B66\u88C5" }), _jsxs("span", { className: styles.armedSummary, title: item.summary, children: [item.sessionId ? `会话 ${item.sessionId}：` : '下一个新对话：', truncate(item.summary, 40)] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => void handleRemove(item), disabled: removing, title: "\u79FB\u9664\u8BE5\u6B66\u88C5\u6458\u8981", children: "\u79FB\u9664" })] }, `${item.sessionId ?? 'global'}-${item.armedAt}`))), _jsx("div", { className: styles.spacer }), _jsx(Button, { variant: "secondary", size: "sm", onClick: () => setModalOpen(true), children: "\u5BFC\u5165\u5386\u53F2\u6458\u8981" }), _jsx(Modal, { open: modalOpen, title: "\u5BFC\u5165\u5386\u53F2\u6458\u8981", onClose: () => setModalOpen(false), footer: _jsxs("div", { className: styles.footer, children: [_jsx(Button, { variant: "ghost", onClick: () => setModalOpen(false), disabled: submitting, children: "\u53D6\u6D88" }), _jsx(Button, { variant: "primary", onClick: () => void handleImport(), disabled: submitting, children: submitting ? _jsx(Spinner, { label: "\u5BFC\u5165\u4E2D\u2026" }) : '导入' })] }), children: _jsxs("div", { className: styles.pasteBody, children: [_jsxs("p", { className: styles.pasteHint, children: ["\u7C98\u8D34\u4E0A\u4E00\u6BB5\u5BF9\u8BDD\u7684\u4EA4\u63A5\u6458\u8981\uFF1B\u5BFC\u5165\u540E", props.sessionId ? '将注入当前会话，作为后续回复的上下文。' : '将武装给下一个新对话。'] }), _jsx(Textarea, { rows: 8, value: summary, onChange: (event) => setSummary(event.target.value), placeholder: "\u5728\u6B64\u7C98\u8D34\u6458\u8981\u6587\u672C\u2026" })] }) })] }));
}
