import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 成本报表视图页（模块 C 客户端 UI，挂载于 conversation.view）：
 * - GET /cost/state 与 GET /cost/report?from&to（默认近 7 天，可切换 7/28 天）；
 * - 开发者模式总开关与 API Key 管理（type=password 输入 + 保存/删除/测试连接）；
 * - 峰谷调度、模型路由开关与日/月双档预算（POST /cost/settings 稀疏补丁）；
 * - 预算进度条（spent/budget，80% 黄、100% 红）；
 * - 动态计价信息区：定价来源（官方实时/内置快照）、抓取时间、峰谷计划，
 *   支持手动触发官方定价页刷新（POST /cost/pricing/refresh）；
 * - 每日 Token/费用以纯 CSS 条形图呈现（div 高度比例，不依赖图表库）；
 * - 汇总卡片：调用数、Token、费用、节省金额、延迟执行数；
 * - 每 60s 轮询 /cost/state，paused 变化时 Toast 预警。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Pill, Spinner, Toast, } from '@deepseek-ai/dsh-client-ui-primitives';
import { fetchCostReport, fetchCostState, refreshCostPricing, removeCostApiKey, saveCostApiKey, testCostCall, updateCostSettings, } from '../api.js';
import styles from './CostReportView.module.css';
/** /cost/state 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 60_000;
/** 本地日期 → YYYY-MM-DD（服务端按北京时间聚合，客户端以本地日期近似）。 */
function dayKey(date) {
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
/** 计算近 N 天的 [from, to] 区间。 */
function rangeFor(days) {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    return { from: dayKey(from), to: dayKey(to) };
}
/** 金额格式化（元，保留 4 位小数）。 */
function formatCny(value) {
    return `¥${value.toFixed(4)}`;
}
/**
 * 浅比较 CostState 的关键字段（视图实际渲染的字段）：
 * 轮询返回的数据若无变化则跳过 setState，避免无谓的重渲染。
 * rules/pricing 本视图不渲染，不参与比较。
 */
function isCostStateEqual(prev, next) {
    return (prev.devMode === next.devMode &&
        prev.apiKeyConfigured === next.apiKeyConfigured &&
        prev.peakScheduling === next.peakScheduling &&
        prev.modelRouting === next.modelRouting &&
        prev.budget.dailyCny === next.budget.dailyCny &&
        prev.budget.dailySpentCny === next.budget.dailySpentCny &&
        prev.budget.dailyRatio === next.budget.dailyRatio &&
        prev.budget.monthlyCny === next.budget.monthlyCny &&
        prev.budget.spentCny === next.budget.spentCny &&
        prev.budget.ratio === next.budget.ratio &&
        prev.budget.paused === next.budget.paused &&
        prev.pricing.source === next.pricing.source &&
        prev.pricing.fetchedAt === next.pricing.fetchedAt &&
        prev.pricing.lastChangedAt === next.pricing.lastChangedAt);
}
/** 成本报表视图页。 */
export function CostReportView(_props) {
    const [costState, setCostState] = useState(null);
    const [stateError, setStateError] = useState('');
    const [report, setReport] = useState(null);
    const [reportLoading, setReportLoading] = useState(false);
    const [reportError, setReportError] = useState('');
    const [rangeDays, setRangeDays] = useState(7);
    const [apiKey, setApiKey] = useState('');
    const [savingKey, setSavingKey] = useState(false);
    const [deletingKey, setDeletingKey] = useState(false);
    const [testing, setTesting] = useState(false);
    const [budgetInput, setBudgetInput] = useState('');
    const [dailyBudgetInput, setDailyBudgetInput] = useState('');
    const [savingSettings, setSavingSettings] = useState(false);
    const [refreshingPricing, setRefreshingPricing] = useState(false);
    /** 上一次观察到的 paused 状态；null 表示尚未建立基线。 */
    const pausedRef = useRef(null);
    /** 拉取成本状态；silent 用于轮询（失败不打扰用户）。检测 paused 变化并 Toast 预警。
     *
     * - signal 中止（卸载）后静默返回，不再更新状态；
     * - setState 前对关键字段浅比较，无变化不触发重渲染。
     */
    const loadState = useCallback(async (silent, signal) => {
        try {
            const next = await fetchCostState({ signal });
            if (signal?.aborted)
                return;
            setCostState((prev) => (prev !== null && isCostStateEqual(prev, next) ? prev : next));
            setStateError('');
            const prev = pausedRef.current;
            pausedRef.current = next.budget.paused;
            if (prev !== null && prev !== next.budget.paused) {
                if (next.budget.paused) {
                    Toast.push('预警：月度预算已用尽，Companion 已暂停 API 调用', 'error');
                }
                else {
                    Toast.push('预算限制已解除，Companion 恢复 API 调用', 'success');
                }
            }
        }
        catch (error) {
            if (signal?.aborted)
                return;
            if (!silent)
                setStateError(error instanceof Error ? error.message : '成本状态加载失败');
        }
    }, []);
    // 挂载：加载状态，并启动链式轮询——上一次请求完成后再 setTimeout 排下一次，
    // 避免 setInterval 在慢响应下堆积并发请求；卸载时 abort 在途请求并清理定时器。
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        let timer = 0;
        const poll = async (silent) => {
            await loadState(silent, controller.signal);
            if (cancelled || controller.signal.aborted)
                return;
            timer = window.setTimeout(() => void poll(true), POLL_INTERVAL_MS);
        };
        void poll(false);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [loadState]);
    // 区间变化时重新加载报表：cancelled 守卫 + abort，快速切换 7/28 天时旧响应不会覆盖新结果。
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        setReportLoading(true);
        setReportError('');
        fetchCostReport(rangeFor(rangeDays), { signal: controller.signal })
            .then((response) => {
            if (!cancelled)
                setReport(response);
        })
            .catch((error) => {
            if (!cancelled)
                setReportError(error instanceof Error ? error.message : '成本报表加载失败');
        })
            .finally(() => {
            if (!cancelled)
                setReportLoading(false);
        });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [rangeDays]);
    /** 提交设置补丁并刷新状态。 */
    const applySettings = useCallback(async (patch, successMessage) => {
        setSavingSettings(true);
        try {
            await updateCostSettings(patch);
            Toast.push(successMessage, 'success');
            await loadState(true);
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : '设置保存失败', 'error');
        }
        finally {
            setSavingSettings(false);
        }
    }, [loadState]);
    /** 切换布尔设置（开发者模式 / 峰谷调度 / 模型路由）。 */
    const handleToggle = useCallback((key, value) => {
        const patch = key === 'devMode'
            ? { devMode: value }
            : key === 'peakScheduling'
                ? { peakScheduling: value }
                : { modelRouting: value };
        void applySettings(patch, '设置已更新');
    }, [applySettings]);
    /** 保存月度预算。 */
    const handleSaveBudget = useCallback(() => {
        const value = Number(budgetInput);
        if (!Number.isFinite(value) || value < 0) {
            Toast.push('请输入有效的月度预算金额（元，非负数）', 'warning');
            return;
        }
        void applySettings({ monthlyBudgetCny: value }, '月度预算已更新');
    }, [budgetInput, applySettings]);
    /** 保存日预算。 */
    const handleSaveDailyBudget = useCallback(() => {
        const value = Number(dailyBudgetInput);
        if (!Number.isFinite(value) || value < 0) {
            Toast.push('请输入有效的日预算金额（元，非负数）', 'warning');
            return;
        }
        void applySettings({ dailyBudgetCny: value }, '日预算已更新');
    }, [dailyBudgetInput, applySettings]);
    /** 手动触发官方定价页刷新（DeepSeek + 全部国产厂商）。 */
    const handleRefreshPricing = useCallback(async () => {
        setRefreshingPricing(true);
        try {
            const view = await refreshCostPricing();
            Toast.push(view.source === 'live'
                ? '官方定价页已刷新，价格为最新实时数据'
                : '官方定价页抓取失败，当前沿用内置/上次有效价格', view.source === 'live' ? 'success' : 'warning');
            await loadState(true);
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : '定价刷新失败', 'error');
        }
        finally {
            setRefreshingPricing(false);
        }
    }, [loadState]);
    /** 保存 API Key（服务端加密落盘，响应不回传明文）。 */
    const handleSaveApiKey = useCallback(async () => {
        const value = apiKey.trim();
        if (!value) {
            Toast.push('请输入 API Key', 'warning');
            return;
        }
        setSavingKey(true);
        try {
            await saveCostApiKey(value);
            Toast.push('API Key 已加密保存', 'success');
            setApiKey('');
            await loadState(true);
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : 'API Key 保存失败', 'error');
        }
        finally {
            setSavingKey(false);
        }
    }, [apiKey, loadState]);
    /** 删除已保存的 API Key。 */
    const handleDeleteApiKey = useCallback(async () => {
        setDeletingKey(true);
        try {
            await removeCostApiKey();
            Toast.push('API Key 已删除', 'success');
            await loadState(true);
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : 'API Key 删除失败', 'error');
        }
        finally {
            setDeletingKey(false);
        }
    }, [loadState]);
    /** 用当前 Key 发起最小测试调用。 */
    const handleTestCall = useCallback(async () => {
        setTesting(true);
        try {
            const result = await testCostCall();
            Toast.push(`连接成功：${result.model}（延迟 ${result.latencyMs}ms）`, 'success');
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : '测试调用失败', 'error');
        }
        finally {
            setTesting(false);
        }
    }, []);
    // ---------------------------------------------------------------------
    // 派生展示数据
    // ---------------------------------------------------------------------
    const budget = costState?.budget;
    const ratio = budget && budget.monthlyCny > 0 ? budget.spentCny / budget.monthlyCny : 0;
    const dailyRatio = budget && budget.dailyCny > 0 ? budget.dailySpentCny / budget.dailyCny : 0;
    /** 进度条样式档位：80% 黄、100% 红。 */
    const barClassOf = (r) => r >= 1 ? styles.progressDanger : r >= 0.8 ? styles.progressWarning : styles.progressNormal;
    const pricing = costState?.pricing;
    const pricingSourceText = pricing === undefined
        ? ''
        : pricing.source === 'live'
            ? '官方定价页实时抓取'
            : '内置快照';
    const pricingFetchedText = pricing?.fetchedAt !== undefined ? new Date(pricing.fetchedAt).toLocaleString('zh-CN') : '';
    const peakWindowsText = pricing?.scheduled !== undefined && pricing.scheduled !== null
        ? (pricing.scheduled.peakWindows ?? [[9, 12], [14, 18]])
            .map(([start, end]) => `${start}:00-${end}:00`)
            .join('、')
        : '';
    const days = report?.days ?? [];
    const maxTokens = Math.max(1, ...days.map((d) => d.promptTokens + d.completionTokens));
    const maxCost = Math.max(0.0001, ...days.map((d) => d.costCny));
    const summaryCards = report
        ? [
            { label: '调用数', value: `${report.total.calls}` },
            {
                label: 'Token 总量',
                value: (report.total.promptTokens + report.total.completionTokens).toLocaleString('zh-CN'),
            },
            { label: '费用（元）', value: formatCny(report.total.costCny) },
            { label: '节省金额（元）', value: formatCny(report.total.savedCny) },
            { label: '延迟执行数', value: `${report.total.deferredCalls}` },
        ]
        : [];
    const devMode = costState?.devMode ?? false;
    return (_jsxs("div", { className: styles.view, children: [_jsxs("header", { className: styles.header, children: [_jsx("h2", { className: styles.title, children: "API \u6210\u672C\u62A5\u8868" }), _jsxs("div", { className: styles.rangeToggle, children: [_jsx(Button, { size: "sm", variant: rangeDays === 7 ? 'primary' : 'ghost', onClick: () => setRangeDays(7), children: "\u8FD1 7 \u5929" }), _jsx(Button, { size: "sm", variant: rangeDays === 28 ? 'primary' : 'ghost', onClick: () => setRangeDays(28), children: "\u8FD1 28 \u5929" })] })] }), costState && stateError ? _jsx("div", { className: styles.error, children: stateError }) : null, reportLoading && !report ? _jsx(Spinner, { label: "\u52A0\u8F7D\u62A5\u8868\u2026" }) : null, reportError ? _jsx("div", { className: styles.error, children: reportError }) : null, report ? (_jsx("div", { className: styles.cards, children: summaryCards.map((card) => (_jsxs("div", { className: styles.card, children: [_jsx("span", { className: styles.cardValue, children: card.value }), _jsx("span", { className: styles.cardLabel, children: card.label })] }, card.label))) })) : null, budget ? (_jsxs("div", { className: styles.section, children: [_jsxs("h3", { className: styles.sectionTitle, children: ["\u9884\u7B97\u63A7\u5236", budget.paused ? _jsx(Pill, { className: styles.pausedBadge, children: "\u5DF2\u6682\u505C\u8C03\u7528" }) : null] }), _jsxs("div", { className: styles.budgetRow, children: [_jsx("div", { className: styles.progressTrack, children: _jsx("div", { className: `${styles.progressFill} ${barClassOf(dailyRatio)}`, style: { width: `${Math.min(100, Math.max(0, dailyRatio * 100))}%` } }) }), _jsxs("span", { className: styles.budgetText, children: ["\u4ECA\u65E5\u5DF2\u7528 ", formatCny(budget.dailySpentCny), " / \u65E5\u9884\u7B97 ", formatCny(budget.dailyCny), budget.dailyCny > 0 ? `（${Math.round(dailyRatio * 1000) / 10}%）` : '（未设置）'] })] }), _jsxs("div", { className: styles.budgetEdit, children: [_jsx(Input, { className: styles.budgetInput, type: "number", value: dailyBudgetInput, onChange: (event) => setDailyBudgetInput(event.target.value), onKeyDown: (event) => {
                                    if (event.key === 'Enter' && !savingSettings && dailyBudgetInput.length > 0) {
                                        handleSaveDailyBudget();
                                    }
                                }, placeholder: `当前日预算 ${budget.dailyCny} 元（0=不限），输入新日预算…` }), _jsx(Button, { variant: "secondary", size: "sm", onClick: handleSaveDailyBudget, disabled: savingSettings || dailyBudgetInput.length === 0, children: savingSettings ? _jsx(Spinner, { label: "\u4FDD\u5B58\u4E2D\u2026" }) : '保存日预算' })] }), _jsxs("div", { className: styles.budgetRow, children: [_jsx("div", { className: styles.progressTrack, children: _jsx("div", { className: `${styles.progressFill} ${barClassOf(ratio)}`, style: { width: `${Math.min(100, Math.max(0, ratio * 100))}%` } }) }), _jsxs("span", { className: styles.budgetText, children: ["\u672C\u6708\u5DF2\u7528 ", formatCny(budget.spentCny), " / \u6708\u9884\u7B97 ", formatCny(budget.monthlyCny), budget.monthlyCny > 0 ? `（${Math.round(ratio * 1000) / 10}%）` : '（未设置）'] })] }), _jsxs("div", { className: styles.budgetEdit, children: [_jsx(Input, { className: styles.budgetInput, type: "number", value: budgetInput, onChange: (event) => setBudgetInput(event.target.value), onKeyDown: (event) => {
                                    // Enter 快捷提交：与“保存预算”按钮等价
                                    if (event.key === 'Enter' && !savingSettings && budgetInput.length > 0) {
                                        handleSaveBudget();
                                    }
                                }, placeholder: `当前月预算 ${budget.monthlyCny} 元（0=不限），输入新月预算…` }), _jsx(Button, { variant: "secondary", size: "sm", onClick: handleSaveBudget, disabled: savingSettings || budgetInput.length === 0, children: savingSettings ? _jsx(Spinner, { label: "\u4FDD\u5B58\u4E2D\u2026" }) : '保存月预算' })] })] })) : null, pricing ? (_jsxs("div", { className: styles.section, children: [_jsx("h3", { className: styles.sectionTitle, children: "\u52A8\u6001\u8BA1\u4EF7" }), _jsxs("div", { className: styles.statusRow, children: ["\u5B9A\u4EF7\u6765\u6E90\uFF1A", pricing.source === 'live' ? (_jsx(Pill, { className: styles.okBadge, children: "\u5B98\u65B9\u5B9E\u65F6" })) : (_jsx(Pill, { className: styles.warnBadge, children: "\u5185\u7F6E\u5FEB\u7167" })), pricingFetchedText ? _jsxs("span", { className: styles.hint, children: ["\u6293\u53D6\u4E8E ", pricingFetchedText] }) : null] }), pricing.scheduled !== null ? (_jsxs("div", { className: styles.hint, children: ["\u5CF0\u8C37\u5206\u65F6\u5B9A\u4EF7\u81EA ", pricing.scheduled.effective, " \u751F\u6548", peakWindowsText ? `（北京时间高峰 ${peakWindowsText} 按高峰价计费）` : ''] })) : null, _jsx("div", { className: styles.hint, children: "\u6BCF\u5C0F\u65F6\u81EA\u52A8\u6293\u53D6 DeepSeek \u4E0E\u56FD\u4EA7\u5382\u5546\u5B98\u65B9\u5B9A\u4EF7\u9875\uFF0C\u65B0\u6A21\u578B\u4E0E\u8C03\u4EF7\u81EA\u52A8\u5BFC\u5165\uFF1B\u7F13\u5B58\u547D\u4E2D\u6309\u6298\u6263\u4EF7\u8BA1\u8D39\u3002" }), _jsx("div", { className: styles.budgetEdit, children: _jsx(Button, { variant: "secondary", size: "sm", onClick: () => void handleRefreshPricing(), disabled: refreshingPricing, children: refreshingPricing ? _jsx(Spinner, { label: "\u5237\u65B0\u4E2D\u2026" }) : '立即刷新官方定价' }) })] })) : null, report ? (_jsxs("div", { className: styles.section, children: [_jsx("h3", { className: styles.sectionTitle, children: "\u6BCF\u65E5 Token / \u8D39\u7528" }), _jsxs("div", { className: styles.chartLegend, children: [_jsxs("span", { children: [_jsx("i", { className: `${styles.legendDot} ${styles.legendTokens}` }), "Token"] }), _jsxs("span", { children: [_jsx("i", { className: `${styles.legendDot} ${styles.legendCost}` }), "\u8D39\u7528\uFF08\u5143\uFF09"] })] }), days.length === 0 ? (_jsx("div", { className: styles.empty, children: "\u8BE5\u65F6\u95F4\u8303\u56F4\u5185\u6682\u65E0\u7528\u91CF\u8BB0\u5F55" })) : (_jsx("div", { className: styles.chart, children: days.map((day) => {
                            const tokens = day.promptTokens + day.completionTokens;
                            const tokenPct = Math.round((tokens / maxTokens) * 100);
                            const costPct = Math.round((day.costCny / maxCost) * 100);
                            return (_jsxs("div", { className: styles.chartDay, title: `${day.day}：Token ${tokens.toLocaleString('zh-CN')} / 费用 ${formatCny(day.costCny)} / 调用 ${day.calls} 次`, children: [_jsxs("div", { className: styles.chartBars, children: [_jsx("div", { className: styles.barTokens, style: { height: `${tokenPct}%` } }), _jsx("div", { className: styles.barCost, style: { height: `${costPct}%` } })] }), _jsx("span", { className: styles.chartLabel, children: day.day.slice(5) })] }, day.day));
                        }) }))] })) : null, _jsxs("div", { className: styles.section, children: [_jsx("h3", { className: styles.sectionTitle, children: "\u6210\u672C\u4F18\u5316\u8BBE\u7F6E" }), costState ? (_jsxs("div", { className: styles.settings, children: [_jsx(Checkbox, { checked: costState.devMode, disabled: savingSettings, onChange: (checked) => handleToggle('devMode', checked), label: "\u5F00\u53D1\u8005\u6A21\u5F0F\uFF08\u603B\u5F00\u5173\uFF1AAPI Key \u7BA1\u7406\u4E0E\u8C03\u5EA6\u8BBE\u7F6E\uFF09" }), !devMode ? (_jsx("div", { className: styles.hint, children: "\u5F00\u53D1\u8005\u6A21\u5F0F\u5DF2\u5173\u95ED\uFF1AAPI Key \u7BA1\u7406\u4E0E\u8C03\u5EA6\u8BBE\u7F6E\u4E0D\u53EF\u7528\u3002" })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles.subSection, children: [_jsx("div", { className: styles.subTitle, children: "API Key \u7BA1\u7406" }), _jsxs("div", { className: styles.statusRow, children: ["\u72B6\u6001\uFF1A", costState.apiKeyConfigured ? (_jsx(Pill, { className: styles.okBadge, children: "\u5DF2\u914D\u7F6E" })) : (_jsx(Pill, { className: styles.warnBadge, children: "\u672A\u914D\u7F6E" }))] }), _jsxs("div", { className: styles.apiKeyRow, children: [_jsx(Input, { className: styles.apiKeyInput, type: "password", value: apiKey, onChange: (event) => setApiKey(event.target.value), placeholder: costState.apiKeyConfigured ? '输入新 Key 以覆盖…' : 'sk-…' }), _jsx(Button, { variant: "primary", size: "sm", onClick: () => void handleSaveApiKey(), disabled: savingKey || apiKey.length === 0, children: savingKey ? _jsx(Spinner, { label: "\u4FDD\u5B58\u4E2D\u2026" }) : '保存' }), _jsx(Button, { variant: "danger", size: "sm", onClick: () => void handleDeleteApiKey(), disabled: deletingKey || !costState.apiKeyConfigured, children: deletingKey ? _jsx(Spinner, { label: "\u5220\u9664\u4E2D\u2026" }) : '删除' }), _jsx(Button, { variant: "secondary", size: "sm", onClick: () => void handleTestCall(), disabled: testing || !costState.apiKeyConfigured, children: testing ? _jsx(Spinner, { label: "\u6D4B\u8BD5\u4E2D\u2026" }) : '测试连接' })] }), _jsx("div", { className: styles.hint, children: "Key \u4EC5\u4EE5 AES-256-GCM \u52A0\u5BC6\u4FDD\u5B58\u5728\u672C\u5730\uFF0C\u4E0D\u4F1A\u51FA\u73B0\u5728\u4EFB\u4F55\u54CD\u5E94\u4E0E\u65E5\u5FD7\u4E2D\u3002" })] }), _jsxs("div", { className: styles.subSection, children: [_jsx("div", { className: styles.subTitle, children: "\u8C03\u5EA6\u4E0E\u8DEF\u7531" }), _jsx(Checkbox, { checked: costState.peakScheduling, disabled: savingSettings, onChange: (checked) => handleToggle('peakScheduling', checked), label: "\u5CF0\u8C37\u8C03\u5EA6\uFF08\u9AD8\u5CF0\u65F6\u6BB5\u5EF6\u8FDF\u975E\u7D27\u6025\u8C03\u7528\u81F3\u7A7A\u95F2\u65F6\u6BB5\uFF09" }), _jsx(Checkbox, { checked: costState.modelRouting, disabled: savingSettings, onChange: (checked) => handleToggle('modelRouting', checked), label: "\u6A21\u578B\u8DEF\u7531\uFF08\u6309\u4EFB\u52A1\u590D\u6742\u5EA6\u9009\u62E9\u66F4\u7ECF\u6D4E\u7684\u6A21\u578B\uFF09" })] })] }))] })) : stateError ? (
                    // 初次 /cost/state 失败：显示错误提示 + 重试按钮，而不是永久 Spinner
                    _jsxs("div", { className: styles.error, children: [_jsx("span", { children: stateError }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => void loadState(false), children: "\u91CD\u8BD5" })] })) : (_jsx(Spinner, { label: "\u52A0\u8F7D\u6210\u672C\u72B6\u6001\u2026" }))] })] }));
}
