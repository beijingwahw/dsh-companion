import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 导出对话框（模块 A 客户端 UI）：
 * - 单会话导出（当前 sessionId）或勾选“批量导出”后会话列表多选、打包为 ZIP；
 * - 可选格式 Markdown/PDF/JSON/PNG 长图、保留时间戳（默认开）、隐私脱敏；
 * - 导出按钮带加载态；成功按 kind 分流：
 *   file → 直接下载；raster → 客户端 canvas 光栅化为 PNG 长图或免打印多页 PDF
 *   （能力吸收自 dsh-conv-export，全程无 window.print() 对话框）；
 *   print → 打开打印窗口（仅旧契约降级路径）；失败 Toast 提示。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Modal, Select, Spinner, Toast, } from '@deepseek-ai/dsh-client-ui-primitives';
import { base64ToBlob, downloadBlob, fetchExportSessions, openPrintHtml, runExport, runExportBatch, } from '../api.js';
import { exportLongPng, exportRasterPdf } from '../raster.js';
import styles from './ExportDialog.module.css';
/** 格式选项（value 为 API 契约的 'markdown' | 'pdf' | 'json' | 'png'）。 */
const FORMAT_OPTIONS = [
    { value: 'markdown', label: 'Markdown（.md）' },
    { value: 'pdf', label: 'PDF（.pdf）' },
    { value: 'json', label: 'JSON（.json）' },
    { value: 'png', label: 'PNG 长图（.png）' },
];
/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
/** 导出对话框：格式/选项 + 批量会话多选 + 加载态与 Toast 反馈。 */
export function ExportDialog(props) {
    /** 局部常量：便于在回调中保持类型收窄，并作为 useCallback 的具体依赖。 */
    const sessionId = props.sessionId;
    const onClose = props.onClose;
    const [format, setFormat] = useState('markdown');
    const [timestamps, setTimestamps] = useState(true);
    const [redact, setRedact] = useState(false);
    const [batch, setBatch] = useState(false);
    const [sessions, setSessions] = useState([]);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [sessionsError, setSessionsError] = useState('');
    const [exporting, setExporting] = useState(false);
    /** 挂载标记：异步回调在 setState 前检查，防止卸载后更新状态。 */
    const mountedRef = useRef(true);
    // 维护 mountedRef：StrictMode 下 effect 会重执行，故在 effect 内重置。
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    /** 拉取可导出的会话列表（进入批量模式时调用；mounted 守卫）。 */
    const loadSessions = useCallback(async () => {
        setSessionsLoading(true);
        setSessionsError('');
        try {
            const response = await fetchExportSessions();
            if (!mountedRef.current)
                return;
            setSessions(response.sessions);
        }
        catch (error) {
            if (!mountedRef.current)
                return;
            setSessionsError(error instanceof Error ? error.message : '会话列表加载失败');
        }
        finally {
            if (mountedRef.current)
                setSessionsLoading(false);
        }
    }, []);
    /** “批量导出”开关：首次打开时拉取会话列表。 */
    const handleBatchToggle = useCallback((next) => {
        setBatch(next);
        if (next && sessions.length === 0 && !sessionsLoading) {
            void loadSessions();
        }
    }, [sessions.length, sessionsLoading, loadSessions]);
    /** 勾选/取消勾选某个会话。 */
    const toggleSelected = useCallback((id) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    /** 执行导出：区分单会话与批量，按响应 kind 触发下载或打印（mounted 守卫）。 */
    const handleExport = useCallback(async () => {
        if (exporting)
            return;
        setExporting(true);
        try {
            if (batch) {
                if (format === 'png') {
                    Toast.push('PNG 长图需逐张光栅化，不支持批量导出，请改用 Markdown/PDF/JSON', 'warning');
                    return;
                }
                const sessionIds = [...selectedIds];
                if (sessionIds.length === 0) {
                    Toast.push('请至少勾选一个会话', 'warning');
                    return;
                }
                const result = await runExportBatch({ sessionIds, format, timestamps, redact });
                if (!mountedRef.current)
                    return;
                downloadBlob(base64ToBlob(result.contentBase64, result.mimeType), result.fileName);
                Toast.push(`已导出 ${sessionIds.length} 个会话（ZIP 压缩包）`, 'success');
            }
            else {
                if (!sessionId) {
                    Toast.push('当前没有可导出的会话，可勾选“批量导出”选择会话', 'warning');
                    return;
                }
                const result = await runExport({ sessionId, format, timestamps, redact });
                if (!mountedRef.current)
                    return;
                if (result.kind === 'file') {
                    downloadBlob(base64ToBlob(result.contentBase64, result.mimeType), result.fileName);
                }
                else if (result.kind === 'raster') {
                    // 客户端光栅化：PNG 长图或免打印多页 PDF（无 window.print() 对话框）
                    if (result.target === 'png') {
                        await exportLongPng(result.html, result.fileName);
                    }
                    else {
                        await exportRasterPdf(result.html, result.fileName);
                    }
                }
                else {
                    // 旧契约降级路径：服务端返回可打印 HTML，新窗口写入并触发浏览器打印
                    openPrintHtml(result.html);
                }
                Toast.push('导出成功', 'success');
            }
            onClose();
        }
        catch (error) {
            if (!mountedRef.current)
                return;
            Toast.push(error instanceof Error ? error.message : '导出失败，请稍后重试', 'error');
        }
        finally {
            if (mountedRef.current)
                setExporting(false);
        }
    }, [exporting, batch, selectedIds, format, timestamps, redact, sessionId, onClose]);
    return (_jsx(Modal, { open: props.open, title: "\u5BFC\u51FA\u5BF9\u8BDD", onClose: props.onClose, footer: _jsxs("div", { className: styles.footer, children: [_jsx(Button, { variant: "ghost", onClick: props.onClose, disabled: exporting, children: "\u53D6\u6D88" }), _jsx(Button, { variant: "primary", onClick: () => void handleExport(), disabled: exporting, children: exporting ? (_jsx(Spinner, { label: "\u6B63\u5728\u5BFC\u51FA\u2026" })) : batch ? (`导出所选（${selectedIds.size}）`) : ('导出') })] }), children: _jsxs("div", { className: styles.body, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { className: styles.fieldLabel, children: "\u5BFC\u51FA\u683C\u5F0F" }), _jsx(Select, { value: format, onChange: (event) => setFormat(event.target.value), children: FORMAT_OPTIONS.map((option) => (_jsx("option", { value: option.value, children: option.label }, option.value))) })] }), _jsxs("div", { className: styles.options, children: [_jsx(Checkbox, { checked: timestamps, onChange: setTimestamps, label: "\u4FDD\u7559\u65F6\u95F4\u6233" }), _jsx(Checkbox, { checked: redact, onChange: setRedact, label: "\u9690\u79C1\u8131\u654F\uFF08\u79FB\u9664\u624B\u673A\u53F7 / \u90AE\u7BB1 / API Key \u7B49\u654F\u611F\u4FE1\u606F\uFF09" }), _jsx(Checkbox, { checked: batch, onChange: handleBatchToggle, label: "\u6279\u91CF\u5BFC\u51FA\uFF08\u591A\u9009\u4F1A\u8BDD\uFF0C\u6253\u5305\u4E3A ZIP\uFF09" })] }), batch ? (_jsxs("div", { className: styles.sessionList, children: [sessionsLoading ? _jsx(Spinner, { label: "\u52A0\u8F7D\u4F1A\u8BDD\u5217\u8868\u2026" }) : null, !sessionsLoading && sessionsError ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: sessionsError }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => void loadSessions(), children: "\u91CD\u8BD5" })] })) : null, !sessionsLoading && !sessionsError && sessions.length === 0 ? (_jsx("div", { className: styles.empty, children: "\u6682\u65E0\u53EF\u5BFC\u51FA\u7684\u4F1A\u8BDD" })) : null, !sessionsLoading && !sessionsError
                            ? sessions.map((session) => (_jsx("div", { className: styles.sessionItem, children: _jsx(Checkbox, { checked: selectedIds.has(session.id), onChange: () => toggleSelected(session.id), label: _jsxs("span", { className: styles.sessionMeta, children: [_jsx("span", { className: styles.sessionTitle, children: session.title ?? `会话 ${session.id}` }), _jsx("span", { className: styles.sessionTime, children: formatTime(session.createdAt) })] }) }) }, session.id)))
                            : null] })) : null, !batch && !props.sessionId ? (_jsx("div", { className: styles.hint, children: "\u672A\u68C0\u6D4B\u5230\u5F53\u524D\u4F1A\u8BDD\uFF0C\u53EF\u52FE\u9009\u201C\u6279\u91CF\u5BFC\u51FA\u201D\u4ECE\u5217\u8868\u4E2D\u9009\u62E9\u4F1A\u8BDD\u3002" })) : null] }) }));
}
