/**
 * 交接摘要提示词模板。
 *
 * 模板文本是固定契约（措辞不得改动）；占位符 `{conversation_content}`
 * 由会话转录文本（建议不带时间戳）替换后，作为 user 消息发送给模型。
 */

/** 模板中的对话内容占位符。 */
const CONVERSATION_PLACEHOLDER = '{conversation_content}'

/** 交接摘要提示词模板（契约原文，`{conversation_content}` 为对话内容占位符）。 */
export const HANDOFF_PROMPT_TEMPLATE = `请根据以下对话内容，生成一份≤500字的交接摘要，包含以下四个部分：
1. 核心结论（已确定的关键信息）
2. 已解决的问题
3. 关键背景信息
4. 待办事项/未解决问题

对话内容：
{conversation_content}`

/**
 * 构造发送给模型的完整提示词。
 * @param conversationContent 格式化后的对话转录文本。
 * @returns 占位符被对话内容替换后的提示词（函数式替换，避免 `$` 序列被解释）。
 */
export function buildHandoffPrompt(conversationContent: string): string {
  return HANDOFF_PROMPT_TEMPLATE.replace(CONVERSATION_PLACEHOLDER, () => conversationContent)
}

/**
 * 用自定义模板构造提示词（POST /handoff/generate 的 template 字段）。
 * 模板含 `{conversation_content}` 占位符时以对话内容替换（函数式替换）；
 * 否则将模板整体作为指令文本，在其后以“对话内容”段追加对话内容。
 * @param template 用户自定义的摘要模板正文。
 * @param conversationContent 格式化后的对话转录文本。
 */
export function buildHandoffPromptWithTemplate(
  template: string,
  conversationContent: string,
): string {
  if (template.includes(CONVERSATION_PLACEHOLDER)) {
    return template.replace(CONVERSATION_PLACEHOLDER, () => conversationContent)
  }
  return `${template.trimEnd()}\n\n对话内容：\n${conversationContent}`
}

/** 查询聚焦指令（focus 非空时注入 map/reduce/单发提示词）。 */
function focusDirective(focus: string | undefined): string {
  const trimmed = focus?.trim()
  if (!trimmed) return ''
  return `用户特别关注：「${trimmed}」，请优先保留与之相关的信息。`
}

/**
 * 构造带查询聚焦的完整提示词（轴线 2：单发路径的 focus 支持）。
 * @param conversationContent 格式化后的对话转录文本。
 * @param focus 可选的聚焦重点（保留与该主题相关的内容）。
 */
export function buildHandoffPromptWithFocus(
  conversationContent: string,
  focus: string | undefined,
): string {
  const base = buildHandoffPrompt(conversationContent)
  const directive = focusDirective(focus)
  if (!directive) return base
  // 聚焦指令插在契约指令之后、对话内容之前。
  const marker = '\n对话内容：\n'
  const index = base.lastIndexOf(marker)
  if (index < 0) return base
  return `${base.slice(0, index)}\n${directive}${base.slice(index)}`
}

/**
 * 构造 map 阶段提示词（轴线 2：超长对话分块抽取式摘要）。
 * 每块生成 ≤200 字要点摘要，供 reduce 阶段合并。
 * @param chunkContent 分块后的对话片段文本。
 * @param positionHint 位置提示（如「第 2/7 段（约 25% 处）」）。
 * @param focus 可选的聚焦重点。
 */
export function buildMapPrompt(
  chunkContent: string,
  positionHint: string,
  focus: string | undefined,
): string {
  return [
    `以下是一段超长对话的片段（${positionHint}）。请生成该片段的要点摘要（≤200字），保留：`,
    '1. 核心结论与关键决策',
    '2. 已解决的问题',
    '3. 关键背景信息',
    '4. 待办事项/未解决问题',
    focusDirective(focus),
    `对话片段：`,
    chunkContent,
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * 构造 reduce 阶段提示词（轴线 2：合并各块要点为最终交接摘要）。
 * @param chunkSummaries 各块要点摘要（已按顺序编号拼接）。
 * @param focus 可选的聚焦重点。
 * @param templateInstruction 可选的自定义摘要指令（替代固定四段契约）。
 */
export function buildReducePrompt(
  chunkSummaries: string,
  focus: string | undefined,
  templateInstruction?: string,
): string {
  const instruction =
    templateInstruction !== undefined && templateInstruction.trim().length > 0
      ? templateInstruction.trim()
      : [
          '请根据以下超长对话各片段的要点摘要，生成一份≤500字的交接摘要，包含以下四个部分：',
          '1. 核心结论（已确定的关键信息）',
          '2. 已解决的问题',
          '3. 关键背景信息',
          '4. 待办事项/未解决问题',
        ].join('\n')
  return [
    instruction,
    focusDirective(focus),
    '各片段要点摘要（按对话出现顺序）：',
    chunkSummaries,
  ]
    .filter((section) => section.trim().length > 0)
    .join('\n')
}
