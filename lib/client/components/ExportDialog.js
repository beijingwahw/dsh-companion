import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 导出对话框（模块 A 客户端 UI）：
 * - 单会话导出（当前 sessionId）或勾选“批量导出”后会话列表多选、打包为 ZIP；
 * - 批量选择可视化界面（对齐回合选择面板）：全选/全不选工具栏 + 已选计数 +
 *   标题/ID 实时筛选（全选作用于当前筛选结果并与已有选择取并集）+ 勾选行
 *   高亮/未勾选行淡化；
 * - 回合级选择导出（能力吸收自 dsh-conv-export）：单会话模式下逐回合勾选
 *   （角色徽章 + 两行截断预览 + 时间），全选/全不选与已选计数实时更新，
 *   仅导出选中回合（如剔除失败的尝试或跑题的段落）；全选时不携带 turns 字段；
 * - 可选格式 Markdown/PDF/JSON/PNG 长图、保留时间戳（默认开）、隐私脱敏；
 * - 导出按钮带加载态与分片进度（done/total）；导出进行中「取消」按钮变为
 *   「中止导出」（AbortSignal 贯穿 API 请求与客户端光栅化），Esc 不再关闭
 *   对话框（对齐 dsh-conv-export 的面板纪律：进行中以取消按钮为唯一出口）；
 * - 成功按 kind 分流：file → 直接下载；raster → 客户端 canvas 光栅化为
 *   PNG 长图或免打印多页 PDF（全程无 window.print() 对话框）；
 *   print → 打开打印窗口（仅旧契约降级路径）；失败 Toast 提示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Modal, Select, Spinner, Toast, } from '@deepseek-ai/dsh-client-ui-primitives';
import { base64ToBlob, downloadBlob, fetchExportSessions, fetchExportTurns, openPrintHtml, runExport, runExportBatch, } from '../api.js';
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
/** 回合角色 → 徽章展示名。 */
function roleLabel(role) {
    if (role === 'user')
        return '用户';
    if (role === 'assistant')
        return '助手';
    return role;
}
/** 回合角色 → 徽章配色类（用户蓝 / 助手绿 / 其余中性）。 */
function roleBadgeClass(role) {
    if (role === 'user')
        return styles.turnBadgeUser;
    if (role === 'assistant')
        return styles.turnBadgeAssistant;
    return styles.turnBadgeOther;
}
/** 中止类错误判定（fetch 中止与光栅取消统一为 DOMException AbortError）。 */
function isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
}
/** 导出对话框：格式/选项 + 回合级选择 + 批量会话多选 + 加载态与 Toast 反馈。 */
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
    /** 批量选择的标题/ID 筛选词（客户端实时过滤，不分发服务端）。 */
    const [sessionFilter, setSessionFilter] = useState('');
    /** 回合预览列表（单会话模式的回合选择面板数据源）。 */
    const [turns, setTurns] = useState([]);
    const [checkedTurns, setCheckedTurns] = useState(new Set());
    const [turnsLoading, setTurnsLoading] = useState(false);
    const [turnsError, setTurnsError] = useState('');
    const [exporting, setExporting] = useState(false);
    /** 光栅化进度文案（分片/页计数），空串表示无进度信息。 */
    const [progressLabel, setProgressLabel] = useState('');
    /** 挂载标记：异步回调在 setState 前检查，防止卸载后更新状态。 */
    const mountedRef = useRef(true);
    /** 进行中导出的中止控制器（API 请求与光栅化共用同一信号）。 */
    const abortRef = useRef(null);
    // 维护 mountedRef：StrictMode 下 effect 会重执行，故在 effect 内重置。
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            // 卸载即中止进行中的导出：光栅化在后台继续只是白烧 CPU/内存，
            // 而全部 setState 守卫已失效，产物与进度无处可去。
            abortRef.current?.abort();
        };
    }, []);
    // 打开对话框（单会话模式）时拉取回合预览列表；sessionId 变化时重拉，
    // 前一轮流询请求随 effect 清理中止；关闭时重置选择状态。
    // 批量模式下回合选择无意义（多会话无统一回合列表），不拉取。
    useEffect(() => {
        if (!props.open || batch || !sessionId)
            return;
        const controller = new AbortController();
        setTurnsLoading(true);
        setTurnsError('');
        setTurns([]);
        setCheckedTurns(new Set());
        fetchExportTurns(sessionId, { signal: controller.signal })
            .then((response) => {
            if (!mountedRef.current || controller.signal.aborted)
                return;
            setTurns(response.turns);
            // 默认全选：与“导出全部回合”等价（此时不携带 turns 字段）。
            setCheckedTurns(new Set(response.turns.map((turn) => turn.index)));
        })
            .catch((error) => {
            if (!mountedRef.current || controller.signal.aborted || isAbortError(error))
                return;
            setTurnsError(error instanceof Error ? error.message : '回合列表加载失败');
        })
            .finally(() => {
            if (mountedRef.current && !controller.signal.aborted)
                setTurnsLoading(false);
        });
        return () => {
            controller.abort();
        };
    }, [props.open, batch, sessionId]);
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
    /** 批量筛选结果：按标题或会话 ID 子串匹配（大小写不敏感）。 */
    const filteredSessions = useMemo(() => {
        const keyword = sessionFilter.trim().toLowerCase();
        if (!keyword)
            return sessions;
        return sessions.filter((session) => (session.title ?? '').toLowerCase().includes(keyword) ||
            session.id.toLowerCase().includes(keyword));
    }, [sessions, sessionFilter]);
    /**
     * 全选：作用于当前筛选结果并与已有选择取并集（筛选态下即「选中全部匹配项」，
     * 未筛选时即全量）；不匹配的已选会话保持选中不被清除。
     */
    const selectAllSessions = useCallback(() => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const session of filteredSessions)
                next.add(session.id);
            return next;
        });
    }, [filteredSessions]);
    /** 全不选：清空全部已选会话（含被筛选隐藏的）。 */
    const selectNoSessions = useCallback(() => {
        setSelectedIds(new Set());
    }, []);
    /** 勾选/取消勾选某个回合。 */
    const toggleTurn = useCallback((index) => {
        setCheckedTurns((prev) => {
            const next = new Set(prev);
            if (next.has(index))
                next.delete(index);
            else
                next.add(index);
            return next;
        });
    }, []);
    /** 全选/全不选回合。 */
    const selectAllTurns = useCallback(() => {
        setCheckedTurns(new Set(turns.map((turn) => turn.index)));
    }, [turns]);
    const selectNoTurns = useCallback(() => {
        setCheckedTurns(new Set());
    }, []);
    /** 重拉回合列表（错误态重试入口）。 */
    const reloadTurns = useCallback(() => {
        // 复用同一 effect 的拉取语义：临时切换 open 触发重跑成本高，
        // 这里直接内联拉取（与 effect 相同的守卫纪律）。
        if (!sessionId)
            return;
        const controller = new AbortController();
        setTurnsLoading(true);
        setTurnsError('');
        fetchExportTurns(sessionId, { signal: controller.signal })
            .then((response) => {
            if (!mountedRef.current || controller.signal.aborted)
                return;
            setTurns(response.turns);
            setCheckedTurns(new Set(response.turns.map((turn) => turn.index)));
        })
            .catch((error) => {
            if (!mountedRef.current || controller.signal.aborted || isAbortError(error))
                return;
            setTurnsError(error instanceof Error ? error.message : '回合列表加载失败');
        })
            .finally(() => {
            if (mountedRef.current && !controller.signal.aborted)
                setTurnsLoading(false);
        });
    }, [sessionId]);
    /** 中止进行中的导出（取消按钮在导出中的唯一职责）。 */
    const abortExport = useCallback(() => {
        abortRef.current?.abort();
    }, []);
    /**
     * 对话框关闭请求：导出进行中忽略（Esc/点击遮罩不关闭面板，
     * 对齐 dsh-conv-export 的纪律——进行中以「中止导出」按钮为唯一出口）。
     */
    const requestClose = useCallback(() => {
        if (exporting)
            return;
        onClose();
    }, [exporting, onClose]);
    /** 执行导出：区分单会话与批量，按响应 kind 触发下载或打印（mounted 守卫）。 */
    const handleExport = useCallback(async () => {
        if (exporting)
            return;
        setExporting(true);
        setProgressLabel('');
        const controller = new AbortController();
        abortRef.current = controller;
        const onProgress = (done, total) => {
            if (mountedRef.current)
                setProgressLabel(`正在导出… ${done}/${total}`);
        };
        // 内容高度超出产品上限被截断时显式告知（静默截断会让用户误以为导出完整）。
        const onTruncated = () => {
            if (mountedRef.current)
                Toast.push('内容过长，超出导出上限，已截断超出部分', 'warning');
        };
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
                const result = await runExportBatch({ sessionIds, format, timestamps, redact }, { signal: controller.signal });
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
                // 回合级选择：全选时不携带 turns（导出全部）；部分选择传选中下标。
                if (turns.length > 0 && checkedTurns.size === 0) {
                    Toast.push('请至少勾选一个回合', 'warning');
                    return;
                }
                const turnIndices = turns.length > 0 && checkedTurns.size < turns.length
                    ? [...checkedTurns].sort((a, b) => a - b)
                    : undefined;
                const result = await runExport({ sessionId, format, timestamps, redact, turns: turnIndices }, { signal: controller.signal });
                if (!mountedRef.current)
                    return;
                if (result.kind === 'file') {
                    downloadBlob(base64ToBlob(result.contentBase64, result.mimeType), result.fileName);
                }
                else if (result.kind === 'raster') {
                    // 客户端光栅化：PNG 长图或免打印多页 PDF（无 window.print() 对话框）；
                    // 分片进度经 onProgress 更新按钮文案，取消信号贯穿逐片光栅（mounted 守卫）。
                    if (result.target === 'png') {
                        await exportLongPng(result.html, result.fileName, {
                            onProgress,
                            onTruncated,
                            signal: controller.signal,
                        });
                    }
                    else {
                        await exportRasterPdf(result.html, result.fileName, {
                            onProgress,
                            onTruncated,
                            signal: controller.signal,
                        });
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
            if (isAbortError(error)) {
                Toast.push('已中止导出', 'info');
            }
            else {
                Toast.push(error instanceof Error ? error.message : '导出失败，请稍后重试', 'error');
            }
        }
        finally {
            abortRef.current = null;
            if (mountedRef.current) {
                setExporting(false);
                setProgressLabel('');
            }
        }
    }, [exporting, batch, selectedIds, format, timestamps, redact, sessionId, turns, checkedTurns, onClose]);
    /** 导出按钮文案：批量 = 所选会话数；单会话部分选择 = 已选/总回合数。 */
    const exportButtonLabel = batch
        ? `导出所选（${selectedIds.size}）`
        : turns.length > 0 && checkedTurns.size < turns.length
            ? `导出所选回合（${checkedTurns.size}/${turns.length}）`
            : '导出';
    /** 回合选择区块可见性：单会话模式且有当前会话（批量模式隐藏）。 */
    const showTurns = !batch && Boolean(sessionId);
    return (_jsx(Modal, { open: props.open, title: "\u5BFC\u51FA\u5BF9\u8BDD", onClose: requestClose, footer: _jsxs("div", { className: styles.footer, children: [_jsx(Button, { variant: "ghost", onClick: exporting ? abortExport : requestClose, children: exporting ? '中止导出' : '取消' }), _jsx(Button, { variant: "primary", onClick: () => void handleExport(), disabled: exporting || (showTurns && !turnsLoading && !turnsError && turns.length === 0), children: exporting ? _jsx(Spinner, { label: progressLabel || '正在导出…' }) : exportButtonLabel })] }), children: _jsxs("div", { className: styles.body, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { className: styles.fieldLabel, children: "\u5BFC\u51FA\u683C\u5F0F" }), _jsx(Select, { value: format, onChange: (event) => setFormat(event.target.value), children: FORMAT_OPTIONS.map((option) => (_jsx("option", { value: option.value, children: option.label }, option.value))) })] }), _jsxs("div", { className: styles.options, children: [_jsx(Checkbox, { checked: timestamps, onChange: setTimestamps, label: "\u4FDD\u7559\u65F6\u95F4\u6233" }), _jsx(Checkbox, { checked: redact, onChange: setRedact, label: "\u9690\u79C1\u8131\u654F\uFF08\u79FB\u9664\u624B\u673A\u53F7 / \u90AE\u7BB1 / API Key \u7B49\u654F\u611F\u4FE1\u606F\uFF09" }), _jsx(Checkbox, { checked: batch, onChange: handleBatchToggle, label: "\u6279\u91CF\u5BFC\u51FA\uFF08\u591A\u9009\u4F1A\u8BDD\uFF0C\u6253\u5305\u4E3A ZIP\uFF09" })] }), showTurns ? (_jsxs("div", { className: styles.turnSection, children: [_jsxs("div", { className: styles.turnToolbar, children: [_jsx("span", { className: styles.turnSectionLabel, children: "\u5BFC\u51FA\u56DE\u5408" }), _jsxs("div", { className: styles.turnToolbarButtons, children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: selectAllTurns, disabled: turns.length === 0, children: "\u5168\u9009" }), _jsx(Button, { variant: "ghost", size: "sm", onClick: selectNoTurns, disabled: turns.length === 0, children: "\u5168\u4E0D\u9009" })] }), _jsxs("span", { className: styles.turnCount, children: ["\u5DF2\u9009 ", checkedTurns.size, "/", turns.length] })] }), _jsxs("div", { className: styles.turnList, children: [turnsLoading ? _jsx(Spinner, { label: "\u52A0\u8F7D\u56DE\u5408\u5217\u8868\u2026" }) : null, !turnsLoading && turnsError ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: turnsError }), _jsx(Button, { variant: "ghost", size: "sm", onClick: reloadTurns, children: "\u91CD\u8BD5" })] })) : null, !turnsLoading && !turnsError && turns.length === 0 ? (_jsx("div", { className: styles.empty, children: "\u8BE5\u4F1A\u8BDD\u6682\u65E0\u53EF\u5BFC\u51FA\u7684\u56DE\u5408" })) : null, !turnsLoading && !turnsError
                                    ? turns.map((turn) => {
                                        const checked = checkedTurns.has(turn.index);
                                        return (_jsx("div", { className: checked ? styles.turnItemChecked : styles.turnItem, "data-role": turn.role, children: _jsx(Checkbox, { checked: checked, onChange: () => toggleTurn(turn.index), label: _jsxs("span", { className: styles.turnMeta, children: [_jsx("span", { className: roleBadgeClass(turn.role), children: roleLabel(turn.role) }), _jsx("span", { className: styles.turnPreview, title: turn.preview, children: turn.preview }), _jsx("span", { className: styles.turnTime, children: formatTime(turn.time) })] }) }) }, turn.index));
                                    })
                                    : null] })] })) : null, batch ? (_jsxs("div", { className: styles.sessionSection, children: [_jsxs("div", { className: styles.sessionToolbar, children: [_jsx("span", { className: styles.sessionSectionLabel, children: "\u9009\u62E9\u4F1A\u8BDD" }), _jsxs("div", { className: styles.sessionToolbarButtons, children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: selectAllSessions, disabled: sessions.length === 0, title: "\u9009\u4E2D\u5F53\u524D\u5217\u8868\u4E2D\u7684\u5168\u90E8\u4F1A\u8BDD\uFF08\u7B5B\u9009\u65F6\u4EC5\u9009\u4E2D\u5339\u914D\u9879\uFF0C\u5DF2\u9009\u4F1A\u8BDD\u4E0D\u4F1A\u88AB\u6E05\u9664\uFF09", children: "\u5168\u9009" }), _jsx(Button, { variant: "ghost", size: "sm", onClick: selectNoSessions, disabled: sessions.length === 0, children: "\u5168\u4E0D\u9009" })] }), _jsxs("span", { className: styles.sessionCount, children: ["\u5DF2\u9009 ", selectedIds.size, "/", sessions.length] })] }), _jsx(Input, { type: "search", value: sessionFilter, onChange: (event) => setSessionFilter(event.target.value), placeholder: "\u6309\u6807\u9898\u6216\u4F1A\u8BDD ID \u7B5B\u9009\u2026" }), _jsxs("div", { className: styles.sessionList, children: [sessionsLoading ? _jsx(Spinner, { label: "\u52A0\u8F7D\u4F1A\u8BDD\u5217\u8868\u2026" }) : null, !sessionsLoading && sessionsError ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: sessionsError }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => void loadSessions(), children: "\u91CD\u8BD5" })] })) : null, !sessionsLoading && !sessionsError && sessions.length === 0 ? (_jsx("div", { className: styles.empty, children: "\u6682\u65E0\u53EF\u5BFC\u51FA\u7684\u4F1A\u8BDD" })) : null, !sessionsLoading && !sessionsError &&
                                    sessions.length > 0 &&
                                    filteredSessions.length === 0 ? (_jsxs("div", { className: styles.empty, children: ["\u6CA1\u6709\u5339\u914D\u300C", sessionFilter.trim(), "\u300D\u7684\u4F1A\u8BDD"] })) : null, !sessionsLoading && !sessionsError
                                    ? filteredSessions.map((session) => {
                                        const checked = selectedIds.has(session.id);
                                        return (_jsx("div", { className: checked ? styles.sessionItemChecked : styles.sessionItem, children: _jsx(Checkbox, { checked: checked, onChange: () => toggleSelected(session.id), label: _jsxs("span", { className: styles.sessionMeta, children: [_jsx("span", { className: styles.sessionTitle, children: session.title ?? `会话 ${session.id}` }), _jsx("span", { className: styles.sessionTime, children: formatTime(session.createdAt) })] }) }) }, session.id));
                                    })
                                    : null] })] })) : null, !batch && !props.sessionId ? (_jsx("div", { className: styles.hint, children: "\u672A\u68C0\u6D4B\u5230\u5F53\u524D\u4F1A\u8BDD\uFF0C\u53EF\u52FE\u9009\u201C\u6279\u91CF\u5BFC\u51FA\u201D\u4ECE\u5217\u8868\u4E2D\u9009\u62E9\u4F1A\u8BDD\u3002" })) : null] }) }));
}
