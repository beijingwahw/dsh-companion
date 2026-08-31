import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 全局对话检索视图页（模块 D + E + G 客户端 UI，挂载于 conversation.view）：
 * - 检索模式开关：语义检索（模块 E，混合排序）/ 关键词检索（模块 D，FTS）；
 * - 顶部全局搜索框（防抖 300ms）+ 日期范围（两个 type=date 输入）+ 标签筛选（GET /tags 全量标签，Pill 可点击）；
 * - 语义模式不支持服务端标签过滤：基于全量标签映射在客户端反查过滤（会话 → 标签）；
 * - **检索智能提示栏**（轴线 8/10）：展示查询扩展溯源（拼写纠错/共现扩展）
 *   与质量判定（相关度强度 + 通道覆盖 + 首条可执行建议），把黑盒分数
 *   翻译成人话；
 * - 结果列表展示标题、时间、摘要片段、标签与语义排名徽章（词法/语义名次）；
 * - **深度研究**（模块 G，轴线 5）：以当前查询词为研究问题，跨全部历史
 *   对话检索证据并合成带 [编号] 引用的回答，来源可点击直达原会话；
 * - 点击结果派发 `companion:open-session` 自定义事件请求主平台跳转（集成缝，见下注）；
 * - “加载更多”通过递增 limit 实现分页。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Pill, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { askSynthesis, fetchAllTags, fetchKnowledgePulse, fetchRetrievalClusters, fetchRetrievalInsights, fetchRetrievalSuggestions, recordRetrievalFeedback, searchRetrieval, searchSessions, } from '../api.js';
import { KnowledgePanel } from './KnowledgePanel.js';
import { CognitionPanel } from './CognitionPanel.js';
import styles from './SearchView.module.css';
/** 每次“加载更多”递增的条数。 */
const PAGE_SIZE = 50;
/** 搜索输入防抖时长（毫秒）。 */
const DEBOUNCE_MS = 300;
/** 深度研究请求超时（毫秒）：含多会话读取 + LLM 合成，放宽于常规请求。 */
const RESEARCH_TIMEOUT_MS = 180_000;
/** 质量判定人话标签（轴线 10，与服务端 VERDICT_LABELS 对应）。 */
const VERDICT_LABELS = {
    strong: '强',
    fair: '中',
    weak: '弱',
    empty: '空',
};
/** 洞察卡片严重度排序权重（critical > watch > info；合并多脉搏源后重排用）。 */
const SEVERITY_RANK = {
    critical: 0,
    watch: 1,
    info: 2,
};
/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
/** 全局对话检索视图页。 */
export function SearchView(_props) {
    /** 检索模式：true = 语义检索（模块 E 混合排序）；false = 关键词检索（模块 D）。 */
    const [semantic, setSemantic] = useState(true);
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
    /** 知识面板的洞察目标会话（点击结果行“知识”按钮设置）。 */
    const [insight, setInsight] = useState(null);
    /** 检索智能（轴线 8）：本次语义检索的查询扩展溯源（无扩展为 null）。 */
    const [expansion, setExpansion] = useState(null);
    /** 检索智能（轴线 10）：本次语义检索的质量诊断。 */
    const [diagnostics, setDiagnostics] = useState(null);
    /** 反馈学习（轴线 11）：本次检索因历史点击获得加成的会话（无加成为 null）。 */
    const [feedback, setFeedback] = useState(null);
    /** 多样性重排（轴线 12）：本次检索的 MMR 元信息。 */
    const [diversity, setDiversity] = useState(null);
    /** 零命中救援（轴线 16）：本次检索的查询放宽溯源（未触发为 null）。 */
    const [rescue, setRescue] = useState(null);
    /** 查询建议（轴线 14）：输入框自动补全候选（空为无建议）。 */
    const [suggestions, setSuggestions] = useState([]);
    /** 建议下拉开合（聚焦/有候选时展开；选中或失焦收起）。 */
    const [suggestOpen, setSuggestOpen] = useState(false);
    /** 知识地图（轴线 13）：面板开合与聚类结果。 */
    const [mapOpen, setMapOpen] = useState(false);
    const [mapClusters, setMapClusters] = useState(null);
    const [mapSessions, setMapSessions] = useState(0);
    const [mapLoading, setMapLoading] = useState(false);
    const [mapError, setMapError] = useState('');
    /** 主动脉搏（轴线 18）：面板开合与洞察卡片。 */
    const [pulseOpen, setPulseOpen] = useState(false);
    const [pulseCards, setPulseCards] = useState(null);
    const [pulseSummary, setPulseSummary] = useState('');
    const [pulseLoading, setPulseLoading] = useState(false);
    const [pulseError, setPulseError] = useState('');
    /** 认知面板（轴线 20/21/22）：前瞻记忆 + 间隔重复 + 类比检索。 */
    const [cognitionOpen, setCognitionOpen] = useState(false);
    /** 深度研究（模块 G）：合成结果与状态。 */
    const [research, setResearch] = useState(null);
    const [researchQuestion, setResearchQuestion] = useState('');
    const [researchLoading, setResearchLoading] = useState(false);
    const [researchError, setResearchError] = useState('');
    /**
     * 会话 → 标签 反查表（由全量标签映射 `标签 → 会话列表` 反转而来）：
     * 语义端点不支持服务端标签过滤，语义模式下用它做客户端过滤。
     */
    const sessionTagsRef = useRef(new Map());
    /** 日期区间本地校验：YYYY-MM-DD 格式可直接按字典序比较，from 晚于 to 时不发请求。 */
    const rangeInvalid = from.length > 0 && to.length > 0 && from > to;
    /** 语义模式下标签筛选是否生效（选中了任意标签即生效）。 */
    const tagFilterActive = selectedTags.size > 0;
    // 搜索框防抖：停止输入 300ms 后才触发检索
    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [query]);
    // 查询建议（轴线 14）：语义模式下随输入防抖拉取自动补全候选。
    // 建议请求独立于检索请求（输入中即出建议，不等检索完成）；失败静默
    // （建议是增强体验，不打扰主流程）。
    useEffect(() => {
        const input = query.trim();
        if (!semantic || input.length === 0) {
            setSuggestions([]);
            setSuggestOpen(false);
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            fetchRetrievalSuggestions({ q: query })
                .then((response) => {
                if (cancelled)
                    return;
                setSuggestions(response.suggestions);
            })
                .catch(() => {
                if (!cancelled)
                    setSuggestions([]);
            });
        }, DEBOUNCE_MS);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [query, semantic]);
    // 挂载时拉取全量标签（GET /tags 缺省 sessionId 返回 标签 → 会话列表 映射），
    // 同时反转出 会话 → 标签 表供语义模式的客户端标签过滤。
    useEffect(() => {
        let cancelled = false;
        fetchAllTags()
            .then((response) => {
            if (cancelled)
                return;
            setAllTags(Object.keys(response.tags));
            const inverted = new Map();
            for (const [tag, sessionIds] of Object.entries(response.tags)) {
                for (const sessionId of sessionIds) {
                    let bucket = inverted.get(sessionId);
                    if (bucket === undefined) {
                        bucket = new Set();
                        inverted.set(sessionId, bucket);
                    }
                    bucket.add(tag);
                }
            }
            sessionTagsRef.current = inverted;
        })
            .catch((err) => {
            if (!cancelled)
                setTagsError(err instanceof Error ? err.message : '标签加载失败');
        });
        return () => {
            cancelled = true;
        };
    }, []);
    /** 语义模式下的客户端标签过滤：命中会话需带全部选中标签。 */
    const passTagFilter = useCallback((sessionId) => {
        if (selectedTags.size === 0)
            return true;
        const tags = sessionTagsRef.current.get(sessionId);
        if (tags === undefined)
            return false;
        for (const tag of selectedTags) {
            if (!tags.has(tag))
                return false;
        }
        return true;
    }, [selectedTags]);
    // 检索条件、模式或 limit 变化时重新请求（selectedTags 每次切换都是新 Set，引用变化即触发）
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
        /** 语义模式：混合排序端点（标签在客户端过滤）；关键词模式：FTS 端点。 */
        const request = semantic
            ? searchRetrieval({
                query: debouncedQuery.trim(),
                from: from || undefined,
                to: to || undefined,
                limit: tagFilterActive ? limit * 4 : limit,
            }).then((response) => {
                // 轴线 8/10/11/12/16：捕获扩展溯源、质量诊断、反馈学习、
                // 多样性元信息与零命中救援溯源。
                if (!cancelled) {
                    setExpansion(response.expansion ?? null);
                    setDiagnostics(response.diagnostics ?? null);
                    setFeedback(response.feedback ?? null);
                    setDiversity(response.diversity ?? null);
                    setRescue(response.rescue ?? null);
                }
                return response.hits
                    .filter((hit) => passTagFilter(hit.session.id))
                    .map((hit) => ({
                    session: hit.session,
                    snippet: hit.snippet,
                    tags: [...(sessionTagsRef.current.get(hit.session.id) ?? [])],
                    lexicalRank: hit.lexicalRank,
                    semanticRank: hit.semanticRank,
                    explanationSummary: hit.explanation?.summary,
                }));
            })
            : searchSessions({
                query: debouncedQuery.trim() || undefined,
                from: from || undefined,
                to: to || undefined,
                tags: [...selectedTags],
                limit,
            }).then((response) => {
                // 关键词模式不带智能诊断：清空提示栏状态。
                if (!cancelled) {
                    setExpansion(null);
                    setDiagnostics(null);
                    setFeedback(null);
                    setDiversity(null);
                    setRescue(null);
                }
                return response.hits.map((hit) => ({
                    session: hit.session,
                    snippet: hit.snippet,
                    tags: hit.tags,
                }));
            });
        request
            .then((mapped) => {
            if (!cancelled)
                setHits(mapped);
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
    }, [semantic, debouncedQuery, from, to, selectedTags, limit, rangeInvalid, tagFilterActive, passTagFilter]);
    /** 点击结果项：请求主平台跳转到该会话。
     *
     * 集成缝说明：主平台客户端监听 `companion:open-session` 自定义事件完成会话切换；
     * 插件不直接依赖平台内部导航 API，事件即两者之间唯一的导航契约（见 DESIGN.md 第 6 节）。
     *
     * 轴线 11（反馈学习）：语义模式下点击即反馈——当前查询词并入该会话的
     * 点击画像，后续相似检索会温和上浮该会话。异步发射、失败静默（反馈
     * 是增强信号，不阻塞跳转，也不打扰用户）。
     */
    const openSession = useCallback((sessionId) => {
        window.dispatchEvent(new CustomEvent('companion:open-session', { detail: { sessionId } }));
        Toast.push('已发送跳转请求', 'info');
        const queryText = debouncedQuery.trim();
        if (semantic && queryText.length > 0) {
            recordRetrievalFeedback({ query: queryText, sessionId }).catch(() => undefined);
        }
    }, [semantic, debouncedQuery]);
    /**
     * 知识地图（轴线 13）：打开面板并按需拉取主题聚类（minSize=2 只看
     * 重复主题簇——「我重复解决过哪些问题」）；再次点击收起。
     */
    const toggleMap = useCallback(() => {
        setMapOpen((prev) => {
            const next = !prev;
            if (next && mapClusters === null && !mapLoading) {
                setMapLoading(true);
                setMapError('');
                fetchRetrievalClusters({ minSize: 2 })
                    .then((response) => {
                    setMapClusters(response.clusters);
                    setMapSessions(response.sessions);
                })
                    .catch((err) => {
                    setMapError(err instanceof Error ? err.message : '知识地图加载失败');
                })
                    .finally(() => {
                    setMapLoading(false);
                });
            }
            return next;
        });
    }, [mapClusters, mapLoading]);
    /** 点击主题簇：以簇标签为检索词发起语义检索（知识地图 → 深入某主题）。 */
    const searchCluster = useCallback((cluster) => {
        if (cluster.label.length === 0)
            return;
        setQuery(cluster.label);
        setLimit(PAGE_SIZE);
    }, []);
    /**
     * 主动脉搏（轴线 18 + 认知三轴扩展）：打开面板并并行拉取两个脉搏源——
     * 检索侧（盲区/学习/索引）与认知侧（到期意图/复习/片段资产），卡片
     * 按严重度重排合并；认知源失败静默降级（认知是增强信号，不阻塞检索侧）。
     * 每次打开都重新拉取（洞察随状态变化）。
     */
    const togglePulse = useCallback(() => {
        setPulseOpen((prev) => {
            const next = !prev;
            if (next) {
                // 主动洞察的价值在于「此刻」：每次打开重新合成。
                setPulseLoading(true);
                setPulseError('');
                Promise.all([
                    fetchRetrievalInsights(),
                    fetchKnowledgePulse().catch(() => null),
                ])
                    .then(([retrieval, cognition]) => {
                    const cards = [...retrieval.cards, ...(cognition?.cards ?? [])].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
                    setPulseCards(cards);
                    const summaries = [retrieval.summary, cognition?.summary].filter((text) => typeof text === 'string' && text.length > 0);
                    setPulseSummary(summaries.join('；'));
                })
                    .catch((err) => {
                    setPulseError(err instanceof Error ? err.message : '主动脉搏加载失败');
                })
                    .finally(() => {
                    setPulseLoading(false);
                });
            }
            return next;
        });
    }, []);
    /** 切换检索模式（语义 ↔ 关键词）并重置分页。 */
    const toggleMode = useCallback(() => {
        setSemantic((prev) => !prev);
        setLimit(PAGE_SIZE);
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
    /** 语义模式说明文案（标签过滤在客户端完成）。 */
    const modeHint = useMemo(() => semantic
        ? tagFilterActive
            ? '语义检索 · 标签为本地过滤'
            : '语义检索 · 混合排序（BM25 + 向量）'
        : '关键词检索', [semantic, tagFilterActive]);
    /**
     * 深度研究（模块 G，轴线 5）：以当前查询词为研究问题，跨全部历史
     * 对话检索证据并合成带引用的回答。请求含多会话读取与 LLM 合成，
     * 超时放宽至 180 秒；发起时即时收起旧结果。
     */
    const runResearch = useCallback(() => {
        const question = query.trim();
        if (!question) {
            Toast.push('请先输入研究问题，再点击深度研究', 'warning');
            return;
        }
        setResearchLoading(true);
        setResearchError('');
        setResearch(null);
        setResearchQuestion(question);
        askSynthesis(question, { timeoutMs: RESEARCH_TIMEOUT_MS })
            .then((response) => {
            setResearch(response);
        })
            .catch((err) => {
            setResearchError(err instanceof Error ? err.message : '深度研究失败');
        })
            .finally(() => {
            setResearchLoading(false);
        });
    }, [query]);
    /** 应用一条查询建议（轴线 14）：整体替换查询词并收起下拉。 */
    const applySuggestion = useCallback((suggestion) => {
        setQuery(suggestion.text);
        setLimit(PAGE_SIZE);
        setSuggestOpen(false);
    }, []);
    return (_jsxs("div", { className: styles.view, children: [_jsxs("header", { className: styles.toolbar, children: [_jsxs("div", { className: styles.searchWrap, 
                        // Input 原语未开放 onFocus/onBlur，改挂包裹层（React 焦点事件冒泡到父级）。
                        onFocus: () => setSuggestOpen(true), onBlur: () => {
                            // 延迟收起：给点击建议项留出事件派发窗口。
                            window.setTimeout(() => setSuggestOpen(false), 150);
                        }, children: [_jsx(Input, { className: styles.searchInput, type: "search", value: query, onChange: (event) => handleQueryChange(event.target.value), placeholder: semantic ? '语义检索历史对话…' : '关键词检索历史对话…' }), semantic && suggestOpen && suggestions.length > 0 ? (_jsx("div", { className: styles.suggestList, role: "listbox", "aria-label": "\u67E5\u8BE2\u5EFA\u8BAE", children: suggestions.map((suggestion) => (_jsxs("button", { type: "button", role: "option", "aria-selected": false, className: styles.suggestItem, 
                                    // onMouseDown 先于输入框 onBlur 触发，点击建议不会先丢焦点。
                                    onMouseDown: (event) => {
                                        event.preventDefault();
                                        applySuggestion(suggestion);
                                    }, title: `来自你的语料（${suggestion.source === 'profile'
                                        ? '你点过'
                                        : suggestion.source === 'prefix'
                                            ? '前缀补全'
                                            : '共现续写'}）`, children: [_jsx("span", { className: styles.suggestText, children: suggestion.text }), _jsx("span", { className: styles.suggestSource, children: suggestion.source === 'profile'
                                                ? '点过'
                                                : suggestion.source === 'prefix'
                                                    ? '前缀'
                                                    : '共现' })] }, `${suggestion.source}:${suggestion.term}`))) })) : null] }), _jsx("span", { role: "button", tabIndex: 0, "aria-pressed": semantic, title: "\u5207\u6362\u68C0\u7D22\u6A21\u5F0F\uFF1A\u8BED\u4E49\uFF08\u6DF7\u5408\u6392\u5E8F\uFF09\u2194 \u5173\u952E\u8BCD", onClick: toggleMode, onKeyDown: (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                toggleMode();
                            }
                        }, children: _jsx(Pill, { className: semantic ? styles.tagActive : styles.tag, children: modeHint }) }), _jsxs("label", { className: styles.dateField, children: [_jsx("span", { children: "\u4ECE" }), _jsx(Input, { type: "date", value: from, onChange: (event) => handleFromChange(event.target.value) })] }), _jsxs("label", { className: styles.dateField, children: [_jsx("span", { children: "\u81F3" }), _jsx(Input, { type: "date", value: to, onChange: (event) => handleToChange(event.target.value) })] }), rangeInvalid ? _jsx("span", { className: styles.error, children: "\u8D77\u59CB\u65E5\u671F\u4E0D\u80FD\u665A\u4E8E\u7ED3\u675F\u65E5\u671F" }) : null, _jsx(Button, { variant: "secondary", title: "\u5168\u90E8\u4F1A\u8BDD\u81EA\u52A8\u805A\u7C7B\u4E3A\u4E3B\u9898\u7C07\uFF1A\u53D1\u73B0\u91CD\u590D\u89E3\u51B3\u7684\u95EE\u9898\uFF0C\u70B9\u51FB\u7C07\u6DF1\u5165\u68C0\u7D22", onClick: toggleMap, children: mapLoading ? '聚类中…' : '知识地图' }), _jsx(Button, { variant: "secondary", title: "\u8BA4\u77E5\u9762\u677F\uFF1A\u5230\u671F\u7684\u524D\u77BB\u610F\u56FE\uFF08\u8BF4\u8FC7\u8981\u505A\u7684\u4E8B\uFF09\u3001\u95F4\u9694\u91CD\u590D\u590D\u4E60\uFF08\u95EE\u9898\u2192\u89E3\u6CD5\uFF09\u3001\u8DE8\u57DF\u7C7B\u6BD4\u68C0\u7D22", onClick: () => setCognitionOpen((prev) => !prev), children: "\u8BA4\u77E5\u9762\u677F" }), _jsx(Button, { variant: "secondary", disabled: pulseLoading, title: "\u4E3B\u52A8\u6D1E\u5BDF\uFF1A\u68C0\u7D22\u76F2\u533A + \u53CD\u9988\u5B66\u4E60 + \u7D22\u5F15\u5065\u5EB7 + \u8BA4\u77E5\u4FE1\u53F7\uFF08\u5230\u671F\u610F\u56FE/\u590D\u4E60/\u7247\u6BB5\uFF09\u7684\u5373\u65F6\u805A\u5408", onClick: togglePulse, children: pulseLoading ? '合成中…' : '主动脉搏' }), _jsx(Button, { variant: "secondary", disabled: researchLoading, title: "\u8DE8\u5168\u90E8\u5386\u53F2\u5BF9\u8BDD\u68C0\u7D22\u8BC1\u636E\u5E76\u5408\u6210\u5E26\u5F15\u7528\u6765\u6E90\u7684\u56DE\u7B54", onClick: runResearch, children: researchLoading ? '研究中…' : '深度研究' })] }), semantic && !loading && (expansion !== null || diagnostics !== null || rescue !== null) ? (_jsxs("div", { className: styles.intelBar, "aria-live": "polite", children: [rescue !== null ? (_jsx("span", { className: styles.intelSegment, children: `零命中救援：原查询无结果，已自动放宽为「${rescue.queryText}」（${rescue.actions
                            .map((action) => action.kind === 'correction'
                            ? `${action.from}→${action.to}`
                            : `剔除“${action.from}”`)
                            .join('、')}）` })) : null, expansion !== null ? (_jsxs("span", { className: styles.intelSegment, children: ["\u5DF2\u6269\u5C55\uFF1A", expansion.notes.map((note) => (_jsxs(Pill, { className: styles.tag, children: [note.to, "\u2190", note.from, "\uFF08", note.kind === 'correction' ? '纠错' : '共现', "\uFF09"] }, `${note.kind}:${note.from}:${note.to}`)))] })) : null, feedback !== null && feedback.boosted.length > 0 ? (_jsx("span", { className: styles.intelSegment, children: `反馈学习：${feedback.boosted.length} 个会话因历史点击上浮（最高 +${Math.round(Math.max(...feedback.boosted.map((entry) => entry.boost)) * 100)}%）` })) : null, diversity !== null && diversity.applied ? (_jsx("span", { className: styles.intelSegment, children: `多样性重排已启用（λ=${diversity.lambda}，候选 ${diversity.pool}）` })) : null, diagnostics !== null && diagnostics.verdict !== 'empty' ? (_jsx("span", { className: styles.intelSegment, children: `相关度 ${Math.round((diagnostics.topScore / diagnostics.maxScore) * 100)}%（${VERDICT_LABELS[diagnostics.verdict]}）· 词法覆盖 ${Math.round(diagnostics.lexicalCoverage * 100)}% · 语义覆盖 ${Math.round(diagnostics.semanticCoverage * 100)}%` })) : null, diagnostics !== null && diagnostics.suggestions.length > 0 ? (_jsx("span", { className: styles.intelSegment, children: diagnostics.suggestions[0] })) : null] })) : null, (researchLoading || research !== null || researchError.length > 0) && (_jsxs("div", { className: styles.researchPanel, children: [_jsxs("div", { className: styles.researchHead, children: [_jsxs("span", { className: styles.researchTitle, children: ["\u6DF1\u5EA6\u7814\u7A76", researchQuestion ? `：${researchQuestion}` : ''] }), !researchLoading ? (_jsx(Button, { variant: "secondary", onClick: () => {
                                    setResearch(null);
                                    setResearchError('');
                                    setResearchQuestion('');
                                }, children: "\u6536\u8D77" })) : null] }), researchLoading ? _jsx(Spinner, { label: "\u68C0\u7D22\u5386\u53F2\u5BF9\u8BDD\u5E76\u5408\u6210\u8BC1\u636E\u2026" }) : null, researchError ? _jsx("span", { className: styles.error, children: researchError }) : null, research !== null ? (_jsxs(_Fragment, { children: [_jsx("div", { className: styles.researchAnswer, children: research.answer }), research.evolution !== undefined && research.evolution.events.length > 0 ? (_jsxs("div", { className: styles.evolutionPanel, children: [_jsx("span", { className: styles.evolutionTitle, children: "\u77E5\u8BC6\u6F14\u5316\uFF08\u7B54\u6848\u968F\u65F6\u95F4\u53D8\u5316\u7684\u75D5\u8FF9\uFF09" }), research.evolution.events.slice(0, 4).map((event) => (_jsx("span", { className: styles.evolutionRow, children: `${event.anchor}: ${event.from} → ${event.to}（${event.kind === 'upgrade' ? '升级' : event.kind === 'downgrade' ? '回退' : '变化'}，${formatTime(event.toAt)}）` }, `${event.anchor}:${event.from}:${event.to}`))), _jsx("span", { className: styles.evolutionHint, children: research.evolution.summary })] })) : null, research.sources.length > 0 ? (_jsxs("div", { className: styles.researchSources, children: [_jsx("span", { className: styles.researchSourcesTitle, children: "\u8BC1\u636E\u6765\u6E90\uFF08\u70B9\u51FB\u76F4\u8FBE\u539F\u4F1A\u8BDD\uFF09" }), research.sources.map((source, index) => (_jsxs("div", { role: "button", tabIndex: 0, className: styles.researchSource, title: "\u70B9\u51FB\u8DF3\u8F6C\u5230\u8BE5\u4F1A\u8BDD", onClick: () => openSession(source.sessionId), onKeyDown: (event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                openSession(source.sessionId);
                                            }
                                        }, children: [_jsxs("span", { className: styles.researchSourceHead, children: [_jsxs("span", { className: styles.researchSourceIndex, children: ["[", index + 1, "]"] }), _jsx("span", { className: styles.researchSourceTitle, children: source.title ?? `会话 ${source.sessionId}` }), _jsx("span", { className: styles.researchSourceTime, children: formatTime(source.createdAt) })] }), source.snippet.length > 0 ? (_jsx("span", { className: styles.researchSourceSnippet, children: source.snippet })) : null] }, source.sessionId)))] })) : null, _jsxs("span", { className: styles.researchStats, children: ["\u68C0\u7D22 ", research.stats.candidates, " \u4E2A\u4F1A\u8BDD \u00B7 \u547D\u4E2D ", research.stats.chunks, " \u4E2A\u7247\u6BB5 \u00B7 \u91C7\u7528 ", research.stats.evidenceChunks, " \u6761\u8BC1\u636E \u00B7 ", research.model] })] })) : null] })), mapOpen ? (_jsxs("div", { className: styles.mapPanel, children: [_jsxs("div", { className: styles.mapHead, children: [_jsxs("span", { className: styles.mapTitle, children: ["\u77E5\u8BC6\u5730\u56FE", mapSessions > 0 ? `：${mapSessions} 个会话的主题分布` : ''] }), _jsx(Button, { variant: "secondary", onClick: () => {
                                    setMapOpen(false);
                                }, children: "\u6536\u8D77" })] }), mapLoading ? _jsx(Spinner, { label: "\u5BF9\u5386\u53F2\u4F1A\u8BDD\u505A\u4E3B\u9898\u805A\u7C7B\u2026" }) : null, mapError ? _jsx("span", { className: styles.error, children: mapError }) : null, !mapLoading && !mapError && mapClusters !== null && mapClusters.length === 0 ? (_jsx("span", { className: styles.muted, children: "\u6CA1\u6709\u91CD\u590D\u89E3\u51B3\u7684\u4E3B\u9898\u7C07\uFF08\u76F8\u4F3C\u4F1A\u8BDD\u90FD\u53EA\u51FA\u73B0\u8FC7\u4E00\u6B21\uFF09" })) : null, !mapLoading && !mapError && mapClusters !== null && mapClusters.length > 0 ? (_jsx("div", { className: styles.mapClusters, children: mapClusters.map((cluster) => (_jsxs("div", { role: "button", tabIndex: 0, className: styles.mapCluster, title: "\u70B9\u51FB\u4EE5\u8BE5\u4E3B\u9898\u53D1\u8D77\u8BED\u4E49\u68C0\u7D22", onClick: () => searchCluster(cluster), onKeyDown: (event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    searchCluster(cluster);
                                }
                            }, children: [_jsx("span", { className: styles.mapClusterLabel, children: cluster.label }), _jsxs("span", { className: styles.mapClusterMeta, children: [_jsxs(Pill, { className: styles.rankBadge, children: [cluster.size, " \u4E2A\u4F1A\u8BDD"] }), _jsxs("span", { className: styles.mapClusterTime, children: [formatTime(cluster.from), " ~ ", formatTime(cluster.to)] })] })] }, cluster.id))) })) : null] })) : null, pulseOpen ? (_jsxs("div", { className: styles.pulsePanel, children: [_jsxs("div", { className: styles.mapHead, children: [_jsxs("span", { className: styles.mapTitle, children: ["\u4E3B\u52A8\u8109\u640F", pulseSummary.length > 0 ? `：${pulseSummary}` : ''] }), _jsx(Button, { variant: "secondary", onClick: () => {
                                    setPulseOpen(false);
                                }, children: "\u6536\u8D77" })] }), pulseLoading ? _jsx(Spinner, { label: "\u805A\u5408\u4FE1\u53F7\u6E90\u5E76\u5408\u6210\u6D1E\u5BDF\u2026" }) : null, pulseError ? _jsx("span", { className: styles.error, children: pulseError }) : null, !pulseLoading && !pulseError && pulseCards !== null && pulseCards.length === 0 ? (_jsx("span", { className: styles.muted, children: "\u6CA1\u6709\u503C\u5F97\u4E3B\u52A8\u544A\u77E5\u7684\u4FE1\u53F7\u2014\u2014\u6D1E\u5BDF\u968F\u4F7F\u7528\u79EF\u7D2F\u800C\u751F\u957F" })) : null, !pulseLoading && !pulseError && pulseCards !== null && pulseCards.length > 0 ? (_jsx("div", { className: styles.pulseCards, children: pulseCards.map((card, index) => (_jsxs("div", { className: card.severity === 'critical'
                                ? styles.pulseCardCritical
                                : card.severity === 'watch'
                                    ? styles.pulseCardWatch
                                    : styles.pulseCardInfo, children: [_jsx("span", { className: styles.pulseCardText, children: card.text }), card.action ? _jsxs("span", { className: styles.pulseCardAction, children: ["\u2192 ", card.action] }) : null, _jsx("span", { className: styles.pulseCardSource, children: card.source })] }, `${card.category}:${index}`))) })) : null] })) : null, cognitionOpen ? (_jsx(CognitionPanel, { onOpenSession: openSession, onClose: () => setCognitionOpen(false) })) : null, _jsxs("div", { className: styles.tagRow, children: [tagsError ? _jsx("span", { className: styles.error, children: tagsError }) : null, !tagsError && allTags.length === 0 ? _jsx("span", { className: styles.muted, children: "\u6682\u65E0\u6807\u7B7E" }) : null, allTags.map((tag) => (
                    // Pill 原语不支持键盘交互属性（PillProps 未开放 role/tabIndex/onKeyDown），
                    // 故以外层 span 补齐 role="button"、tabIndex 与 Enter/Space 键激活。
                    _jsx("span", { role: "button", tabIndex: 0, "aria-pressed": selectedTags.has(tag), onClick: () => toggleTag(tag), onKeyDown: (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                toggleTag(tag);
                            }
                        }, children: _jsx(Pill, { className: selectedTags.has(tag) ? styles.tagActive : styles.tag, children: tag }) }, tag)))] }), _jsxs("div", { className: styles.results, children: [loading && hits.length === 0 ? _jsx(Spinner, { label: "\u68C0\u7D22\u4E2D\u2026" }) : null, error ? _jsx("div", { className: styles.error, children: error }) : null, !loading && !error && hits.length === 0 ? (_jsx("div", { className: styles.empty, children: semantic ? '没有语义相关的对话，试试换个说法或切换为关键词检索' : '没有匹配的对话，试试调整关键词、日期或标签' })) : null, hits.map((hit) => (_jsxs("div", { role: "button", tabIndex: 0, className: styles.resultItem, title: "\u70B9\u51FB\u8DF3\u8F6C\u5230\u8BE5\u4F1A\u8BDD", onClick: () => openSession(hit.session.id), onKeyDown: (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                openSession(hit.session.id);
                            }
                        }, children: [_jsxs("span", { className: styles.resultHead, children: [_jsx("span", { className: styles.resultTitle, children: hit.session.title ?? `会话 ${hit.session.id}` }), _jsxs("span", { className: styles.resultActions, children: [_jsx("span", { className: styles.resultTime, children: formatTime(hit.session.updatedAt ?? hit.session.createdAt) }), _jsx("span", { className: styles.insightWrap, onClick: (event) => event.stopPropagation(), onKeyDown: (event) => event.stopPropagation(), children: _jsx(Button, { variant: "secondary", className: styles.insightButton, title: "\u67E5\u770B\u8BE5\u4F1A\u8BDD\u7684\u77E5\u8BC6\u8D44\u4EA7\uFF1A\u5B9E\u4F53\u3001\u5EFA\u8BAE\u6807\u7B7E\u3001\u5173\u8054\u4F1A\u8BDD", onClick: () => {
                                                        setInsight(insight !== null && insight.id === hit.session.id
                                                            ? null
                                                            : { id: hit.session.id, title: hit.session.title });
                                                    }, children: "\u77E5\u8BC6" }) })] })] }), hit.snippet ? _jsx("span", { className: styles.resultSnippet, children: hit.snippet }) : null, hit.tags.length > 0 ? (_jsx("span", { className: styles.resultTags, children: hit.tags.map((tag) => (_jsx(Pill, { className: styles.resultTag, children: tag }, tag))) })) : null, semantic && (hit.lexicalRank !== undefined || hit.semanticRank !== undefined) ? (_jsxs("span", { className: styles.rankRow, children: [_jsxs(Pill, { className: styles.rankBadge, children: ["\u8BCD\u6CD5 #", hit.lexicalRank ?? '-'] }), _jsxs(Pill, { className: styles.rankBadge, children: ["\u8BED\u4E49 #", hit.semanticRank ?? '-'] })] })) : null, hit.explanationSummary ? (_jsx("span", { className: styles.explainRow, title: hit.explanationSummary, children: hit.explanationSummary })) : null] }, hit.session.id))), loading && hits.length > 0 ? _jsx(Spinner, { label: "\u52A0\u8F7D\u66F4\u591A\u2026" }) : null, !loading && !error && hits.length >= limit ? (_jsx("div", { className: styles.more, children: _jsx(Button, { variant: "secondary", onClick: () => setLimit((prev) => prev + PAGE_SIZE), children: "\u52A0\u8F7D\u66F4\u591A" }) })) : null] }), _jsx(KnowledgePanel, { target: insight, onSearchEntity: (name) => handleQueryChange(name), onOpenSession: openSession, onCloseTarget: () => setInsight(null) })] }));
}
