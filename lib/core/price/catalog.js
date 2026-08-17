/** 模型 id 前缀 → 厂商 id 的识别规则（按最长前缀优先匹配）。 */
const VENDOR_PREFIXES = [
    ['deepseek', 'deepseek'],
    ['glm', 'zhipu'],
    ['kimi', 'moonshot'],
    ['moonshot', 'moonshot'],
    ['qwen', 'qwen'],
    ['doubao', 'doubao'],
    ['minimax', 'minimax'],
    ['ernie', 'ernie'],
];
/** 厂商元信息。 */
export const VENDORS = {
    deepseek: { label: 'DeepSeek', pricingUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', tiered: false },
    zhipu: {
        label: '智谱 GLM',
        pricingUrl: 'https://open.bigmodel.cn/pricing',
        // 定价页是 Vue SPA 空壳：新模型价格内嵌在其 app.*.js 构建产物中，
        // 旧模型（GLM-4 及更早）来自无鉴权的 /api/biz/operation/query 运营位接口。
        dataSource: 'https://open.bigmodel.cn/api/biz/operation/query',
        fetchKind: 'zhipu-bundle',
        tiered: true,
    },
    moonshot: {
        label: '月之暗面 Kimi',
        pricingUrl: 'https://platform.kimi.com/docs/pricing/chat',
        // Kimi 定价页为客户端渲染，价格数据在 RSC 子页 payload 中，逐页抓取。
        dataSource: 'https://platform.kimi.com/docs/pricing/',
        fetchKind: 'kimi-rsc',
        tiered: false,
    },
    qwen: { label: '阿里通义千问', pricingUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', tiered: true },
    doubao: {
        label: '字节豆包',
        pricingUrl: 'https://www.volcengine.com/docs/82379/1544106',
        // 页面正文是客户端渲染的 Quill 富文本，但文档中心接口直接返回服务端
        // Markdown（Result.MDContent），按 H1 章节即可隔离文本模型价格表。
        dataSource: 'https://www.volcengine.com/api/doc/getDocDetail?BusinessID=82379&DocumentID=1544106',
        fetchKind: 'doubao-md',
        tiered: true,
    },
    minimax: { label: 'MiniMax', pricingUrl: 'https://platform.minimaxi.com/docs/guides/pricing-paygo', tiered: true },
    ernie: {
        label: '百度文心',
        pricingUrl: 'https://cloud.baidu.com/doc/WENXINWORKSHOP/s/hlrk4akp7',
        // cloud.baidu.com 反爬（TLS 重置），改抓其 CDN 上的 Gatsby page-data（同一文档的渲染源）。
        dataSource: 'https://bce.bdstatic.com/p3m/bce-doc/online/qianfan/doc/qianfan/s/page-data/wmh4sv6ya/page-data.json',
        fetchKind: 'ernie-cdn',
        tiered: true,
    },
};
/**
 * 内置价格目录（官方刊例价快照，元/百万 tokens）。
 * inputCacheHit 为缓存命中输入价；未公布缓存价的按输入价约 20% 估算并标注。
 */
export const CATALOG_TABLE = {
    // ---- 智谱 GLM（open.bigmodel.cn/pricing，低档价） ----
    'glm-5.2': { inputCacheHit: 2, inputMiss: 8, output: 28 },
    'glm-5.1': { inputCacheHit: 1.3, inputMiss: 6, output: 24 },
    'glm-5': { inputCacheHit: 0.8, inputMiss: 4, output: 18 },
    'glm-4.7': { inputCacheHit: 0.4, inputMiss: 2, output: 8 },
    'glm-4.7-flash': { inputCacheHit: 0, inputMiss: 0, output: 0 }, // 免费
    'glm-4.6': { inputCacheHit: 1, inputMiss: 5, output: 5 },
    'glm-4.5-air': { inputCacheHit: 0.16, inputMiss: 0.8, output: 2 },
    'glm-4-flash': { inputCacheHit: 0, inputMiss: 0, output: 0 }, // 免费
    'glm-4-flashx': { inputCacheHit: 0.02, inputMiss: 0.1, output: 0.1 },
    // ---- 月之暗面 Kimi（platform.kimi.com，人民币站） ----
    'kimi-k2.7-code': { inputCacheHit: 1.3, inputMiss: 6.5, output: 27 },
    'kimi-k2.7-code-highspeed': { inputCacheHit: 2.6, inputMiss: 13, output: 54 },
    'kimi-k2.6': { inputCacheHit: 1.1, inputMiss: 6.5, output: 27 },
    'kimi-k2.5': { inputCacheHit: 0.7, inputMiss: 4, output: 21 },
    // ---- 阿里通义千问（百炼，中国内地低档价） ----
    'qwen3-max': { inputCacheHit: 0.5, inputMiss: 2.5, output: 10 },
    'qwen3-plus': { inputCacheHit: 0.16, inputMiss: 0.8, output: 2 },
    'qwen3-flash': { inputCacheHit: 0.03, inputMiss: 0.15, output: 1.5 },
    'qwen3-coder-plus': { inputCacheHit: 0.2, inputMiss: 1, output: 4 },
    'qwen-plus': { inputCacheHit: 0.16, inputMiss: 0.8, output: 2 },
    'qwen-flash': { inputCacheHit: 0.03, inputMiss: 0.15, output: 1.5 },
    'qwen-turbo': { inputCacheHit: 0.06, inputMiss: 0.3, output: 0.6 },
    // ---- 字节豆包（火山方舟，输入 0-32K 档） ----
    'doubao-seed-2.1-pro': { inputCacheHit: 1.2, inputMiss: 6, output: 30 },
    'doubao-seed-2.1-turbo': { inputCacheHit: 0.6, inputMiss: 3, output: 15 },
    'doubao-seed-2.0-pro': { inputCacheHit: 0.64, inputMiss: 3.2, output: 16 },
    'doubao-seed-2.0-lite': { inputCacheHit: 0.12, inputMiss: 0.6, output: 3.6 },
    'doubao-seed-2.0-mini': { inputCacheHit: 0.04, inputMiss: 0.2, output: 2 },
    'doubao-seed-2.0-code': { inputCacheHit: 0.64, inputMiss: 3.2, output: 16 },
    'doubao-seed-1.8': { inputCacheHit: 0.16, inputMiss: 0.8, output: 8 },
    'doubao-seed-1.6': { inputCacheHit: 0.16, inputMiss: 0.8, output: 8 },
    'doubao-seed-1.6-lite': { inputCacheHit: 0.06, inputMiss: 0.3, output: 2.4 },
    'doubao-seed-1.6-flash': { inputCacheHit: 0.03, inputMiss: 0.15, output: 1.5 },
    'doubao-seed-code': { inputCacheHit: 0.24, inputMiss: 1.2, output: 8 },
    'doubao-1.5-pro-32k': { inputCacheHit: 0.16, inputMiss: 0.8, output: 2 },
    'doubao-1.5-lite-32k': { inputCacheHit: 0.06, inputMiss: 0.3, output: 0.6 },
    // ---- MiniMax（platform.minimaxi.com 按量计费） ----
    'minimax-m3': { inputCacheHit: 0.42, inputMiss: 2.1, output: 8.4 }, // ≤512K 输入永久五折后
    'minimax-m2.7': { inputCacheHit: 0.42, inputMiss: 2.1, output: 8.4 },
    'minimax-m2.7-highspeed': { inputCacheHit: 0.42, inputMiss: 4.2, output: 16.8 },
    'minimax-m2.5': { inputCacheHit: 0.21, inputMiss: 2.1, output: 8.4 },
    'minimax-m2': { inputCacheHit: 0.21, inputMiss: 2.1, output: 8.4 },
    // ---- 百度文心（千帆） ----
    'ernie-4.5': { inputCacheHit: 0.8, inputMiss: 4, output: 16 },
    'ernie-4.5-turbo': { inputCacheHit: 0.16, inputMiss: 0.8, output: 3.2 },
    'ernie-x1': { inputCacheHit: 0.4, inputMiss: 2, output: 8 },
    'ernie-x1-turbo': { inputCacheHit: 0.2, inputMiss: 1, output: 4 },
    'ernie-speed-8k': { inputCacheHit: 0, inputMiss: 0, output: 0 }, // 永久免费
    'ernie-3.5-8k': { inputCacheHit: 0, inputMiss: 0, output: 0 }, // 永久免费
};
/** 识别模型所属厂商；未知返回 undefined。 */
export function vendorOf(model) {
    const id = model.trim().toLowerCase();
    let best;
    let bestLen = 0;
    for (const [prefix, vendor] of VENDOR_PREFIXES) {
        if (id.startsWith(prefix) && prefix.length > bestLen) {
            best = vendor;
            bestLen = prefix.length;
        }
    }
    return best;
}
/** 某厂商的全部模型 id 前缀（用于在定价页表格中识别模型单元格）。 */
export function prefixesOf(vendorId) {
    return VENDOR_PREFIXES.filter(([, vendor]) => vendor === vendorId).map(([prefix]) => prefix);
}
