/**
 * DeepSeek Harness Web 客户端契约适配层。
 *
 * 按官方文档与源码约定声明浏览器侧依赖：
 * - slots 系统：packages/client/AGENTS.md —— UI 只通过
 *   `ctx.slots.register(...)` / `ctx.slots.inject(...)` 组合；
 * - ui-primitives：官方共享 React 组件库（Button/Input/Modal/Toast 等）；
 * - client-runtime：客户端 Cordis 上下文（ClientContext）。
 *
 * 样式约定（docs/web-styling.md）：CSS Modules + `--dsw-alias-*` 语义令牌，
 * 不引入第三方组件库或 Tailwind。
 *
 * 本文件必须是全局脚本（无顶层 import/export），才能作为环境模块声明。
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  type ReactNode = import('react').ReactNode
  type ComponentType<P> = import('react').ComponentType<P>

  export interface ButtonProps {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md'
    disabled?: boolean
    title?: string
    className?: string
    onClick?: () => void
    children?: ReactNode
  }
  export const Button: ComponentType<ButtonProps>

  export interface InputProps {
    value?: string
    defaultValue?: string
    placeholder?: string
    type?: 'text' | 'password' | 'number' | 'date' | 'search'
    disabled?: boolean
    className?: string
    onChange?: (event: { target: { value: string } }) => void
    onKeyDown?: (event: { key: string }) => void
  }
  export const Input: ComponentType<InputProps>

  export interface TextareaProps {
    value?: string
    defaultValue?: string
    placeholder?: string
    rows?: number
    disabled?: boolean
    className?: string
    onChange?: (event: { target: { value: string } }) => void
  }
  export const Textarea: ComponentType<TextareaProps>

  export interface SelectProps {
    value?: string
    defaultValue?: string
    disabled?: boolean
    className?: string
    onChange?: (event: { target: { value: string } }) => void
    children?: ReactNode
  }
  export const Select: ComponentType<SelectProps>

  export interface CheckboxProps {
    checked?: boolean
    defaultChecked?: boolean
    disabled?: boolean
    label?: ReactNode
    onChange?: (checked: boolean) => void
  }
  export const Checkbox: ComponentType<CheckboxProps>

  export interface ModalProps {
    open: boolean
    title?: ReactNode
    onClose?: () => void
    footer?: ReactNode
    children?: ReactNode
  }
  export const Modal: ComponentType<ModalProps>

  export interface PillProps {
    children?: ReactNode
    className?: string
    onClick?: () => void
  }
  export const Pill: ComponentType<PillProps>

  export interface SpinnerProps {
    label?: ReactNode
  }
  export const Spinner: ComponentType<SpinnerProps>

  /** 全局轻提示。 */
  export const Toast: {
    push(message: string, kind?: 'info' | 'success' | 'warning' | 'error'): void
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  type ComponentType<P> = import('react').ComponentType<P>

  /** register() 的声明参数；name 与 slot 声明一致，inject 向组件注入 props。
   *
   * 泛型 P 为注入的 props 类型，须与注册组件的 props 类型一致。
   */
  export interface SlotRegistration<P = unknown> {
    name: string
    id?: string
    key?: string
    order?: number
    locale?: string
    inject?: (sessionId: string) => P
    store?: unknown
    children?: unknown
  }

  export interface SlotRuntime {
    /** 注册组件到 slot：泛型 P 为组件 props 类型，与 registration.inject 的返回类型联动。 */
    register<P>(registration: SlotRegistration<P>, component: ComponentType<P>): () => void
    /** 等待目标 slot 声明出现后再贡献；声明消失时自动撤回。 */
    inject(name: string, contribute: () => (() => void) | void): () => void
  }
}

declare module '@deepseek-ai/dsh-client-locale' {
  export interface LocaleRuntime {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void
    t(key: string, fallback?: string): string
  }
}

declare module '@deepseek-ai/dsh-client-runtime' {
  import type { SlotRuntime } from '@deepseek-ai/dsh-client-ui-slots'
  import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale'

  /** 浏览器侧 Cordis 上下文：服务仓库 + effect 生命周期。
   *
   * 注：不再声明 `[key: string]: unknown` 索引签名——客户端代码只使用
   * slots/locale/effect 等具名成员，移除索引签名可获得更严格的类型检查
   * （已验证现有代码 typecheck 通过）。
   */
  export interface ClientContext {
    slots: SlotRuntime
    locale: LocaleRuntime
    effect(execute: () => unknown, label?: string): () => void
    on(name: string, listener: (...args: unknown[]) => void): () => boolean
    plugin(plugin: unknown, config?: unknown): unknown
    inject(deps: readonly string[], callback: (scope: ClientContext) => void): unknown
  }
}
