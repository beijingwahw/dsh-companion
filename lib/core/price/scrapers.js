/**
 * 通用官方定价页抓取解析（移植自 dsh-usage-ledger/src/scrapers.ts）：
 * 从任意厂商定价页 HTML 中自动发现模型与价格，使新模型上线官方定价页后
 * 无需改代码即可被自动导入。
 *
 * 支持两种常见表格布局：
 *  1. 行布局：每行一个模型，表头标注 输入/输出/缓存 列（智谱/通义/豆包等常见）
 *  2. 列布局：表头为模型名，行为价格类型（DeepSeek 风格）
 *
 * 单位自动归一化为 元/百万tokens（千tokens 价格 ×1000）；"免费"记为 0；
 * 美元价格跳过（回退内置目录），阶梯计价页取每个模型首次出现的档位。
 */
import { prefixesOf } from './catalog.js';
/** 去除标签并解码定价页常用的少量 HTML 实体。 */
function cellText(raw) {
    return raw
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/** 提取全部表格为原始单元格行（保留 span 属性）。 */
export function parseRawTables(html) {
    const tables = [];
    for (const tableHtml of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
        const rows = [];
        for (const rowHtml of tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
            const cells = [];
            const cellRe = /<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
            let match;
            while ((match = cellRe.exec(rowHtml)) !== null) {
                const attrs = match[1] ?? '';
                const rowspan = Number(attrs.match(/rowspan=["']?(\d+)/)?.[1] ?? 1);
                const colspan = Number(attrs.match(/colspan=["']?(\d+)/)?.[1] ?? 1);
                cells.push({
                    text: cellText(match[2] ?? ''),
                    rowspan: Number.isFinite(rowspan) && rowspan > 0 ? rowspan : 1,
                    colspan: Number.isFinite(colspan) && colspan > 0 ? colspan : 1,
                });
            }
            if (cells.length > 0)
                rows.push(cells);
        }
        if (rows.length > 0)
            tables.push(rows);
    }
    return tables;
}
/** 展开 rowspan/colspan 为矩形文本网格。 */
export function toGrid(rows) {
    const grid = [];
    const carry = new Map();
    for (const row of rows) {
        const out = [];
        let col = 0;
        let index = 0;
        while (index < row.length || carry.has(col)) {
            const carried = carry.get(col);
            if (carried !== undefined) {
                out.push(carried.text);
                carried.left -= 1;
                if (carried.left <= 0)
                    carry.delete(col);
                col += 1;
                continue;
            }
            if (index >= row.length)
                break;
            const cell = row[index];
            if (cell === undefined)
                break;
            out.push(cell.text);
            if (cell.rowspan > 1)
                carry.set(col, { text: cell.text, left: cell.rowspan - 1 });
            col += 1;
            for (let filler = 1; filler < cell.colspan; filler += 1) {
                out.push('');
                col += 1;
            }
            index += 1;
        }
        grid.push(out);
    }
    return grid;
}
/**
 * 解析单个价格单元格为 元/百万 tokens。
 * "免费" → 0；美元单元格 → undefined（不支持，调用方回退）。
 */
export function parsePriceCell(text) {
    const t = text.replace(/,/g, '');
    if (/免费|free/i.test(t))
        return 0;
    if (/[$＄]|usd|美元/i.test(t))
        return undefined;
    const match = t.match(/(\d+(?:\.\d+)?)/);
    if (match === null || match[1] === undefined)
        return undefined;
    let value = Number(match[1]);
    if (!Number.isFinite(value))
        return undefined;
    if (/每千|\/千|千\s*tokens|\/1k|per 1k/i.test(t))
        value *= 1000;
    return value;
}
/** 将表头/标签文本归类为价格类型。 */
function kindOf(text) {
    const t = text.toLowerCase();
    const miss = t.includes('未命中') || /miss/.test(t);
    if ((t.includes('缓存命中') || t.includes('命中缓存') || t.includes('cache hit')) && !miss)
        return 'inputCacheHit';
    if (t.includes('输入') || t.includes('input'))
        return 'inputMiss';
    if (t.includes('输出') || t.includes('output'))
        return 'output';
    return undefined;
}
/** 表头单元格是否像价格列（含价格关键词）。 */
function isPriceHeader(text) {
    return /单价|价格|元|¥|\$|price|\/百万|per\s*m|每百万/i.test(text);
}
/** 行布局：表头命名列名下每行一个模型。 */
function parseRowLayout(grid, idRe, table) {
    for (let h = 0; h < Math.min(grid.length, 4); h += 1) {
        const header = grid[h];
        if (header === undefined)
            continue;
        const kindCols = new Map();
        header.forEach((text, col) => {
            // 价格列必须同时命名单价类型且携带价格关键词，
            // 避免"单次请求的输入 Token 数"这类尺寸列被误认为价格。
            if (!isPriceHeader(text))
                return;
            const kind = kindOf(text);
            if (kind !== undefined && !kindCols.has(col))
                kindCols.set(col, kind);
        });
        const kinds = [...kindCols.values()];
        if (!kinds.includes('inputMiss') || !kinds.includes('output'))
            continue;
        let modelCol = header.findIndex((text) => /模型|model/i.test(text));
        if (modelCol < 0)
            modelCol = 0;
        for (const row of grid.slice(h + 1)) {
            const match = (row[modelCol] ?? '').match(idRe);
            if (match === null || match[1] === undefined)
                continue;
            const model = match[1].toLowerCase();
            if (table[model] !== undefined)
                continue; // 保留首个（最低）档位
            let inputMiss;
            let output;
            let cacheHit;
            for (const [col, kind] of kindCols) {
                const value = parsePriceCell(row[col] ?? '');
                if (value === undefined)
                    continue;
                if (kind === 'inputMiss')
                    inputMiss ??= value;
                else if (kind === 'output')
                    output ??= value;
                else
                    cacheHit ??= value;
            }
            if (inputMiss === undefined || output === undefined)
                continue;
            table[model] = { inputCacheHit: cacheHit ?? 0, inputMiss, output };
        }
    }
}
/** 列布局：表头行为模型 id，标签行为价格类型。 */
function parseColumnLayout(grid, idRe, table) {
    const header = grid[0];
    if (header === undefined)
        return;
    const modelCols = [];
    header.forEach((text, col) => {
        const match = text.match(idRe);
        if (match !== null && match[1] !== undefined)
            modelCols.push([col, match[1].toLowerCase()]);
    });
    if (modelCols.length === 0)
        return;
    for (const row of grid.slice(1)) {
        const kind = kindOf(row[0] ?? '');
        if (kind === undefined)
            continue;
        for (const [col, model] of modelCols) {
            const value = parsePriceCell(row[col] ?? '');
            if (value === undefined)
                continue;
            const existing = table[model] ?? { inputCacheHit: 0, inputMiss: 0, output: 0 };
            if (existing[kind] === 0)
                existing[kind] = value;
            table[model] = existing;
        }
    }
}
/**
 * 从某厂商官方定价页 HTML 自动发现全部带价模型。
 * 无可识别内容（如纯 JS 渲染页）时返回空表，调用方沿用现有价格。
 */
export function parseVendorSheet(html, vendorId) {
    const prefixes = prefixesOf(vendorId);
    if (prefixes.length === 0)
        return {};
    const idRe = new RegExp(`((?:${prefixes.join('|')})[\\w.-]*)`, 'i');
    const table = {};
    for (const grid of parseRawTables(html).map(toGrid)) {
        parseRowLayout(grid, idRe, table);
        parseColumnLayout(grid, idRe, table);
    }
    return table;
}
/** 浏览器 UA：部分站点拒绝或非正常响应非浏览器客户端。 */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/**
 * 百度文心（千帆）定价。cloud.baidu.com 对非浏览器客户端重置 TLS，
 * 但同一文档的 Gatsby CDN 镜像在 page-data JSON 信封中提供渲染后的
 * markdown HTML。表格形如 [模型名称, 版本名称, 服务内容, 子项, 在线推理, 批量推理, 单位]，
 * 行如 [ERNIE 5.1, ERNIE-5.1, 推理服务, 输入（输入<=32k）, 0.004, -, 元/千tokens]。
 * 阶梯行按最低档在前；每模型每类型取首个档位。
 */
export function parseErnieSheet(html) {
    const table = {};
    for (const grid of parseRawTables(html).map(toGrid)) {
        const header = grid[0];
        if (header === undefined)
            continue;
        const find = (re) => header.findIndex((text) => re.test(text));
        const modelCol = find(/版本名称/);
        const kindCol = find(/子项/);
        const priceCol = find(/在线推理/);
        const unitCol = find(/单位/);
        if (modelCol < 0 || kindCol < 0 || priceCol < 0)
            continue;
        for (const row of grid.slice(1)) {
            const unit = unitCol >= 0 ? (row[unitCol] ?? '') : '';
            if (!/tokens/i.test(unit))
                continue; // 跳过 按图/按秒/GB 行
            const scale = /千/.test(unit) ? 1000 : 1;
            const kindText = row[kindCol] ?? '';
            let kind;
            // 官方表格中缓存价写作"缓存命中"或"命中缓存"两种词序，都要识别。
            if (kindText.includes('缓存命中') || kindText.includes('命中缓存'))
                kind = 'inputCacheHit';
            else if (kindText.includes('输出'))
                kind = 'output';
            else if (kindText.includes('输入'))
                kind = 'inputMiss';
            if (kind === undefined)
                continue;
            const value = parsePriceCell(row[priceCol] ?? '');
            if (value === undefined)
                continue;
            // 一行可能列出多个共享同一价格的版本名。
            for (const rawId of (row[modelCol] ?? '').split(/\s+/)) {
                const model = rawId.trim().toLowerCase();
                if (!/^ernie[\w.-]*$/.test(model))
                    continue;
                const existing = table[model] ?? { inputCacheHit: 0, inputMiss: 0, output: 0 };
                if (existing[kind] === 0)
                    existing[kind] = value * scale;
                table[model] = existing;
            }
        }
    }
    return table;
}
/**
 * 智谱 GLM 现役旗舰定价。open.bigmodel.cn/pricing 是 Vue SPA 空壳（3.7KB，无数据），
 * 实时价格内嵌于其 app.*.js i18n 包中，形如
 * `newModel:{...modelList:[{name:"GLM-5.2",...,inPrice:["8元"],outPrice:["28元"],hit:["2元"]}]}`。
 * 阶梯模型重复为 name:"" 条目；只读具名行，故首个（最低）档位生效。"免费"条目记 0。
 */
export function parseZhipuBundleSheet(js) {
    const table = {};
    const start = js.indexOf('newModel:{');
    if (start < 0)
        return table;
    const region = js.slice(start, start + 200_000);
    const entryRe = /\{name:"([^"]*)"[^{}]*?inPrice:\["(?:(\d+(?:\.\d+)?)元|免费)"\][^{}]*?outPrice:\["(?:(\d+(?:\.\d+)?)元|免费)"\][^{}]*?\}/g;
    let match;
    while ((match = entryRe.exec(region)) !== null) {
        const model = (match[1] ?? '').trim().toLowerCase();
        if (!/^glm[\w.-]*$/.test(model))
            continue;
        if (table[model] !== undefined)
            continue; // 保留首个（最低）档位
        const hitMatch = match[0].match(/hit:\["(?:(\d+(?:\.\d+)?)元|免费)"\]/);
        table[model] = {
            inputCacheHit: Number(hitMatch?.[1] ?? 0),
            inputMiss: Number(match[2] ?? 0),
            output: Number(match[3] ?? 0),
        };
    }
    return table;
}
/**
 * 智谱旧模型（GLM-4 代及更早）来自公开的 /api/biz/operation/query 接口（无鉴权）。
 * 运营位 1122/1123 携带字符串化 JSON `content`，fieldList 将随机行键码映射到列标签。
 * 单价为按 token 计的单一费率，输入输出同价；只接受"元 / 百万Tokens"/"免费"单元格，
 * 以排除按图/按次等类目。
 */
export function parseZhipuLegacySheet(jsonText) {
    const table = {};
    let slots = [];
    try {
        slots = JSON.parse(jsonText).data ?? [];
    }
    catch {
        return table;
    }
    for (const slot of slots) {
        if (slot.operationId !== '1122' && slot.operationId !== '1123')
            continue;
        let content;
        try {
            content = JSON.parse(slot.content ?? '{}');
        }
        catch {
            continue;
        }
        for (const cat of content.list ?? []) {
            const fields = cat.fieldList ?? [];
            const modelCode = fields.find((f) => (f.label ?? '').includes('模型'))?.code;
            const priceCode = fields.find((f) => (f.label ?? '').includes('单价'))?.code;
            if (modelCode === undefined || priceCode === undefined)
                continue;
            for (const row of cat.modelList ?? []) {
                const model = (row[modelCode] ?? '').trim().toLowerCase();
                if (!/^glm[\w.-]*$/.test(model))
                    continue;
                const cell = row[priceCode] ?? '';
                if (!/免费|百万\s*tokens/i.test(cell))
                    continue; // 跳过 元/张、元/万字符 等
                const value = parsePriceCell(cell);
                if (value === undefined || table[model] !== undefined)
                    continue;
                // "输入：16元/百万 tokens…；输出：不计费" 类单元格输出记 0。
                const output = /输出[：:]\s*不计费/.test(cell) ? 0 : value;
                table[model] = { inputCacheHit: 0, inputMiss: value, output };
            }
        }
    }
    return table;
}
/**
 * 字节豆包（火山方舟）定价。文档页为客户端渲染 Quill 富文本，
 * 但文档中心接口以服务端 Markdown（Result.MDContent）提供同一内容。
 * 文本模型表位于 `# 大语言模型` H1 之下，视频/图像模型（doubao-seedance-*）
 * 位于其他 H1 之下，故章节过滤即可可靠排除。合并阶梯行的模型单元格为空
 * （更高档位）会被跳过——最低档生效。
 */
export function parseDoubaoSheet(markdown) {
    const table = {};
    const clean = (t) => t.replace(/<br\s*\/?>/gi, ' ').replace(/\\/g, '').replace(/\s+/g, ' ').trim();
    const splitRow = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean);
    let inLlmSection = false;
    const lines = markdown.split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        const h1 = line.match(/^#\s+([^#].*)$/);
        if (h1 !== null) {
            inLlmSection = (h1[1] ?? '').includes('大语言模型');
            i += 1;
            continue;
        }
        if (!inLlmSection || !line.startsWith('|')) {
            i += 1;
            continue;
        }
        const block = [];
        while (i < lines.length && (lines[i] ?? '').startsWith('|')) {
            block.push(lines[i] ?? '');
            i += 1;
        }
        const header = splitRow(block[0] ?? '');
        const modelCol = header.findIndex((h) => /模型名称|^模型$/.test(h));
        const inputCol = header.findIndex((h) => h.includes('输入') && h.includes('非音频'));
        const outputCol = header.findIndex((h) => h.includes('输出') && !h.includes('输入'));
        const hitCol = header.findIndex((h) => h.includes('缓存命中') && h.includes('非音频'));
        if (modelCol < 0 || inputCol < 0 || outputCol < 0)
            continue;
        for (const rowText of block.slice(2)) {
            // 跳过表头 + 分隔行
            const row = splitRow(rowText);
            const model = (row[modelCol] ?? '').toLowerCase();
            // 空单元格 = 前一模型的延续档位；seedance 为视频系列（章节过滤已排除，双重保险）。
            if (!model.startsWith('doubao') || model.includes('seedance'))
                continue;
            if (table[model] !== undefined)
                continue;
            const inputMiss = parsePriceCell(row[inputCol] ?? '');
            const output = parsePriceCell(row[outputCol] ?? '');
            if (inputMiss === undefined || output === undefined)
                continue;
            const hit = hitCol >= 0 ? parsePriceCell(row[hitCol] ?? '') : undefined;
            table[model] = { inputCacheHit: hit ?? 0, inputMiss, output };
        }
    }
    return table;
}
/**
 * Kimi 定价。文档站为客户端渲染 Next.js，价格表位于 RSC flight payload 中，形如
 * `columns:[{title:`输入价格（缓存命中）`...}],rows:[[`kimi-k2.6`,`1M tokens`,`¥1.10`,...]]`。
 * 列语义来自标题，故列的增删可自适应。
 */
export function parseKimiSheet(rscText) {
    const table = {};
    const blockRe = /columns:\[([\s\S]*?)\],rows:\[\[([\s\S]*?)\]\]/g;
    let match;
    while ((match = blockRe.exec(rscText)) !== null) {
        const titles = [...(match[1] ?? '').matchAll(/title:`([^`]*)`/g)].map((m) => m[1] ?? '');
        const kindByCol = new Map();
        titles.forEach((title, col) => {
            if (title.includes('缓存命中'))
                kindByCol.set(col, 'inputCacheHit');
            else if (title.includes('缓存未命中') || (title.includes('输入') && !title.includes('缓存'))) {
                kindByCol.set(col, 'inputMiss');
            }
            else if (title.includes('输出'))
                kindByCol.set(col, 'output');
        });
        const kinds = [...kindByCol.values()];
        if (!kinds.includes('inputMiss') || !kinds.includes('output'))
            continue;
        for (const rowText of (match[2] ?? '').split('],[')) {
            const cells = [...rowText.matchAll(/`([^`]*)`/g)].map((m) => m[1] ?? '');
            const model = (cells[0] ?? '').trim().toLowerCase();
            if (!/^(kimi|moonshot)[\w.-]*$/.test(model))
                continue;
            const price = { inputCacheHit: 0, inputMiss: 0, output: 0 };
            let priced = false;
            for (const [col, kind] of kindByCol) {
                const value = parsePriceCell(cells[col] ?? '');
                if (value !== undefined) {
                    price[kind] = value;
                    priced = true;
                }
            }
            if (priced && (price.inputMiss > 0 || price.output > 0))
                table[model] = price;
        }
    }
    return table;
}
