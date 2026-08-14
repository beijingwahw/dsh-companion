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
