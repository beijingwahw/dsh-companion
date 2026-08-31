/**
 * 交接摘要提示词模板。
 *
 * 模板文本是固定契约（措辞不得改动）；占位符 `{conversation_content}`
 * 由会话转录文本（建议不带时间戳）替换后，作为 user 消息发送给模型。
 */
/** 交接摘要提示词模板（契约原文，`{conversation_content}` 为对话内容占位符）。 */
export declare const HANDOFF_PROMPT_TEMPLATE = "\u8BF7\u6839\u636E\u4EE5\u4E0B\u5BF9\u8BDD\u5185\u5BB9\uFF0C\u751F\u6210\u4E00\u4EFD\u2264500\u5B57\u7684\u4EA4\u63A5\u6458\u8981\uFF0C\u5305\u542B\u4EE5\u4E0B\u56DB\u4E2A\u90E8\u5206\uFF1A\n1. \u6838\u5FC3\u7ED3\u8BBA\uFF08\u5DF2\u786E\u5B9A\u7684\u5173\u952E\u4FE1\u606F\uFF09\n2. \u5DF2\u89E3\u51B3\u7684\u95EE\u9898\n3. \u5173\u952E\u80CC\u666F\u4FE1\u606F\n4. \u5F85\u529E\u4E8B\u9879/\u672A\u89E3\u51B3\u95EE\u9898\n\n\u5BF9\u8BDD\u5185\u5BB9\uFF1A\n{conversation_content}";
/**
 * 构造发送给模型的完整提示词。
 * @param conversationContent 格式化后的对话转录文本。
 * @returns 占位符被对话内容替换后的提示词（函数式替换，避免 `$` 序列被解释）。
 */
export declare function buildHandoffPrompt(conversationContent: string): string;
/**
 * 用自定义模板构造提示词（POST /handoff/generate 的 template 字段）。
 * 模板含 `{conversation_content}` 占位符时以对话内容替换（函数式替换）；
 * 否则将模板整体作为指令文本，在其后以“对话内容”段追加对话内容。
 * @param template 用户自定义的摘要模板正文。
 * @param conversationContent 格式化后的对话转录文本。
 */
export declare function buildHandoffPromptWithTemplate(template: string, conversationContent: string): string;
/**
 * 构造带查询聚焦的完整提示词（轴线 2：单发路径的 focus 支持）。
 * @param conversationContent 格式化后的对话转录文本。
 * @param focus 可选的聚焦重点（保留与该主题相关的内容）。
 */
export declare function buildHandoffPromptWithFocus(conversationContent: string, focus: string | undefined): string;
/**
 * 构造 map 阶段提示词（轴线 2：超长对话分块抽取式摘要）。
 * 每块生成 ≤200 字要点摘要，供 reduce 阶段合并。
 * @param chunkContent 分块后的对话片段文本。
 * @param positionHint 位置提示（如「第 2/7 段（约 25% 处）」）。
 * @param focus 可选的聚焦重点。
 */
export declare function buildMapPrompt(chunkContent: string, positionHint: string, focus: string | undefined): string;
/**
 * 构造 reduce 阶段提示词（轴线 2：合并各块要点为最终交接摘要）。
 * @param chunkSummaries 各块要点摘要（已按顺序编号拼接）。
 * @param focus 可选的聚焦重点。
 * @param templateInstruction 可选的自定义摘要指令（替代固定四段契约）。
 */
export declare function buildReducePrompt(chunkSummaries: string, focus: string | undefined, templateInstruction?: string): string;
