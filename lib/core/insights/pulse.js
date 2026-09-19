/**
 * 主动洞察引擎（轴线 18）：从「你问它答」到「它主动告诉你」。
 *
 * 设计动机：前 17 条轴线全部是反应式的——用户发起动作，系统响应。
 * 但系统在服务过程中持续积累着值得主动告知的信号：反复失败的搜索
 * （盲区）、越用越准的反馈画像（学习状态）、索引的覆盖健康。这些
 * 信号散落在各处，用户不问就永远看不见。
 *
 * 本模块是**信号提供者注入式**的聚合引擎：
 *
 * - 核心纯函数 `composePulse` 接收任意多个信号提供者的快照，
 *   统一为洞察卡片（分类 + 严重度 + 文本 + 建议动作）；
 * - 严重度驱动排序：critical > watch > info；
 * - 每卡片独立可解释（附信号来源），洞察不是黑箱推送；
 * - 模块独立性保持：现阶段由检索模块（E）注入盲区/学习/索引三类
 *   信号；架构上开放——任何模块未来可注册自己的信号提供者，
 *   聚合层不感知来源细节。
 *
 * 「Daily Pulse」语义：每次调用基于当前状态即时合成，无缓存无状态，
 * 同一时刻的两次调用产生相同结果（可测试性）。
 */
/** 严重度排序权重。 */
const SEVERITY_ORDER = new Map([
    ['critical', 0],
    ['watch', 1],
    ['info', 2],
]);
/** 卡片总数上限（推送克制：洞察过多等于没有洞察）。 */
const MAX_CARDS = 6;
/**
 * 合成当前脉搏：聚合全部信号提供者，按严重度排序，封顶 6 条。
 *
 * @param providers 信号提供者列表（空列表合法——返回空脉搏）。
 * @param now 合成时间戳。
 */
export function composePulse(providers, now) {
    const cards = [];
    for (const provider of providers) {
        // 单一提供者失败不拖垮整体脉搏（信号隔离）。
        try {
            cards.push(...provider());
        }
        catch {
            // 静默跳过：洞察是增强体验，不是关键路径。
        }
    }
    cards.sort((a, b) => {
        const order = (SEVERITY_ORDER.get(a.severity) ?? 9) - (SEVERITY_ORDER.get(b.severity) ?? 9);
        if (order !== 0)
            return order;
        // 同severity稳定排序：按分类名（可预测的展示序）。
        return a.category.localeCompare(b.category);
    });
    const top = cards.slice(0, MAX_CARDS);
    return {
        cards: top,
        summary: summarize(top),
        generatedAt: now,
    };
}
/** 盲区信号 → 洞察卡片（轴线 19 的主动化出口）。 */
export function blindSpotInsights(report) {
    if (report.blindSpots.length === 0)
        return [];
    const top = report.blindSpots[0];
    return [
        {
            category: 'blindspot',
            severity: top.searches >= 5 ? 'watch' : 'info',
            text: `你反复搜索「${top.anchor}」（${top.searches} 次）但历史对话无覆盖——这是知识资产的真实缺口`,
            action: top.advice,
            source: '检索盲区分析（轴 19）',
        },
    ];
}
/** 学习状态信号 → 洞察卡片（轴线 11 的饱和度播报）。 */
export function learningInsights(stats) {
    if (stats.profiledSessions === 0) {
        return [
            {
                category: 'learning',
                severity: 'info',
                text: '反馈学习尚未建立画像：在语义检索结果中点击会话，检索器将逐渐学会你真正想要的',
                action: '下次检索时点击结果即可开始积累',
                source: '反馈学习（轴 11）',
            },
        ];
    }
    if (stats.totalClicks < 10) {
        return [
            {
                category: 'learning',
                severity: 'info',
                text: `反馈学习已启动：${stats.profiledSessions} 个会话建立点击画像（累计 ${stats.totalClicks} 次点击）`,
                action: '画像随点击持续丰富，检索排序会越来越贴合你的偏好',
                source: '反馈学习（轴 11）',
            },
        ];
    }
    return [
        {
            category: 'learning',
            severity: 'info',
            text: `反馈学习运转中：${stats.profiledSessions} 个会话画像（累计 ${stats.totalClicks} 次点击）在持续影响排序`,
            source: '反馈学习（轴 11）',
        },
    ];
}
/** 索引健康信号 → 洞察卡片（覆盖与新鲜度）。 */
export function indexInsights(stats) {
    const cards = [];
    if (stats.totalSessions === 0) {
        cards.push({
            category: 'index',
            severity: 'watch',
            text: '语义索引为空：还没有任何会话被索引，语义检索暂不可用',
            action: '产生对话后索引会自动对账建立',
            source: '语义索引（轴 1）',
        });
        return cards;
    }
    const coverage = stats.indexedSessions / stats.totalSessions;
    if (coverage < 0.9) {
        cards.push({
            category: 'index',
            severity: coverage < 0.5 ? 'watch' : 'info',
            text: `索引覆盖率 ${Math.round(coverage * 100)}%（${stats.indexedSessions}/${stats.totalSessions}）——部分会话未进入语义检索范围`,
            action: '执行一次检索或重建索引可触发对账',
            source: '语义索引（轴 1）',
        });
    }
    if (stats.lastSyncAt !== null) {
        const ageMinutes = Math.max(0, (stats.now - stats.lastSyncAt) / 60_000);
        if (ageMinutes > 60) {
            cards.push({
                category: 'index',
                severity: 'info',
                text: `索引最近对账在 ${Math.round(ageMinutes / 60)} 小时前——近期对话可能尚未进入检索范围`,
                action: '执行任意检索即触发增量对账（约数秒）',
                source: '语义索引（轴 1）',
            });
        }
    }
    return cards;
}
/** 人话摘要。 */
function summarize(cards) {
    if (cards.length === 0)
        return '一切正常：没有值得主动告知的信号';
    const critical = cards.filter((card) => card.severity === 'critical').length;
    const watch = cards.filter((card) => card.severity === 'watch').length;
    const parts = [`${cards.length} 条洞察`];
    if (critical > 0)
        parts.push(`${critical} 条需立即关注`);
    if (watch > 0)
        parts.push(`${watch} 条建议留意`);
    return parts.join('，');
}
/** 到期意图信号 → 洞察卡片（轴线 20 的主动化出口）。 */
export function dueIntentionInsights(due) {
    if (due.length === 0)
        return [];
    const top = due[0];
    const severity = top.overdueDays >= 14 ? 'critical' : 'watch';
    return [
        {
            category: 'intention',
            severity,
            text: `你有 ${due.length} 条说过要做的事已到期未兑现（最久 ${top.overdueDays} 天：「${top.text.slice(0, 40)}…」）`,
            action: '运行 todo 命令查看全部到期意图——兑现或放下，都好过遗忘',
            source: '前瞻记忆（轴 20）',
        },
    ];
}
/** 到期复习信号 → 洞察卡片（轴线 21 的主动化出口）。 */
export function dueReviewInsights(due) {
    if (due.length === 0)
        return [];
    const freshCount = due.filter((item) => item.fresh).length;
    return [
        {
            category: 'review',
            severity: 'info',
            text: `${due.length} 条「问题→解法」知识到了复习时间（${freshCount} 条首次）——回想一下当时的解法，遗忘曲线正等着你`,
            action: '运行 review 命令开始检索式练习（先回忆再看答案）',
            source: '间隔重复（轴 21）',
        },
    ];
}
/** 片段资产信号 → 洞察卡片（轴线 21/22 的库容播报）。 */
export function episodeInsights(stats) {
    if (stats.episodes === 0) {
        return [
            {
                category: 'review',
                severity: 'info',
                text: '尚未从历史对话提取到「问题→解法」片段——解决过问题的对话会自动成为复习卡片与类比素材',
                action: '下次遇到「报错→解决」型对话后，这里会开始积累',
                source: '认知巩固（轴 21/22）',
            },
        ];
    }
    if (stats.crossDomainReady) {
        return [
            {
                category: 'review',
                severity: 'info',
                text: `知识库已有 ${stats.episodes} 条结构化经验（来自 ${stats.sessionsWithEpisodes} 个会话）——类比检索已可跨域匹配同构问题`,
                action: '遇到新问题时运行 analogy <问题描述> 找同构先例',
                source: '类比检索（轴 22）',
            },
        ];
    }
    return [
        {
            category: 'review',
            severity: 'info',
            text: `知识库已有 ${stats.episodes} 条结构化经验（来自 ${stats.sessionsWithEpisodes} 个会话）——积累更多不同领域的问题后，跨域类比会更准`,
            source: '认知巩固（轴 21/22）',
        },
    ];
}
/** 遗忘预测信号 → 洞察卡片（轴线 23 的主动化出口）。 */
export function forgettingForecastInsights(stats) {
    if (stats.criticalCount === 0 && stats.warningCount === 0) {
        if (stats.stableCount === 0)
            return [];
        return [
            {
                category: 'forecast',
                severity: 'info',
                text: `遗忘预测：${stats.stableCount} 条知识保持率全部 ≥70%——记忆健康`,
                source: '遗忘预测（轴 23）',
            },
        ];
    }
    if (stats.criticalCount > 0) {
        const warningPart = stats.warningCount > 0 ? `，另有 ${stats.warningCount} 条正在滑落` : '';
        return [
            {
                category: 'forecast',
                severity: 'critical',
                text: `${stats.criticalCount} 条知识已滑入深度遗忘区（保持率 <30%）${warningPart}——趁还有印象，抢救成本最低`,
                action: '运行 forecast 命令查看高危清单',
                source: '遗忘预测（轴 23）',
            },
        ];
    }
    return [
        {
            category: 'forecast',
            severity: 'watch',
            text: `${stats.warningCount} 条知识保持率跌破 70%——正值最佳巩固窗口（救得回来的区间）`,
            action: '运行 review 命令做检索式练习',
            source: '遗忘预测（轴 23）',
        },
    ];
}
/** 节律自适应信号 → 洞察卡片（轴线 24：显著偏离才播报，冷启动静默）。 */
export function rhythmInsights(profile) {
    const total = profile.remembered + profile.forgotten;
    if (total < 3)
        return [];
    if (profile.ease >= 1.2) {
        return [
            {
                category: 'review',
                severity: 'info',
                text: `你的记忆节律 ×${profile.ease.toFixed(2)}——比标准曲线记得牢，复习间隔已自动拉长 ${Math.round((profile.ease - 1) * 100)}%`,
                source: '节律自适应（轴 24）',
            },
        ];
    }
    if (profile.ease <= 0.8) {
        return [
            {
                category: 'review',
                severity: 'watch',
                text: `你的记忆节律 ×${profile.ease.toFixed(2)}——遗忘比标准曲线快，间隔已自动压缩 ${Math.round((1 - profile.ease) * 100)}% 保住知识`,
                action: '这不是记性差——是系统在适配你的遗忘速度',
                source: '节律自适应（轴 24）',
            },
        ];
    }
    return [];
}
/** 负荷调度信号 → 洞察卡片（轴线 25：只在洪峰时开口——顺延发生才有值得说的）。 */
export function loadInsights(plan) {
    if (plan.deferredCount === 0)
        return [];
    return [
        {
            category: 'review',
            severity: 'watch',
            text: `复习洪峰：${plan.totalDue} 条到期，今日已按遗忘风险精选 ${plan.todayCount} 条，其余 ${plan.deferredCount} 条顺延`,
            action: '完成今日 8 条即可——注意力留给救得回来的知识',
            source: '负荷调度（轴 25）',
        },
    ];
}
/** 主题漂移信号 → 洞察卡片（轴线 30：注意力结构变化的主动播报）。 */
export function driftInsights(stats) {
    if (stats.unitCount < 6)
        return [];
    if (stats.lastUnitSurprise >= 8) {
        return [
            {
                category: 'topic',
                severity: 'watch',
                text: `最近一条对话偏离当前主题较远（意外度 ${stats.lastUnitSurprise.toFixed(1)} bit/词元）——可能是一次注意力切换的开端`,
                action: '运行 drift 命令查看主题分段与切换点',
                source: '主题漂移（轴 30）',
            },
        ];
    }
    if (stats.changepoints > 0 && stats.currentRunLength <= 2 && stats.unitCount >= 12) {
        return [
            {
                category: 'topic',
                severity: 'info',
                text: `注意力刚切换到新主题（此前共 ${stats.changepoints} 次切换）——当前主题段刚起步`,
                source: '主题漂移（轴 30）',
            },
        ];
    }
    if (stats.changepoints === 0 && stats.unitCount >= 15) {
        const terms = stats.currentRunTopTerms.slice(0, 3).join('、');
        const termPart = terms.length > 0 ? `（关键词：${terms}）` : '';
        return [
            {
                category: 'topic',
                severity: 'info',
                text: `近 ${stats.unitCount} 个对话持续聚焦同一主题${termPart}——深度工作状态`,
                source: '主题漂移（轴 30）',
            },
        ];
    }
    return [];
}
/** 记忆固化信号 → 洞察卡片（轴线 31：近重复 = 天然强化证据）。 */
export function consolidationInsights(stats) {
    if (stats.items < 8 || stats.clusters === 0)
        return [];
    const topPart = stats.topReinforcement >= 3
        ? `，最高频的一组已出现 ${stats.topReinforcement} 次（正在自然强化）`
        : '';
    return [
        {
            category: 'review',
            severity: 'info',
            text: `知识库检测到 ${stats.clusters} 组近重复记忆（${stats.duplicates} 条冗余已可折叠）${topPart}——反复遇到的问题最值得先固化`,
            action: '运行 consolidate 命令查看重复簇与代表条目',
            source: '记忆固化（轴 31）',
        },
    ];
}
/** 回声雷达信号 → 洞察卡片（轴线 33：会话级复发 = 固化模板信号）。 */
export function echoRadarInsights(stats) {
    // 推送克制：样本不足或无回声不开口。
    if (stats.sessions < 8 || stats.clusters === 0)
        return [];
    const periodPart = stats.medianRecurrenceDays !== null
        ? `，平均复发周期约 ${stats.medianRecurrenceDays} 天`
        : '';
    if (stats.templateWorthy > 0) {
        return [
            {
                category: 'echo',
                severity: 'watch',
                text: `${stats.sessions} 场会话中检测到 ${stats.clusters} 组回声（${stats.duplicates} 场冗余）${periodPart}——${stats.templateWorthy} 个主题复发 ≥3 次，总在遗忘后重新发现`,
                action: '运行 radar 命令查看回声簇，把高频主题固化为交接模板',
                source: '回声雷达（轴 33）',
            },
        ];
    }
    // 无固化级主题时仅在回声率可观时知会（≥20% 且观察窗有样本）。
    if (stats.recentTotal >= 5 && stats.recentEchoes / stats.recentTotal >= 0.2) {
        return [
            {
                category: 'echo',
                severity: 'info',
                text: `近窗新会话回声率 ${Math.round((stats.recentEchoes / stats.recentTotal) * 100)}%（${stats.recentEchoes}/${stats.recentTotal}）——新对话中有相当部分在重新发现已知`,
                action: '运行 radar 命令查看哪些主题在复发',
                source: '回声雷达（轴 33）',
            },
        ];
    }
    return [];
}
