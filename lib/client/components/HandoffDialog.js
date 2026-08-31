import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 交接摘要对话框（模块 B 客户端 UI）：
 * - 会话选择可视化面板：列出全部历史会话（复用 GET /export/sessions），
 *   支持按标题/ID 实时筛选、单选任意会话（不限于当前会话）、当前会话
 *   带「当前」徽章；打开时默认选中当前会话并自动生成摘要，
 *   切换选中后自动重新生成（取消在途请求、重置脏标记）；
 * - 结果置于可编辑 Textarea，可复制到剪贴板、保存为模板、作为新对话起点武装；
 * - 模板列表支持载入与删除；加载与错误态齐全。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Modal, Spinner, Textarea, Toast, } from '@deepseek-ai/dsh-client-ui-primitives';
import { deleteHandoffTemplate, fetchContextHealth, fetchExportSessions, fetchHandoffLineage, fetchHandoffTemplates, generateHandoff, importHandoff, saveHandoffTemplate, } from '../api.js';
import styles from './HandoffDialog.module.css';
/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
/** 交接摘要对话框：会话选择 + 生成/编辑摘要 + 模板管理 + 武装到新对话。 */
export function HandoffDialog(props) {
    /** 当前会话 id（const 局部量，便于在回调中保持类型收窄）。 */
    const sessionId = props.sessionId;
    /** 会话选择面板状态：历史会话列表 + 选中项 + 筛选词。 */
    const [sessions, setSessions] = useState([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [sessionsError, setSessionsError] = useState('');
    const [selectedSessionId, setSelectedSessionId] = useState('');
    const [sessionFilter, setSessionFilter] = useState('');
    const [summary, setSummary] = useState('');
    const [model, setModel] = useState('');
    const [stats, setStats] = useState(undefined);
    const [generating, setGenerating] = useState(false);
    const [generateError, setGenerateError] = useState('');
    /** 查询聚焦主题（轴线 2）：输入不自动触发，Enter/按钮显式重新生成。 */
    const [focus, setFocus] = useState('');
    const focusRef = useRef('');
    focusRef.current = focus;
    /** 所选会话的上下文血缘（轴线 2 继承图谱）。 */
    const [lineage, setLineage] = useState(undefined);
    const [lineageLoading, setLineageLoading] = useState(false);
    const [lineageError, setLineageError] = useState('');
    /** 上下文压力评估（轴线 6）：token 估算 / 耗尽预测 / 分级建议。 */
    const [health, setHealth] = useState(undefined);
    const [templates, setTemplates] = useState([]);
    const [templatesLoading, setTemplatesLoading] = useState(false);
    const [templatesError, setTemplatesError] = useState('');
    const [templateName, setTemplateName] = useState('');
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [importing, setImporting] = useState(false);
    const [deletingName, setDeletingName] = useState(null);
    /** 重试令牌：手动重试经此并入生成 effect，复用其取消守卫（杜绝并发竞态）。 */
    const [retryToken, setRetryToken] = useState(0);
    /** 脏标记：用户一旦手动编辑过摘要，后续（慢）生成结果返回时不再覆盖内容。 */
    const dirtyRef = useRef(false);
    /** 挂载守卫：卸载后的异步回调不再触碰状态。 */
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    /** 调用服务端为指定会话生成交接摘要。
     *
     * - signal 被中止或 isCancelled 为真（卸载 / sessionId 变化）时静默返回，不再更新任何状态；
     * - 用户已手动编辑过内容（dirtyRef）时，返回的摘要不再覆盖编辑区。
     */
    const generate = useCallback(async (targetSessionId, signal, isCancelled) => {
        /** 统一取消判定：外部 cancelled 守卫或中止信号任一生效即视为已取消。 */
        const cancelled = () => (signal?.aborted ?? false) || (isCancelled?.() ?? false);
        setGenerating(true);
        setGenerateError('');
        try {
            // focus 从 ref 读取（输入不触发重生成，Enter/按钮经 retryToken 显式触发）。
            const appliedFocus = focusRef.current.trim();
            const result = await generateHandoff({ sessionId: targetSessionId, focus: appliedFocus || undefined }, { signal });
            if (cancelled())
                return;
            if (!dirtyRef.current) {
                setSummary(result.summary);
            }
            setModel(result.model);
            setStats(result.stats);
        }
        catch (error) {
            if (cancelled())
                return;
            setGenerateError(error instanceof Error ? error.message : '交接摘要生成失败');
        }
        finally {
            if (!cancelled())
                setGenerating(false);
        }
    }, []);
    /** 拉取模板列表（带挂载守卫，卸载/重开后过期响应不回写）。 */
    const loadTemplates = useCallback(async () => {
        const request = ++templatesRequestRef.current;
        setTemplatesLoading(true);
        setTemplatesError('');
        try {
            const response = await fetchHandoffTemplates();
            if (!mountedRef.current || request !== templatesRequestRef.current)
                return;
            setTemplates(response.templates);
        }
        catch (error) {
            if (!mountedRef.current || request !== templatesRequestRef.current)
                return;
            setTemplatesError(error instanceof Error ? error.message : '模板列表加载失败');
        }
        finally {
            if (mountedRef.current && request === templatesRequestRef.current)
                setTemplatesLoading(false);
        }
    }, []);
    /** 模板列表请求序号：仅最新一次请求允许回写（防乱序覆盖）。 */
    const templatesRequestRef = useRef(0);
    /** 拉取历史会话列表（会话选择面板数据源；复用模块 A 的 /export/sessions）。 */
    const loadSessions = useCallback(async () => {
        const request = ++sessionsRequestRef.current;
        setSessionsLoading(true);
        setSessionsError('');
        try {
            const response = await fetchExportSessions();
            if (!mountedRef.current || request !== sessionsRequestRef.current)
                return;
            setSessions(response.sessions);
        }
        catch (error) {
            if (!mountedRef.current || request !== sessionsRequestRef.current)
                return;
            setSessionsError(error instanceof Error ? error.message : '会话列表加载失败');
        }
        finally {
            if (mountedRef.current && request === sessionsRequestRef.current)
                setSessionsLoading(false);
        }
    }, []);
    /** 会话列表请求序号：仅最新一次请求允许回写（防乱序覆盖）。 */
    const sessionsRequestRef = useRef(0);
    /** 会话筛选结果：按标题或会话 ID 子串匹配（大小写不敏感）。 */
    const filteredSessions = useMemo(() => {
        const keyword = sessionFilter.trim().toLowerCase();
        if (!keyword)
            return sessions;
        return sessions.filter((session) => (session.title ?? '').toLowerCase().includes(keyword) ||
            session.id.toLowerCase().includes(keyword));
    }, [sessions, sessionFilter]);
    // 打开对话框：刷新模板与会话列表；默认选中当前会话（存在时）。
    // 无当前会话则不预选，用户从列表手动选择后才开始生成。
    useEffect(() => {
        if (!props.open)
            return;
        setSessionFilter('');
        setSelectedSessionId(sessionId ?? '');
        void loadTemplates();
        void loadSessions();
    }, [props.open, sessionId, loadTemplates, loadSessions]);
    // 选中会话变化时自动生成交接摘要（打开时的默认选中同样经此触发；
    // 手动重试经 retryToken 并入本 effect，复用同一套取消守卫）。
    // 摘要生成可能较慢：以 AbortController + cancelled 守卫，卸载 / 切换选中 /
    // 重试时取消在途请求，避免过期响应覆盖新选中会话的状态；每次切换重置
    // 脏标记（切换即表明用户想要新会话的摘要，编辑中的旧内容不再保留）。
    useEffect(() => {
        if (!props.open || !selectedSessionId)
            return;
        const controller = new AbortController();
        let cancelled = false;
        dirtyRef.current = false;
        setStats(undefined);
        void generate(selectedSessionId, controller.signal, () => cancelled);
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [props.open, selectedSessionId, generate, retryToken]);
    // 选中会话变化时拉取上下文血缘（轴线 2 继承图谱；失败静默不阻塞摘要）。
    useEffect(() => {
        if (!props.open || !selectedSessionId) {
            setLineage(undefined);
            setLineageError('');
            return;
        }
        let cancelled = false;
        setLineageLoading(true);
        setLineageError('');
        fetchHandoffLineage(selectedSessionId)
            .then((response) => {
            if (!cancelled)
                setLineage({ ancestors: response.ancestors, descendants: response.descendants });
        })
            .catch((err) => {
            if (!cancelled)
                setLineageError(err instanceof Error ? err.message : '血缘查询失败');
        })
            .finally(() => {
            if (!cancelled)
                setLineageLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [props.open, selectedSessionId]);
    // 选中会话变化时拉取上下文压力评估（轴线 6；失败静默不阻塞摘要）。
    useEffect(() => {
        if (!props.open || !selectedSessionId) {
            setHealth(undefined);
            return;
        }
        let cancelled = false;
        fetchContextHealth(selectedSessionId)
            .then((response) => {
            if (!cancelled)
                setHealth(response);
        })
            .catch(() => {
            // 压力评估失败：不展示仪表，不阻塞摘要主流程。
            if (!cancelled)
                setHealth(undefined);
        });
        return () => {
            cancelled = true;
        };
    }, [props.open, selectedSessionId]);
    /** 选中某个会话（单选）：点击已选中项不重复触发生成。 */
    const selectSession = useCallback((id) => {
        setSelectedSessionId((prev) => (prev === id ? prev : id));
    }, []);
    /** 复制当前摘要到剪贴板。 */
    const handleCopy = useCallback(async () => {
        if (!summary.trim()) {
            Toast.push('没有可复制的内容', 'warning');
            return;
        }
        try {
            await navigator.clipboard.writeText(summary);
            Toast.push('已复制到剪贴板', 'success');
        }
        catch {
            Toast.push('复制失败：浏览器未授权剪贴板访问', 'error');
        }
    }, [summary]);
    /** 以输入的名称保存当前摘要为模板。 */
    const handleSaveTemplate = useCallback(async () => {
        const name = templateName.trim();
        if (!name) {
            Toast.push('请输入模板名称', 'warning');
            return;
        }
        if (!summary.trim()) {
            Toast.push('摘要内容为空，无法保存模板', 'warning');
            return;
        }
        setSavingTemplate(true);
        try {
            await saveHandoffTemplate({ name, content: summary });
            Toast.push(`模板「${name}」已保存`, 'success');
            setTemplateName('');
            await loadTemplates();
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : '模板保存失败', 'error');
        }
        finally {
            setSavingTemplate(false);
        }
    }, [templateName, summary, loadTemplates]);
    /** 将当前摘要作为新对话起点：不带 sessionId 导入 = 武装给下一个新对话。
     *
     * 携带 sourceSessionId（当前选中会话）记录继承图谱边（轴线 2）。
     * 武装成功后派发 `companion:armed-changed` 自定义事件，供 dock（ImportSummaryDock）刷新武装状态。
     */
    const handleImport = useCallback(async () => {
        if (!summary.trim()) {
            Toast.push('摘要内容为空，无法武装到新对话', 'warning');
            return;
        }
        setImporting(true);
        try {
            await importHandoff({
                summary,
                sourceSessionId: selectedSessionId || undefined,
            });
            window.dispatchEvent(new CustomEvent('companion:armed-changed'));
            Toast.push('已武装给下一个新对话，新建对话时将自动注入该摘要', 'success');
            props.onClose();
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : '武装摘要失败', 'error');
        }
        finally {
            setImporting(false);
        }
    }, [summary, selectedSessionId, props.onClose]);
    /** 载入模板内容到编辑区（视为用户主动设置的内容，同样置脏以防在途生成覆盖）。 */
    const handleLoadTemplate = useCallback((template) => {
        dirtyRef.current = true;
        setSummary(template.content);
        Toast.push(`已载入模板「${template.name}」，可继续编辑`, 'info');
    }, []);
    /** 删除模板。 */
    const handleDeleteTemplate = useCallback(async (name) => {
        setDeletingName(name);
        try {
            await deleteHandoffTemplate(name);
            Toast.push(`模板「${name}」已删除`, 'success');
            await loadTemplates();
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : '模板删除失败', 'error');
        }
        finally {
            setDeletingName(null);
        }
    }, [loadTemplates]);
    return (_jsx(Modal, { open: props.open, title: "\u4EA4\u63A5\u6458\u8981", onClose: props.onClose, footer: _jsx("div", { className: styles.footer, children: _jsx(Button, { variant: "ghost", onClick: props.onClose, children: "\u5173\u95ED" }) }), children: _jsxs("div", { className: styles.body, children: [_jsxs("div", { className: styles.sessionSection, children: [_jsxs("div", { className: styles.sessionToolbar, children: [_jsx("span", { className: styles.sectionTitle, children: "\u9009\u62E9\u4F1A\u8BDD" }), selectedSessionId ? (_jsxs("span", { className: styles.sessionCount, children: ["\u5DF2\u9009\u4E2D \u00B7 \u5171 ", filteredSessions.length, " \u4E2A\u4F1A\u8BDD"] })) : (_jsxs("span", { className: styles.sessionCount, children: ["\u5171 ", filteredSessions.length, " \u4E2A\u4F1A\u8BDD"] }))] }), _jsx(Input, { type: "search", value: sessionFilter, onChange: (event) => setSessionFilter(event.target.value), placeholder: "\u6309\u6807\u9898\u6216\u4F1A\u8BDD ID \u7B5B\u9009\u2026" }), _jsxs("div", { className: styles.sessionList, children: [sessionsLoading ? _jsx(Spinner, { label: "\u52A0\u8F7D\u4F1A\u8BDD\u5217\u8868\u2026" }) : null, !sessionsLoading && sessionsError ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: sessionsError }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => void loadSessions(), children: "\u91CD\u8BD5" })] })) : null, !sessionsLoading && !sessionsError && sessions.length === 0 ? (_jsx("div", { className: styles.empty, children: "\u6682\u65E0\u53EF\u9009\u62E9\u7684\u4F1A\u8BDD" })) : null, !sessionsLoading &&
                                    !sessionsError &&
                                    sessions.length > 0 &&
                                    filteredSessions.length === 0 ? (_jsxs("div", { className: styles.empty, children: ["\u6CA1\u6709\u5339\u914D\u300C", sessionFilter.trim(), "\u300D\u7684\u4F1A\u8BDD"] })) : null, !sessionsLoading && !sessionsError
                                    ? filteredSessions.map((session) => {
                                        const checked = selectedSessionId === session.id;
                                        const isCurrent = session.id === sessionId;
                                        return (_jsxs("div", { role: "button", tabIndex: 0, className: checked ? styles.sessionItemSelected : styles.sessionItem, onClick: () => selectSession(session.id), onKeyDown: (event) => {
                                                // Enter / Space 与点击等价（键盘可达性）；
                                                // Space 需阻止默认行为，否则会同时触发页面滚动。
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                    selectSession(session.id);
                                                }
                                            }, children: [_jsx("span", { className: checked ? styles.radioOn : styles.radioOff, "aria-hidden": "true" }), _jsxs("span", { className: styles.sessionMeta, children: [_jsxs("span", { className: styles.sessionTitleRow, children: [_jsx("span", { className: styles.sessionTitle, children: session.title ?? `会话 ${session.id}` }), isCurrent ? _jsx("span", { className: styles.currentBadge, children: "\u5F53\u524D" }) : null] }), _jsx("span", { className: styles.sessionTime, children: formatTime(session.createdAt) })] })] }, session.id));
                                    })
                                    : null] }), !selectedSessionId && !sessionsLoading && !sessionsError ? (_jsx("div", { className: styles.hint, children: "\u4ECE\u4E0A\u65B9\u5217\u8868\u9009\u62E9\u4E00\u4E2A\u4F1A\u8BDD\u540E\u81EA\u52A8\u751F\u6210\u4EA4\u63A5\u6458\u8981\u3002" })) : null] }), health !== undefined ? (_jsxs("div", { className: `${styles.pressureRow} ${styles[`pressure_${health.level}`] ?? ''}`, children: [_jsxs("div", { className: styles.pressureHead, children: [_jsx("span", { className: styles.pressureLabel, children: "\u4E0A\u4E0B\u6587\u538B\u529B" }), _jsxs("span", { className: styles.pressureValue, children: [Math.round(health.ratio * 100), "%\uFF08\u7EA6 ", health.estimatedTokens, " token\uFF09"] }), health.remainingTurns !== null ? (_jsxs("span", { className: styles.pressureForecast, children: ["\u6309\u5F53\u524D\u589E\u901F\u7EA6\u8FD8\u53EF ", health.remainingTurns, " \u56DE\u5408"] })) : null] }), _jsx("div", { className: styles.pressureBar, children: _jsx("div", { className: styles.pressureFill, style: { width: `${Math.min(100, Math.round(health.ratio * 100))}%` } }) }), _jsx("span", { className: styles.pressureSuggestion, children: health.suggestion })] })) : null, _jsxs("div", { className: styles.focusRow, children: [_jsx(Input, { className: styles.focusInput, type: "search", value: focus, onChange: (event) => setFocus(event.target.value), onKeyDown: (event) => {
                                // Enter 快捷应用聚焦：与「聚焦重新生成」按钮等价（经 retryToken
                                // 并入生成 effect，复用取消守卫；同时重置脏标记允许覆盖）。
                                if (event.key === 'Enter' && selectedSessionId && !generating) {
                                    dirtyRef.current = false;
                                    setRetryToken((token) => token + 1);
                                }
                            }, placeholder: "\u67E5\u8BE2\u805A\u7126\u4E3B\u9898\uFF08\u53EF\u9009\uFF09\uFF0C\u5982\uFF1A\u90E8\u7F72\u6D41\u7A0B\u3001\u6027\u80FD\u4F18\u5316\u2026" }), _jsx(Button, { variant: "secondary", onClick: () => {
                                if (!selectedSessionId || generating)
                                    return;
                                dirtyRef.current = false;
                                setRetryToken((token) => token + 1);
                            }, disabled: !selectedSessionId || generating, children: "\u805A\u7126\u91CD\u65B0\u751F\u6210" })] }), _jsxs("div", { className: styles.status, children: [generating ? _jsx(Spinner, { label: "\u6B63\u5728\u751F\u6210\u6240\u9009\u4F1A\u8BDD\u7684\u4EA4\u63A5\u6458\u8981\u2026" }) : null, !generating && generateError ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: generateError }), selectedSessionId ? (_jsx(Button, { variant: "ghost", size: "sm", onClick: () => {
                                        // 手动重试 = 用户明确要求重新生成：经 retryToken 并入生成
                                        // effect（自带取消守卫，先取消在途请求再发起新请求），
                                        // 并重置脏标记允许结果覆盖。绝不裸调 generate：那会绕过
                                        // 守卫，在途旧响应可能晚到并覆盖切换后新会话的摘要。
                                        dirtyRef.current = false;
                                        setRetryToken((token) => token + 1);
                                    }, children: "\u91CD\u8BD5" })) : null] })) : null] }), _jsx(Textarea, { className: styles.summaryInput, rows: 10, value: summary, disabled: generating, onChange: (event) => {
                        // 用户手动输入即置脏：后续（慢）生成结果返回时不再覆盖已编辑内容
                        dirtyRef.current = true;
                        setSummary(event.target.value);
                    }, placeholder: "\u751F\u6210\u7684\u4EA4\u63A5\u6458\u8981\u5C06\u663E\u793A\u5728\u8FD9\u91CC\uFF1B\u4E5F\u53EF\u4EE5\u76F4\u63A5\u7C98\u8D34\u6216\u7F16\u8F91\u5185\u5BB9\u2026" }), model ? (_jsxs("div", { className: styles.modelInfo, children: ["\u751F\u6210\u6A21\u578B\uFF1A", model, stats?.hierarchical
                            ? ` · 分层摘要：${stats.chunks} 段（${stats.cachedChunks} 段命中缓存）`
                            : ''] })) : null, selectedSessionId ? (_jsxs("div", { className: styles.lineageSection, children: [_jsx("div", { className: styles.sectionTitle, children: "\u4E0A\u4E0B\u6587\u8840\u7F18" }), lineageLoading ? _jsx(Spinner, { label: "\u67E5\u8BE2\u8840\u7F18\u2026" }) : null, !lineageLoading && lineageError ? (_jsx("div", { className: styles.hint, children: lineageError })) : null, !lineageLoading && !lineageError && lineage ? (lineage.ancestors.length === 0 && lineage.descendants.length === 0 ? (_jsx("div", { className: styles.hint, children: "\u8BE5\u4F1A\u8BDD\u6682\u65E0\u6458\u8981\u8840\u7F18\u8BB0\u5F55" })) : (_jsxs("div", { className: styles.lineageList, children: [lineage.ancestors.length > 0 ? (_jsxs("div", { className: styles.lineageGroup, children: [_jsx("span", { className: styles.lineageLabel, children: "\u2190 \u6765\u6E90\uFF08\u5185\u5BB9\u6D41\u5165\uFF09" }), lineage.ancestors.map((node) => (_jsxs("div", { className: styles.lineageItem, children: [_jsx("span", { className: styles.lineageDepth, children: '←'.repeat(node.depth) }), _jsxs("span", { className: styles.lineageText, children: ["\u4F1A\u8BDD ", node.sessionId.slice(0, 8), "\u2026", node.excerpt ? `「${node.excerpt}」` : ''] })] }, `a-${node.sessionId}`)))] })) : null, lineage.descendants.length > 0 ? (_jsxs("div", { className: styles.lineageGroup, children: [_jsx("span", { className: styles.lineageLabel, children: "\u2192 \u53BB\u5411\uFF08\u5185\u5BB9\u6D41\u5411\uFF09" }), lineage.descendants.map((node) => (_jsxs("div", { className: styles.lineageItem, children: [_jsx("span", { className: styles.lineageDepth, children: '→'.repeat(node.depth) }), _jsxs("span", { className: styles.lineageText, children: ["\u4F1A\u8BDD ", node.sessionId.slice(0, 8), "\u2026", node.excerpt ? `「${node.excerpt}」` : ''] })] }, `d-${node.sessionId}`)))] })) : null] }))) : null] })) : null, _jsxs("div", { className: styles.actions, children: [_jsx(Button, { variant: "secondary", onClick: () => void handleCopy(), children: "\u590D\u5236\u5230\u526A\u8D34\u677F" }), _jsx(Button, { variant: "primary", onClick: () => void handleImport(), disabled: importing, children: importing ? _jsx(Spinner, { label: "\u6B66\u88C5\u4E2D\u2026" }) : '作为新对话起点' })] }), _jsxs("div", { className: styles.section, children: [_jsx("div", { className: styles.sectionTitle, children: "\u4FDD\u5B58\u4E3A\u6A21\u677F" }), _jsxs("div", { className: styles.templateNameRow, children: [_jsx(Input, { className: styles.templateNameInput, value: templateName, onChange: (event) => setTemplateName(event.target.value), onKeyDown: (event) => {
                                        // Enter 快捷提交：与“保存为模板”按钮等价
                                        if (event.key === 'Enter' && !savingTemplate)
                                            void handleSaveTemplate();
                                    }, placeholder: "\u6A21\u677F\u540D\u79F0\uFF0C\u5982\uFF1A\u524D\u7AEF\u9879\u76EE\u4EA4\u63A5" }), _jsx(Button, { variant: "secondary", onClick: () => void handleSaveTemplate(), disabled: savingTemplate, children: savingTemplate ? _jsx(Spinner, { label: "\u4FDD\u5B58\u4E2D\u2026" }) : '保存为模板' })] })] }), _jsxs("div", { className: styles.section, children: [_jsx("div", { className: styles.sectionTitle, children: "\u6211\u7684\u6A21\u677F" }), templatesLoading ? _jsx(Spinner, { label: "\u52A0\u8F7D\u6A21\u677F\u5217\u8868\u2026" }) : null, !templatesLoading && templatesError ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: templatesError }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => void loadTemplates(), children: "\u91CD\u8BD5" })] })) : null, !templatesLoading && !templatesError && templates.length === 0 ? (_jsx("div", { className: styles.empty, children: "\u6682\u65E0\u6A21\u677F\uFF0C\u4FDD\u5B58\u6458\u8981\u540E\u53EF\u5728\u6B64\u590D\u7528" })) : null, !templatesLoading && !templatesError
                            ? templates.map((template) => (_jsxs("div", { className: styles.templateItem, children: [_jsxs("div", { className: styles.templateMeta, children: [_jsx("span", { className: styles.templateName, children: template.name }), _jsxs("span", { className: styles.templateTime, children: ["\u66F4\u65B0\u4E8E ", formatTime(template.updatedAt)] })] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => handleLoadTemplate(template), children: "\u8F7D\u5165" }), _jsx(Button, { variant: "danger", size: "sm", onClick: () => void handleDeleteTemplate(template.name), disabled: deletingName === template.name, children: deletingName === template.name ? _jsx(Spinner, { label: "\u5220\u9664\u4E2D\u2026" }) : '删除' })] }, template.name)))
                            : null] })] }) }));
}
