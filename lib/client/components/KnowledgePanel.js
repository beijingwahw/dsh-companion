import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 对话知识资产面板（模块 F 客户端 UI，轴线 4 + 轴线 7）：
 * - **全局实体图谱**：覆盖会话数最多的头部实体（点击实体 → 以实体名
 *   作为检索词发起检索，把知识图谱变成检索入口）；
 * - **主题趋势**（轴线 7）：近 14 天 vs 上一 14 天的实体动量——上升 /
 *   衰退主题 + 最近 8 周逐周覆盖迷你柱状图（注意力流向可视化）；
 * - **单会话洞察**（由检索结果的“知识”按钮触发）：会话实体列表
 *   （类型徽章 + 频次 + 全局覆盖数）、建议标签（一键应用到该会话，
 *   复用模块 D 的标签系统，不自动写入）、关联会话（实体重叠推荐，
 *   点击请求主平台跳转）。
 *
 * 数据全部来自本地 /knowledge/* 端点（实体抽取与趋势计算在宿主侧
 * 本地完成，零 LLM、零网络外发）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Pill, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { analyzeSessionKnowledge, fetchKnowledgeEntities, fetchKnowledgeTrends, fetchRelatedSessions, updateSessionTags, } from '../api.js';
import styles from './KnowledgePanel.module.css';
/** 实体类型的中文徽章文案。 */
const TYPE_LABELS = {
    command: '命令',
    path: '路径',
    tech: '技术',
    code: '代码',
    term: '术语',
    version: '版本',
};
/** 全局实体图谱的加载条数。 */
const GRAPH_LIMIT = 30;
/** 主题趋势的加载条数。 */
const TRENDS_LIMIT = 10;
/** 趋势方向的中文文案。 */
const DIRECTION_LABELS = {
    rising: '上升',
    falling: '衰退',
    stable: '平稳',
};
/** 对话知识资产面板。 */
export function KnowledgePanel({ target, onSearchEntity, onOpenSession, onCloseTarget, }) {
    const [graph, setGraph] = useState([]);
    const [graphError, setGraphError] = useState('');
    const [trends, setTrends] = useState([]);
    const [trendsDays, setTrendsDays] = useState(0);
    const [analysis, setAnalysis] = useState(null);
    const [related, setRelated] = useState([]);
    const [insightLoading, setInsightLoading] = useState(false);
    const [insightError, setInsightError] = useState('');
    const [applying, setApplying] = useState(false);
    // 挂载时拉取全局实体图谱（覆盖会话数降序）。
    useEffect(() => {
        let cancelled = false;
        fetchKnowledgeEntities({ limit: GRAPH_LIMIT })
            .then((response) => {
            if (!cancelled)
                setGraph(response.entities);
        })
            .catch((err) => {
            if (!cancelled)
                setGraphError(err instanceof Error ? err.message : '实体图谱加载失败');
        });
        return () => {
            cancelled = true;
        };
    }, []);
    // 挂载时拉取主题趋势（轴线 7：实体动量 + 8 周时间线；失败静默不阻塞图谱）。
    useEffect(() => {
        let cancelled = false;
        fetchKnowledgeTrends({ limit: TRENDS_LIMIT })
            .then((response) => {
            if (!cancelled) {
                setTrends(response.trends);
                setTrendsDays(response.days);
            }
        })
            .catch(() => {
            // 趋势失败：不展示该区块，不影响实体图谱。
        });
        return () => {
            cancelled = true;
        };
    }, []);
    // 洞察目标变化：并行拉取单会话实体分析与关联会话。
    useEffect(() => {
        if (target === null) {
            setAnalysis(null);
            setRelated([]);
            setInsightError('');
            return;
        }
        let cancelled = false;
        setInsightLoading(true);
        setInsightError('');
        Promise.all([analyzeSessionKnowledge(target.id), fetchRelatedSessions(target.id, 5)])
            .then(([analysisResponse, relatedResponse]) => {
            if (cancelled)
                return;
            setAnalysis(analysisResponse);
            setRelated(relatedResponse.related);
        })
            .catch((err) => {
            if (!cancelled)
                setInsightError(err instanceof Error ? err.message : '会话知识分析失败');
        })
            .finally(() => {
            if (!cancelled)
                setInsightLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [target]);
    /** 一键应用建议标签（Set 语义自动去重，已存在的不重复添加）。 */
    const applySuggestedTags = useCallback(() => {
        if (analysis === null || analysis.suggestedTags.length === 0)
            return;
        setApplying(true);
        updateSessionTags({ sessionId: analysis.sessionId, add: [...analysis.suggestedTags] })
            .then(() => {
            Toast.push(`已为会话应用 ${analysis.suggestedTags.length} 个建议标签`, 'info');
        })
            .catch((err) => {
            Toast.push(err instanceof Error ? err.message : '应用建议标签失败', 'error');
        })
            .finally(() => {
            setApplying(false);
        });
    }, [analysis]);
    return (_jsxs("div", { className: styles.panel, children: [_jsx("span", { className: styles.panelTitle, children: "\u77E5\u8BC6\u8D44\u4EA7" }), target !== null ? (_jsxs("div", { className: styles.section, children: [_jsxs("div", { className: styles.targetHead, children: [_jsxs("span", { className: styles.targetTitle, children: [target.title ?? `会话 ${target.id}`, " \u7684\u6D1E\u5BDF"] }), _jsx(Button, { variant: "secondary", onClick: onCloseTarget, children: "\u6536\u8D77" })] }), insightLoading ? _jsx(Spinner, { label: "\u5206\u6790\u4F1A\u8BDD\u77E5\u8BC6\u2026" }) : null, insightError ? _jsx("span", { className: styles.error, children: insightError }) : null, !insightLoading && !insightError && analysis !== null ? (_jsxs(_Fragment, { children: [_jsx("span", { className: styles.sectionTitle, children: "\u5B9E\u4F53\uFF08\u6309\u663E\u8457\u6027\u964D\u5E8F\uFF09" }), analysis.entities.length === 0 ? (_jsx("span", { className: styles.muted, children: "\u8BE5\u4F1A\u8BDD\u672A\u62BD\u53D6\u5230\u5B9E\u4F53" })) : (_jsx("div", { className: styles.entityCloud, children: analysis.entities.slice(0, 12).map((entity) => (_jsx("span", { role: "button", tabIndex: 0, title: `${TYPE_LABELS[entity.type]} · 频次 ${entity.freq} · 覆盖 ${entity.globalSessionCount} 个会话`, onClick: () => onSearchEntity(entity.name), onKeyDown: (event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            onSearchEntity(entity.name);
                                        }
                                    }, children: _jsxs(Pill, { className: styles.entityPill, children: [_jsx("span", { className: styles.typeBadge, children: TYPE_LABELS[entity.type] }), entity.name] }) }, `${entity.type}:${entity.name}`))) })), analysis.suggestedTags.length > 0 ? (_jsxs("div", { className: styles.suggestionRow, children: [_jsx("span", { className: styles.sectionTitle, children: "\u5EFA\u8BAE\u6807\u7B7E\uFF1A" }), analysis.suggestedTags.map((tag) => (_jsx(Pill, { className: styles.sharedPill, children: tag }, tag))), _jsx(Button, { variant: "secondary", disabled: applying, onClick: applySuggestedTags, children: applying ? '应用中…' : '一键应用' })] })) : null, related.length > 0 ? (_jsxs("div", { className: styles.section, children: [_jsx("span", { className: styles.sectionTitle, children: "\u5173\u8054\u4F1A\u8BDD\uFF08\u5B9E\u4F53\u91CD\u53E0\uFF09" }), _jsx("div", { className: styles.relatedList, children: related.map((hit) => (_jsxs("div", { role: "button", tabIndex: 0, className: styles.relatedItem, title: "\u70B9\u51FB\u8DF3\u8F6C\u5230\u8BE5\u4F1A\u8BDD", onClick: () => onOpenSession(hit.sessionId), onKeyDown: (event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                    onOpenSession(hit.sessionId);
                                                }
                                            }, children: [_jsxs("span", { className: styles.relatedHead, children: [_jsx("span", { className: styles.relatedTitle, children: hit.title ?? `会话 ${hit.sessionId}` }), _jsxs("span", { className: styles.relatedScore, children: ["\u76F8\u4F3C\u5EA6 ", hit.score.toFixed(3)] })] }), hit.sharedEntities.length > 0 ? (_jsx("span", { className: styles.sharedRow, children: hit.sharedEntities.map((entity) => (_jsx(Pill, { className: styles.sharedPill, children: entity.name }, `${entity.type}:${entity.name}`))) })) : null] }, hit.sessionId))) })] })) : null] })) : null, _jsx("div", { className: styles.divider })] })) : null, trends.length > 0 ? (_jsxs("div", { className: styles.section, children: [_jsxs("span", { className: styles.sectionTitle, children: ["\u4E3B\u9898\u8D8B\u52BF\uFF08\u8FD1 ", trendsDays, " \u5929 vs \u4E0A\u4E00 ", trendsDays, " \u5929\uFF09"] }), _jsx("div", { className: styles.trendList, children: trends.map((trend) => (_jsxs("div", { className: styles.trendRow, role: "button", tabIndex: 0, title: `${DIRECTION_LABELS[trend.direction]} · ${trend.previousSessions} → ${trend.recentSessions} 个会话 · 动量 ${trend.momentum.toFixed(2)}`, onClick: () => onSearchEntity(trend.name), onKeyDown: (event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    onSearchEntity(trend.name);
                                }
                            }, children: [_jsxs("span", { className: styles.trendName, children: [_jsx("span", { className: styles.typeBadge, children: TYPE_LABELS[trend.type] }), trend.name] }), _jsxs("span", { className: `${styles.trendDirection} ${trend.direction === 'rising'
                                        ? styles.trendRising
                                        : trend.direction === 'falling'
                                            ? styles.trendFalling
                                            : ''}`, children: [DIRECTION_LABELS[trend.direction], trend.direction !== 'stable' ? ` ${Math.abs(Math.round(trend.momentum * 100))}%` : ''] }), _jsx("span", { className: styles.trendBars, "aria-hidden": "true", children: trend.series.map((count, index) => (_jsx("span", { className: `${styles.trendBar} ${count === 0 ? styles.trendBarEmpty : ''}`, style: { height: `${Math.max(3, Math.min(20, count * 5))}px` } }, index))) })] }, `${trend.type}:${trend.name}`))) })] })) : null, _jsxs("div", { className: styles.section, children: [_jsx("span", { className: styles.sectionTitle, children: "\u5168\u5C40\u5B9E\u4F53\u56FE\u8C31\uFF08\u70B9\u51FB\u5B9E\u4F53\u68C0\u7D22\uFF09" }), graphError ? _jsx("span", { className: styles.error, children: graphError }) : null, !graphError && graph.length === 0 ? (_jsx("span", { className: styles.muted, children: "\u6682\u65E0\u5B9E\u4F53\u6570\u636E\uFF08\u5BF9\u8BDD\u79EF\u7D2F\u540E\u81EA\u52A8\u751F\u6210\uFF09" })) : null, _jsx("div", { className: styles.entityCloud, children: graph.map((entity) => (_jsx("span", { role: "button", tabIndex: 0, title: `${TYPE_LABELS[entity.type]} · ${entity.sessionCount} 个会话 · 累计 ${entity.totalFreq} 次`, onClick: () => onSearchEntity(entity.name), onKeyDown: (event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    onSearchEntity(entity.name);
                                }
                            }, children: _jsxs(Pill, { className: styles.entityPill, children: [_jsx("span", { className: styles.typeBadge, children: TYPE_LABELS[entity.type] }), entity.name] }) }, `${entity.type}:${entity.name}`))) })] })] }));
}
