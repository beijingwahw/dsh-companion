/**
 * CSS Modules 环境声明（docs/web-styling.md：组件样式用 CSS Modules 并置）。
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
