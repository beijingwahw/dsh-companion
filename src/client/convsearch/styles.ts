/**
 * 对话内搜索样式注入（能力吸收自 dsh-conv-search）：浮动搜索栏外观 +
 * CSS Custom Highlight API 的两条 ::highlight() 绘制规则。以稳定 id 注入
 * document.head，插件重复加载不会重复注入。
 */

/** 注入 <style> 元素的稳定 id。 */
const STYLE_ID = 'companion-conv-search-style'

/**
 * 完整样式表：跟随宿主 --dsw-alias-* 设计令牌（缺令牌时用纯色兜底）。
 * ::highlight() 规则只认 color/background，保持简单。
 */
const STYLE_TEXT = `
/* ---- 高亮绘制（CSS Custom Highlight API） ---- */
::highlight(companion-conv-search) {
  background-color: rgba(250, 204, 21, .42);
  color: inherit;
}
::highlight(companion-conv-search-active) {
  background-color: #f59e0b;
  color: #111827;
}

/* ---- 浮动搜索栏 ---- */
[data-companion-search-bar] {
  position: fixed;
  top: 64px;
  right: 24px;
  z-index: 1200;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--dsw-alias-bg-base, #fff);
  border: 1px solid var(--dsw-alias-line-border, rgba(127, 127, 127, .22));
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .18);
  color: var(--dsw-alias-label-primary, #111827);
  max-width: calc(100vw - 48px);
}
/* hidden 属性的 UA display:none 会被上面的规则覆盖——显式重申，
 * 保证 close() 真的隐藏搜索栏。 */
[data-companion-search-bar][hidden] {
  display: none;
}
[data-companion-search-bar] input {
  appearance: none;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  min-width: 200px;
  max-width: 320px;
  padding: 4px 2px;
}
[data-companion-search-bar] input::placeholder {
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, .7));
}
[data-companion-search-count] {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, rgba(127, 127, 127, .9));
  min-width: 56px;
  text-align: center;
  white-space: nowrap;
  user-select: none;
}
[data-companion-search-bar] button {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, currentColor);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  padding: 0;
  flex: none;
}
[data-companion-search-bar] button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-secondary, currentColor);
}
[data-companion-search-bar] button:disabled {
  cursor: default;
  opacity: .38;
}

/* ---- 匹配选项开关（Aa / ab） ---- */
[data-companion-search-bar] button[data-companion-search-toggle] {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: -.02em;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary, currentColor);
}
[data-companion-search-bar] button[data-companion-search-toggle][aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .16));
  color: var(--dsw-alias-label-primary, currentColor);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-line-border, rgba(127, 127, 127, .3));
}

/* ---- 无结果提示：红色计数 + 一次性抖动 ---- */
[data-companion-search-bar][data-no-result] {
  border-color: rgba(220, 38, 38, .55);
}
[data-companion-search-bar][data-no-result] [data-companion-search-count] {
  color: #dc2626;
}
[data-companion-search-bar].companion-search-shake {
  animation: companion-search-shake .3s ease-in-out;
}
@keyframes companion-search-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-5px); }
  75% { transform: translateX(5px); }
}
@media (prefers-reduced-motion: reduce) {
  [data-companion-search-bar].companion-search-shake { animation: none; }
}

/* ---- 窄视口：搜索栏贴顶全宽 ---- */
@media (max-width: 640px) {
  [data-companion-search-bar] {
    top: 8px;
    left: 8px;
    right: 8px;
    max-width: none;
  }
  [data-companion-search-bar] input {
    flex: 1;
    min-width: 0;
    max-width: none;
  }
}
`

/** 注入样式表（幂等，可从多个挂载路径安全调用）。 */
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.appendChild(style)
}
