import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 认知面板（轴线 20–25 客户端 UI）：对话历史从被动资产变成主动认知伙伴。
 * - **前瞻记忆**（轴线 20）：对话里说过要做的事，到期主动浮现——
 *   「5 天前你说要试试 X，做了吗？」；即将到来的意图提前预告；
 * - **间隔重复**（轴线 21）：历史「问题→解法」片段的检索式练习——
 *   先看问题回忆解法（回忆比重看记得牢），再自评「记得/忘了」，
 *   SM2-lite 阶梯调度（1/3/7/14/30/60 天）；
 * - **类比检索**（轴线 22）：以当前问题描述找**结构同构**的历史经验——
 *   主题不同而约束结构相同（如 docker 网络隔离 ↔ k8s service 互通），
 *   跨域命中单独标注——这是主题检索永远找不到的先例；
 * - **遗忘预测**（轴线 23）：每条知识的连续保持率画像——
 *   ≥70% 健康 / 30–70% 滑落区（最佳巩固窗口）/ <30% 深度遗忘，
 *   在你遗忘之前看见它正在滑落；
 * - **个体节律**（轴线 24）：间隔随你的真实记忆表现伸缩
 *   （目标 85% 命中率 = 合意困难），你不是「平均人类」；
 * - **负荷调度**（轴线 25）：到期复习按可救性分诊、每日封顶、
 *   洪峰顺延——复习是一份每日计划，不是一场倾倒。
 *
 * 数据全部来自本地 /knowledge/* 认知端点（提取与调度在宿主侧本地
 * 完成，零 LLM、零网络外发）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Pill, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { fetchKnowledgeCognition, gradeKnowledgeReview, searchKnowledgeAnalogy, } from '../api.js';
import styles from './CognitionPanel.module.css';
/** 到期复习区默认展示的卡片数（检索式练习一次不宜贪多）。 */
const REVIEW_LIMIT = 5;
/** 到期意图区默认展示条数。 */
const DUE_LIMIT = 8;
/** 遗忘预测区展示的最危险条目数。 */
const FORECAST_LIMIT = 3;
/** 类比查询输入的最大长度（与服务端校验一致）。 */
const ANALOGY_MAX_LENGTH = 500;
/** 毫秒时间戳 → 日期（YYYY-MM-DD）。 */
function formatDate(ts) {
    return new Date(ts).toLocaleDateString('zh-CN');
}
/** 预测条目的滑落速度注记：N 天后跌入深度遗忘 / 已跌破。 */
function forecastEta(item) {
    if (item.daysToThreshold <= 0)
        return '已跌破阈值';
    return `${Math.ceil(item.daysToThreshold)} 天后跌入深度遗忘`;
}
/** 保持率 → 进度条填充色类名（分区语义色）。 */
function retentionBarClass(zone) {
    if (zone === 'critical')
        return styles.barCritical;
    if (zone === 'warning')
        return styles.barWarning;
    return styles.barStable;
}
/** 类比命中的跨域/同域徽章文案。 */
function analogyBadge(hit) {
    return hit.crossDomain ? '跨域类比' : '同域先例';
}
/** 认知面板。 */
export function CognitionPanel({ onOpenSession, onClose }) {
    const [overview, setOverview] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    /** 已翻开解法面的复习卡片（检索式练习：先回忆再核对）。 */
    const [revealed, setRevealed] = useState(new Set());
    /** 评分中的卡片（防重复提交）。 */
    const [grading, setGrading] = useState('');
    /** 类比检索：查询词与结果。 */
    const [analogyQuery, setAnalogyQuery] = useState('');
    const [analogy, setAnalogy] = useState(null);
    const [analogyLoading, setAnalogyLoading] = useState(false);
    const [analogyError, setAnalogyError] = useState('');
    // 挂载时拉取认知总览（到期意图 + 到期复习 + 统计，单次请求）。
    useEffect(() => {
        let cancelled = false;
        fetchKnowledgeCognition()
            .then((response) => {
            if (!cancelled)
                setOverview(response);
        })
            .catch((err) => {
            if (!cancelled)
                setError(err instanceof Error ? err.message : '认知总览加载失败');
        })
            .finally(() => {
            if (!cancelled)
                setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, []);
    /** 翻开一张复习卡片的解法面。 */
    const reveal = useCallback((episodeId) => {
        setRevealed((prev) => new Set([...prev, episodeId]));
    }, []);
    /**
     * 复习评分（轴线 21）：记得 → 升档（间隔拉长）；忘了 → 归零（明天重来）。
     * 评分成功后卡片离开本期队列，Toast 告知下次复习时间。
     */
    const grade = useCallback((episodeId, remembered) => {
        setGrading(episodeId);
        gradeKnowledgeReview({ episodeId, remembered })
            .then((response) => {
            const rhythmNote = response.ease !== undefined ? `（节律 ×${response.ease.toFixed(2)}）` : '';
            Toast.push(remembered
                ? `记得！已升档，下次复习：${response.nextIntervalDays} 天后${rhythmNote}`
                : `已归零重来，明天再复习一次${rhythmNote}`, 'info');
            setOverview((prev) => prev === null
                ? prev
                : {
                    ...prev,
                    reviews: prev.reviews.filter((item) => item.episodeId !== episodeId),
                    plan: prev.plan === undefined
                        ? undefined
                        : {
                            ...prev.plan,
                            today: prev.plan.today.filter((item) => item.review.episodeId !== episodeId),
                        },
                    rhythm: prev.rhythm === undefined || response.ease === undefined
                        ? prev.rhythm
                        : { ...prev.rhythm, ease: response.ease },
                });
            setRevealed((prev) => {
                const next = new Set(prev);
                next.delete(episodeId);
                return next;
            });
        })
            .catch((err) => {
            Toast.push(err instanceof Error ? err.message : '复习评分失败', 'error');
        })
            .finally(() => {
            setGrading('');
        });
    }, []);
    /** 发起类比检索（轴线 22：以结构形状找同构先例）。 */
    const runAnalogy = useCallback(() => {
        const q = analogyQuery.trim();
        if (q.length === 0) {
            Toast.push('请先描述当前遇到的问题', 'warning');
            return;
        }
        setAnalogyLoading(true);
        setAnalogyError('');
        searchKnowledgeAnalogy(q)
            .then((response) => {
            setAnalogy(response);
        })
            .catch((err) => {
            setAnalogyError(err instanceof Error ? err.message : '类比检索失败');
        })
            .finally(() => {
            setAnalogyLoading(false);
        });
    }, [analogyQuery]);
    const dueIntentions = overview?.intentions.due.slice(0, DUE_LIMIT) ?? [];
    const upcoming = overview?.intentions.upcoming ?? [];
    const stats = overview?.stats;
    const forecast = overview?.forecast;
    const plan = overview?.plan;
    const rhythm = overview?.rhythm;
    /**
     * 复习卡片源（轴线 25 感知）：负荷计划的今日精选带分诊结论
     * （保持率 + 理由）；旧服务端无 plan 时回退到期清单。
     */
    const reviewCards = plan !== undefined && plan.today.length > 0
        ? plan.today.slice(0, REVIEW_LIMIT).map((item) => ({
            ...item.review,
            retention: item.retention,
            reason: item.reason,
        }))
        : (overview?.reviews.slice(0, REVIEW_LIMIT) ?? []);
    /** 预测区展示条目：滑落区优先（最佳巩固窗口），无滑落时展示深度遗忘。 */
    const forecastItems = forecast === undefined
        ? []
        : forecast.warning.length > 0
            ? forecast.warning.slice(0, FORECAST_LIMIT)
            : forecast.critical.slice(0, FORECAST_LIMIT);
    return (_jsxs("div", { className: styles.panel, children: [_jsxs("div", { className: styles.head, children: [_jsx("span", { className: styles.title, children: "\u8BA4\u77E5\u9762\u677F" }), stats ? (_jsx("span", { className: styles.stats, children: `${stats.sessions} 个会话 · ${stats.intentions} 条意图 · ${stats.episodes} 条经验 · ${stats.reviewStates} 条在巩固` })) : null, _jsx(Button, { variant: "secondary", onClick: onClose, children: "\u6536\u8D77" })] }), loading ? _jsx(Spinner, { label: "\u6C47\u603B\u8BA4\u77E5\u4FE1\u53F7\u2026" }) : null, error ? _jsx("span", { className: styles.error, children: error }) : null, !loading && !error ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles.section, children: [_jsx("span", { className: styles.sectionTitle, children: "\u8BF4\u8FC7\u8981\u505A\u7684\u4E8B\uFF08\u524D\u77BB\u8BB0\u5FC6\uFF09" }), dueIntentions.length === 0 ? (_jsx("span", { className: styles.muted, children: "\u6CA1\u6709\u5230\u671F\u7684\u610F\u56FE\u2014\u2014\u8BF4\u8FC7\u8981\u505A\u7684\u4E8B\u4F1A\u5728\u5230\u671F\u65F6\u5728\u8FD9\u91CC\u6D6E\u73B0" })) : (_jsx("div", { className: styles.intentionList, children: dueIntentions.map((item) => (_jsxs("div", { className: styles.intentionItem, role: "button", tabIndex: 0, title: "\u70B9\u51FB\u8DF3\u8F6C\u5230\u610F\u56FE\u6765\u6E90\u4F1A\u8BDD", onClick: () => onOpenSession(item.sessionId), onKeyDown: (event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            onOpenSession(item.sessionId);
                                        }
                                    }, children: [_jsx("span", { className: styles.intentionText, children: item.text }), _jsx("span", { className: `${styles.overdueBadge} ${item.overdueDays >= 14 ? styles.overdueCritical : ''}`, children: item.overdueDays === 0 ? '今天到期' : `超期 ${item.overdueDays} 天` })] }, `${item.sessionId}:${item.dueAt}:${item.text}`))) })), upcoming.length > 0 ? (_jsx("span", { className: styles.upcoming, children: `即将到来：${upcoming
                                    .slice(0, 3)
                                    .map((item) => `${formatDate(item.dueAt)}「${item.text.slice(0, 24)}」`)
                                    .join('、')}` })) : null] }), _jsx("div", { className: styles.divider }), _jsxs("div", { className: styles.section, children: [_jsxs("span", { className: styles.sectionTitleRow, children: [_jsx("span", { className: styles.sectionTitle, children: "\u9057\u5FD8\u9884\u6D4B\uFF08\u4FDD\u6301\u7387\u5B9E\u65F6\u753B\u50CF\uFF09" }), forecast !== undefined ? (_jsx("span", { className: styles.rhythmMark, title: forecast.summary, children: `稳定 ${forecast.stableCount} · 滑落 ${forecast.warningCount} · 深忘 ${forecast.criticalCount}` })) : null] }), forecast === undefined ? (_jsx("span", { className: styles.muted, children: "\u9057\u5FD8\u9884\u6D4B\u4E0D\u53EF\u7528" })) : forecastItems.length === 0 ? (_jsx("span", { className: styles.muted, children: "\u6240\u6709\u77E5\u8BC6\u4FDD\u6301\u7387 \u226570%\u2014\u2014\u8BB0\u5FC6\u72B6\u6001\u5065\u5EB7" })) : (_jsx("div", { className: styles.forecastList, children: forecastItems.map((item) => (_jsxs("div", { className: styles.forecastItem, role: "button", tabIndex: 0, title: "\u70B9\u51FB\u8DF3\u8F6C\u5230\u8BE5\u77E5\u8BC6\u6765\u6E90\u4F1A\u8BDD", onClick: () => onOpenSession(item.sessionId), onKeyDown: (event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            onOpenSession(item.sessionId);
                                        }
                                    }, children: [_jsx("span", { className: styles.forecastProblem, children: item.problem }), _jsxs("span", { className: styles.retentionBar, children: [_jsx("span", { className: styles.retentionTrack, children: _jsx("span", { className: `${styles.bar} ${retentionBarClass(item.zone)}`, style: { width: `${Math.max(2, Math.round(item.retention * 100))}%` } }) }), _jsx("span", { className: styles.retentionText, children: `${Math.round(item.retention * 100)}% · ${item.zone === 'warning' ? '滑落区' : '深度遗忘'}` })] }), _jsx("span", { className: styles.forecastEta, children: forecastEta(item) })] }, item.episodeId))) }))] }), _jsx("div", { className: styles.divider }), _jsxs("div", { className: styles.section, children: [_jsxs("span", { className: styles.sectionTitleRow, children: [_jsx("span", { className: styles.sectionTitle, children: "\u5230\u671F\u590D\u4E60\uFF08\u5148\u56DE\u5FC6\uFF0C\u518D\u770B\u89E3\u6CD5\uFF09" }), plan !== undefined && plan.health === 'overload' ? (_jsx(Pill, { className: styles.overloadPill, children: `复习洪峰：${plan.deferredCount} 条顺延` })) : null, rhythm !== undefined ? (_jsx("span", { className: styles.rhythmMark, title: `个体节律（轴线 24）：间隔乘子 ${rhythm.ease.toFixed(2)}，目标 85% 命中率`, children: `节律 ×${rhythm.ease.toFixed(2)}` })) : null] }), plan !== undefined && plan.totalDue > plan.today.length ? (_jsx("span", { className: styles.planSummary, children: plan.summary })) : null, reviewCards.length === 0 ? (_jsx("span", { className: styles.muted, children: "\u6CA1\u6709\u5230\u671F\u7684\u590D\u4E60\u5361\u7247\u2014\u2014\u89E3\u51B3\u8FC7\u95EE\u9898\u7684\u5BF9\u8BDD\u4F1A\u81EA\u52A8\u79EF\u7D2F\u6210\u5361\u7247\uFF0C\u6B21\u65E5\u9996\u590D\u4E60" })) : (_jsx("div", { className: styles.reviewList, children: reviewCards.map((item) => (_jsxs("div", { className: styles.reviewCard, children: [_jsx("span", { className: styles.reviewProblem, children: item.problem }), item.reason ? (_jsxs("span", { className: styles.triageRow, children: [_jsx("span", { className: styles.retentionMini, children: `保持率 ${Math.round((item.retention ?? 0) * 100)}%` }), _jsx("span", { className: styles.triageReason, children: item.reason })] })) : null, revealed.has(item.episodeId) ? (_jsx("span", { className: styles.reviewSolution, children: item.solution })) : (_jsx(Button, { variant: "secondary", onClick: () => reveal(item.episodeId), children: "\u56DE\u60F3\u540E\u770B\u89E3\u6CD5" })), revealed.has(item.episodeId) ? (_jsxs("span", { className: styles.gradeRow, children: [_jsx(Button, { variant: "secondary", disabled: grading === item.episodeId, title: "\u8BB0\u5F97\uFF1A\u95F4\u9694\u5347\u6863\uFF081\u21923\u21927\u219214\u219230\u219260 \u5929\uFF09", onClick: () => grade(item.episodeId, true), children: "\u8BB0\u5F97" }), _jsx(Button, { variant: "secondary", disabled: grading === item.episodeId, title: "\u5FD8\u4E86\uFF1A\u5F52\u96F6\u91CD\u6765\uFF0C\u660E\u5929\u518D\u590D\u4E60", onClick: () => grade(item.episodeId, false), children: "\u5FD8\u4E86" }), _jsxs("span", { className: styles.reviewMeta, children: [item.fresh ? '首次复习' : `巩固度 ${Math.round(item.strength * 100)}%`, item.overdueDays > 0 ? ` · 逾期 ${item.overdueDays} 天` : ''] })] })) : null] }, item.episodeId))) }))] }), _jsx("div", { className: styles.divider }), _jsxs("div", { className: styles.section, children: [_jsx("span", { className: styles.sectionTitle, children: "\u7C7B\u6BD4\u68C0\u7D22\uFF08\u627E\u7ED3\u6784\u540C\u6784\u7684\u5148\u4F8B\uFF09" }), _jsxs("div", { className: styles.analogyRow, children: [_jsx(Input, { className: styles.analogyInput, type: "search", value: analogyQuery, placeholder: "\u63CF\u8FF0\u5F53\u524D\u7684\u95EE\u9898\uFF08\u5982\uFF1A\u4E24\u4E2A\u670D\u52A1\u4E92\u76F8\u8C03\u7528\u4E00\u76F4\u8D85\u65F6\uFF09\u2026", onChange: (event) => setAnalogyQuery(event.target.value.slice(0, ANALOGY_MAX_LENGTH)), onKeyDown: (event) => {
                                            if (event.key === 'Enter')
                                                runAnalogy();
                                        } }), _jsx(Button, { variant: "secondary", disabled: analogyLoading, onClick: runAnalogy, children: analogyLoading ? '检索中…' : '找类比' })] }), analogyError ? _jsx("span", { className: styles.error, children: analogyError }) : null, analogy ? (_jsxs(_Fragment, { children: [_jsx("span", { className: styles.analogySummary, children: analogy.summary }), analogy.analogies.length > 0 ? (_jsx("div", { className: styles.analogyList, children: analogy.analogies.map((hit) => (_jsxs("div", { className: styles.analogyCard, role: "button", tabIndex: 0, title: "\u70B9\u51FB\u8DF3\u8F6C\u5230\u8BE5\u4F1A\u8BDD", onClick: () => onOpenSession(hit.sessionId), onKeyDown: (event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                    onOpenSession(hit.sessionId);
                                                }
                                            }, children: [_jsxs("span", { className: styles.analogyHead, children: [_jsxs("span", { className: styles.analogyBadgeRow, children: [_jsx(Pill, { className: hit.crossDomain ? styles.crossDomainPill : styles.sameDomainPill, children: analogyBadge(hit) }), _jsx("span", { className: styles.analogyScore, children: `结构相似度 ${Math.round(hit.score * 100)}%` })] }), _jsx("span", { className: styles.analogyTitle, children: hit.title ?? `会话 ${hit.sessionId}` })] }), hit.sharedConstraints.length > 0 ? (_jsx("span", { className: styles.sharedRow, children: hit.sharedConstraints.map((kind) => (_jsx(Pill, { className: styles.sharedPill, children: kind }, kind))) })) : null, _jsx("span", { className: styles.analogyProblem, children: hit.problem }), _jsx("span", { className: styles.analogySolution, children: hit.solution })] }, hit.episodeId))) })) : null] })) : null] })] })) : null] }));
}
