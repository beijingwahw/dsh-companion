import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 全局对话检索视图页（模块 D 客户端 UI，挂载于 conversation.view）：
 * - 顶部全局搜索框（防抖 300ms）+ 日期范围（两个 type=date 输入）+ 标签筛选（GET /tags 全量标签，Pill 可点击）；
 * - 结果列表展示标题、时间、摘要片段与标签；
 * - 点击结果派发 `companion:open-session` 自定义事件请求主平台跳转（集成缝，见下注）；
 * - “加载更多”通过递增 limit 实现分页。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Pill, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { fetchAllTags, searchSessions } from '../api.js';
import styles from './SearchView.module.css';
/** 每次“加载更多”递增的条数。 */
const PAGE_SIZE = 50;
/** 搜索输入防抖时长（毫秒）。 */
const DEBOUNCE_MS = 300;
/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
/** 全局对话检索视图页。 */
export function SearchView(_props) {
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [allTags, setAllTags] = useState([]);
    const [tagsError, setTagsError] = useState('');
    const [selectedTags, setSelectedTags] = useState(new Set());
    const [hits, setHits] = useState([]);
    const [limit, setLimit] = useState(PAGE_SIZE);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    /** 日期区间本地校验：YYYY-MM-DD 格式可直接按字典序比较，from 晚于 to 时不发请求。 */
    const rangeInvalid = from.length > 0 && to.length > 0 && from > to;
    // 搜索框防抖：停止输入 300ms 后才触发检索
    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [query]);
    // 挂载时拉取全量标签（GET /tags 缺省 sessionId 返回 标签 → 会话列表 映射）
    useEffect(() => {
        let cancelled = false;
        fetchAllTags()
            .then((response) => {
            if (!cancelled)
                setAllTags(Object.keys(response.tags));
        })
            .catch((err) => {
            if (!cancelled)
                setTagsError(err instanceof Error ? err.message : '标签加载失败');
        });
        return () => {
            cancelled = true;
        };
    }, []);
    // 检索条件或 limit 变化时重新请求（selectedTags 每次切换都是新 Set，引用变化即触发）
    useEffect(() => {
        // from 晚于 to：仅本地提示，不发起请求
        if (rangeInvalid) {
            setHits([]);
            setError('起始日期不能晚于结束日期，请调整日期区间');
            setLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError('');
        searchSessions({
            query: debouncedQuery.trim() || undefined,
            from: from || undefined,
            to: to || undefined,
            tags: [...selectedTags],
            limit,
        })
            .then((response) => {
            if (!cancelled)
                setHits(response.hits);
        })
            .catch((err) => {
            if (!cancelled)
                setError(err instanceof Error ? err.message : '检索失败');
        })
            .finally(() => {
            if (!cancelled)
                setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [debouncedQuery, from, to, selectedTags, limit, rangeInvalid]);
    /** 点击结果项：请求主平台跳转到该会话。
     *
     * 集成缝说明：主平台客户端监听 `companion:open-session` 自定义事件完成会话切换；
     * 插件不直接依赖平台内部导航 API，事件即两者之间唯一的导航契约（见 DESIGN.md 第 6 节）。
     */
    const openSession = useCallback((sessionId) => {
        window.dispatchEvent(new CustomEvent('companion:open-session', { detail: { sessionId } }));
        Toast.push('已发送跳转请求', 'info');
    }, []);
    /** 切换标签筛选（点击 Pill）。 */
    const toggleTag = useCallback((tag) => {
        setSelectedTags((prev) => {
            const next = new Set(prev);
            if (next.has(tag))
                next.delete(tag);
            else
                next.add(tag);
            return next;
        });
        setLimit(PAGE_SIZE);
    }, []);
    /** 更新查询词并重置分页。 */
    const handleQueryChange = useCallback((value) => {
        setQuery(value);
        setLimit(PAGE_SIZE);
    }, []);
    /** 更新起始日期并重置分页。 */
    const handleFromChange = useCallback((value) => {
        setFrom(value);
        setLimit(PAGE_SIZE);
    }, []);
    /** 更新结束日期并重置分页。 */
    const handleToChange = useCallback((value) => {
        setTo(value);
        setLimit(PAGE_SIZE);
    }, []);
    return (_jsxs("div", { className: styles.view, children: [_jsxs("header", { className: styles.toolbar, children: [_jsx(Input, { className: styles.searchInput, type: "search", value: query, onChange: (event) => handleQueryChange(event.target.value), placeholder: "\u5168\u5C40\u68C0\u7D22\u5386\u53F2\u5BF9\u8BDD\u2026" }), _jsxs("label", { className: styles.dateField, children: [_jsx("span", { children: "\u4ECE" }), _jsx(Input, { type: "date", value: from, onChange: (event) => handleFromChange(event.target.value) })] }), _jsxs("label", { className: styles.dateField, children: [_jsx("span", { children: "\u81F3" }), _jsx(Input, { type: "date", value: to, onChange: (event) => handleToChange(event.target.value) })] }), rangeInvalid ? _jsx("span", { className: styles.error, children: "\u8D77\u59CB\u65E5\u671F\u4E0D\u80FD\u665A\u4E8E\u7ED3\u675F\u65E5\u671F" }) : null] }), _jsxs("div", { className: styles.tagRow, children: [tagsError ? _jsx("span", { className: styles.error, children: tagsError }) : null, !tagsError && allTags.length === 0 ? _jsx("span", { className: styles.muted, children: "\u6682\u65E0\u6807\u7B7E" }) : null, allTags.map((tag) => (
                    // Pill 原语不支持键盘交互属性（PillProps 未开放 role/tabIndex/onKeyDown），
                    // 故以外层 span 补齐 role="button"、tabIndex 与 Enter/Space 键激活。
                    _jsx("span", { role: "button", tabIndex: 0, "aria-pressed": selectedTags.has(tag), onClick: () => toggleTag(tag), onKeyDown: (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                toggleTag(tag);
                            }
                        }, children: _jsx(Pill, { className: selectedTags.has(tag) ? styles.tagActive : styles.tag, children: tag }) }, tag)))] }), _jsxs("div", { className: styles.results, children: [loading && hits.length === 0 ? _jsx(Spinner, { label: "\u68C0\u7D22\u4E2D\u2026" }) : null, error ? _jsx("div", { className: styles.error, children: error }) : null, !loading && !error && hits.length === 0 ? (_jsx("div", { className: styles.empty, children: "\u6CA1\u6709\u5339\u914D\u7684\u5BF9\u8BDD\uFF0C\u8BD5\u8BD5\u8C03\u6574\u5173\u952E\u8BCD\u3001\u65E5\u671F\u6216\u6807\u7B7E" })) : null, hits.map((hit) => (_jsxs(Button, { variant: "ghost", className: styles.resultItem, onClick: () => openSession(hit.session.id), children: [_jsxs("span", { className: styles.resultHead, children: [_jsx("span", { className: styles.resultTitle, children: hit.session.title ?? `会话 ${hit.session.id}` }), _jsx("span", { className: styles.resultTime, children: formatTime(hit.session.updatedAt ?? hit.session.createdAt) })] }), hit.snippet ? _jsx("span", { className: styles.resultSnippet, children: hit.snippet }) : null, hit.tags.length > 0 ? (_jsx("span", { className: styles.resultTags, children: hit.tags.map((tag) => (_jsx(Pill, { className: styles.resultTag, children: tag }, tag))) })) : null] }, hit.session.id))), loading && hits.length > 0 ? _jsx(Spinner, { label: "\u52A0\u8F7D\u66F4\u591A\u2026" }) : null, !loading && !error && hits.length >= limit ? (_jsx("div", { className: styles.more, children: _jsx(Button, { variant: "secondary", onClick: () => setLimit((prev) => prev + PAGE_SIZE), children: "\u52A0\u8F7D\u66F4\u591A" }) })) : null] })] }));
}
