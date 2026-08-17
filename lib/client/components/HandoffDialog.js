import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 交接摘要对话框（模块 B 客户端 UI）：
 * - 打开后若有 sessionId 自动 POST /handoff/generate 生成当前会话摘要；
 * - 结果置于可编辑 Textarea，可复制到剪贴板、保存为模板、作为新对话起点武装；
 * - 模板列表支持载入与删除；加载与错误态齐全。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Spinner, Textarea, Toast, } from '@deepseek-ai/dsh-client-ui-primitives';
import { deleteHandoffTemplate, fetchHandoffTemplates, generateHandoff, importHandoff, saveHandoffTemplate, } from '../api.js';
import styles from './HandoffDialog.module.css';
/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
/** 交接摘要对话框：生成/编辑摘要 + 模板管理 + 武装到新对话。 */
export function HandoffDialog(props) {
    /** 当前会话 id（const 局部量，便于在回调中保持类型收窄）。 */
    const sessionId = props.sessionId;
    const [summary, setSummary] = useState('');
    const [model, setModel] = useState('');
    const [generating, setGenerating] = useState(false);
    const [generateError, setGenerateError] = useState('');
    const [templates, setTemplates] = useState([]);
    const [templatesLoading, setTemplatesLoading] = useState(false);
    const [templatesError, setTemplatesError] = useState('');
    const [templateName, setTemplateName] = useState('');
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [importing, setImporting] = useState(false);
    const [deletingName, setDeletingName] = useState(null);
    /** 脏标记：用户一旦手动编辑过摘要，后续（慢）生成结果返回时不再覆盖内容。 */
    const dirtyRef = useRef(false);
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
            const result = await generateHandoff({ sessionId: targetSessionId }, { signal });
            if (cancelled())
                return;
            if (!dirtyRef.current) {
                setSummary(result.summary);
            }
            setModel(result.model);
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
    /** 拉取模板列表。 */
    const loadTemplates = useCallback(async () => {
        setTemplatesLoading(true);
        setTemplatesError('');
        try {
            const response = await fetchHandoffTemplates();
            setTemplates(response.templates);
        }
        catch (error) {
            setTemplatesError(error instanceof Error ? error.message : '模板列表加载失败');
        }
        finally {
            setTemplatesLoading(false);
        }
    }, []);
    // 打开对话框：刷新模板列表；有 sessionId 时自动生成交接摘要。
    // 摘要生成可能较慢：以 AbortController + cancelled 守卫，卸载 / sessionId 变化时取消在途请求，
    // 避免过期响应覆盖新会话的状态；每次重新打开（或切换会话）时重置脏标记。
    useEffect(() => {
        if (!props.open)
            return;
        const controller = new AbortController();
        let cancelled = false;
        void loadTemplates();
        if (sessionId) {
            dirtyRef.current = false;
            void generate(sessionId, controller.signal, () => cancelled);
        }
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [props.open, sessionId, loadTemplates, generate]);
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
     * 武装成功后派发 `companion:armed-changed` 自定义事件，供 dock（ImportSummaryDock）刷新武装状态。
     */
    const handleImport = useCallback(async () => {
        if (!summary.trim()) {
            Toast.push('摘要内容为空，无法武装到新对话', 'warning');
            return;
        }
        setImporting(true);
        try {
            await importHandoff({ summary });
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
    }, [summary, props.onClose]);
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
    return (_jsx(Modal, { open: props.open, title: "\u4EA4\u63A5\u6458\u8981", onClose: props.onClose, footer: _jsx("div", { className: styles.footer, children: _jsx(Button, { variant: "ghost", onClick: props.onClose, children: "\u5173\u95ED" }) }), children: _jsxs("div", { className: styles.body, children: [_jsxs("div", { className: styles.status, children: [generating ? _jsx(Spinner, { label: "\u6B63\u5728\u751F\u6210\u5F53\u524D\u4F1A\u8BDD\u7684\u4EA4\u63A5\u6458\u8981\u2026" }) : null, !generating && generateError ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: generateError }), sessionId ? (_jsx(Button, { variant: "ghost", size: "sm", onClick: () => void generate(sessionId), children: "\u91CD\u8BD5" })) : null] })) : null] }), _jsx(Textarea, { className: styles.summaryInput, rows: 10, value: summary, disabled: generating, onChange: (event) => {
                        // 用户手动输入即置脏：后续（慢）生成结果返回时不再覆盖已编辑内容
                        dirtyRef.current = true;
                        setSummary(event.target.value);
                    }, placeholder: "\u751F\u6210\u7684\u4EA4\u63A5\u6458\u8981\u5C06\u663E\u793A\u5728\u8FD9\u91CC\uFF1B\u4E5F\u53EF\u4EE5\u76F4\u63A5\u7C98\u8D34\u6216\u7F16\u8F91\u5185\u5BB9\u2026" }), model ? _jsxs("div", { className: styles.modelInfo, children: ["\u751F\u6210\u6A21\u578B\uFF1A", model] }) : null, _jsxs("div", { className: styles.actions, children: [_jsx(Button, { variant: "secondary", onClick: () => void handleCopy(), children: "\u590D\u5236\u5230\u526A\u8D34\u677F" }), _jsx(Button, { variant: "primary", onClick: () => void handleImport(), disabled: importing, children: importing ? _jsx(Spinner, { label: "\u6B66\u88C5\u4E2D\u2026" }) : '作为新对话起点' })] }), _jsxs("div", { className: styles.section, children: [_jsx("div", { className: styles.sectionTitle, children: "\u4FDD\u5B58\u4E3A\u6A21\u677F" }), _jsxs("div", { className: styles.templateNameRow, children: [_jsx(Input, { className: styles.templateNameInput, value: templateName, onChange: (event) => setTemplateName(event.target.value), onKeyDown: (event) => {
                                        // Enter 快捷提交：与“保存为模板”按钮等价
                                        if (event.key === 'Enter' && !savingTemplate)
                                            void handleSaveTemplate();
                                    }, placeholder: "\u6A21\u677F\u540D\u79F0\uFF0C\u5982\uFF1A\u524D\u7AEF\u9879\u76EE\u4EA4\u63A5" }), _jsx(Button, { variant: "secondary", onClick: () => void handleSaveTemplate(), disabled: savingTemplate, children: savingTemplate ? _jsx(Spinner, { label: "\u4FDD\u5B58\u4E2D\u2026" }) : '保存为模板' })] })] }), _jsxs("div", { className: styles.section, children: [_jsx("div", { className: styles.sectionTitle, children: "\u6211\u7684\u6A21\u677F" }), templatesLoading ? _jsx(Spinner, { label: "\u52A0\u8F7D\u6A21\u677F\u5217\u8868\u2026" }) : null, !templatesLoading && templatesError ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: templatesError }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => void loadTemplates(), children: "\u91CD\u8BD5" })] })) : null, !templatesLoading && !templatesError && templates.length === 0 ? (_jsx("div", { className: styles.empty, children: "\u6682\u65E0\u6A21\u677F\uFF0C\u4FDD\u5B58\u6458\u8981\u540E\u53EF\u5728\u6B64\u590D\u7528" })) : null, !templatesLoading && !templatesError
                            ? templates.map((template) => (_jsxs("div", { className: styles.templateItem, children: [_jsxs("div", { className: styles.templateMeta, children: [_jsx("span", { className: styles.templateName, children: template.name }), _jsxs("span", { className: styles.templateTime, children: ["\u66F4\u65B0\u4E8E ", formatTime(template.updatedAt)] })] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => handleLoadTemplate(template), children: "\u8F7D\u5165" }), _jsx(Button, { variant: "danger", size: "sm", onClick: () => void handleDeleteTemplate(template.name), disabled: deletingName === template.name, children: deletingName === template.name ? _jsx(Spinner, { label: "\u5220\u9664\u4E2D\u2026" }) : '删除' })] }, template.name)))
                            : null] })] }) }));
}
