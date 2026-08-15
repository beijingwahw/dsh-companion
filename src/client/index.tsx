/**
 * DeepSeek Companion —— 浏览器侧客户端插件入口。
 *
 * 官方 slots 纪律（DESIGN.md 第 6 节）：UI 只经 slots 组合——
 * `ctx.slots.inject(slotName, contribute)` 等待目标 slot 声明出现后再贡献，
 * `ctx.slots.register(...)` 返回 disposer；本入口将其交给 ctx.effect 生命周期管理，
 * 插件卸载时自动回卷。贡献点：
 * - conversation.session.header.actions：导出对话（order 10）、交接摘要（order 11）、
 *   对话内搜索（order 12，能力吸收自 dsh-conv-search：Ctrl+F 浮动查找栏 +
 *   CSS Custom Highlight API 高亮，流式输出期间自动重同步）；
 * - conversation.input.dock：上下文交接 dock 行（order 90）；
 * - conversation.view：全局检索视图页（order 50）、成本报表视图页（order 51）。
 */
import { Component, createElement, useState } from 'react'
import type { ComponentType, ErrorInfo, ReactElement, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime'
import { ExportDialog } from './components/ExportDialog.js'
import { HandoffDialog } from './components/HandoffDialog.js'
import { ImportSummaryDock } from './components/ImportSummaryDock.js'
import { SearchView } from './components/SearchView.js'
import { CostReportView } from './components/CostReportView.js'
import { convSearchController } from './convsearch/controller.js'

/** 客户端插件名。 */
export const name = 'deepseek-companion-client'

/** 客户端 Cordis 上下文仅依赖 slots 服务。 */
export const inject = ['slots']

/** 主平台声明的 slot 名常量（声明消失时贡献自动撤回）。 */
const SLOT_HEADER_ACTIONS = 'conversation.session.header.actions'
const SLOT_INPUT_DOCK = 'conversation.input.dock'
const SLOT_VIEW = 'conversation.view'

/** 头部按钮的注入 props。 */
interface HeaderButtonProps {
  readonly sessionId?: string
}

/** SlotErrorBoundary 的 props。 */
interface SlotErrorBoundaryProps {
  /** 被包裹组件的名称：用于降级文案与错误日志。 */
  readonly name: string
  readonly children?: ReactNode
}

/** SlotErrorBoundary 的 state。 */
interface SlotErrorBoundaryState {
  readonly hasError: boolean
}

/**
 * 轻量错误边界：捕获子组件渲染期错误并渲染降级文案，
 * 避免单个插件组件的渲染异常波及宿主 slot（进而影响整个宿主界面）。
 */
class SlotErrorBoundary extends Component<SlotErrorBoundaryProps, SlotErrorBoundaryState> {
  state: SlotErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): SlotErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[deepseek-companion] 「${this.props.name}」组件渲染失败`, error, info)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <span role="alert">{`「${this.props.name}」组件渲染失败`}</span>
    }
    return this.props.children
  }
}

/** 用错误边界统一包裹注册进 slot 的组件（props 泛型透传，对 slot 系统透明）。 */
function withErrorBoundary<P extends object>(name: string, component: ComponentType<P>): ComponentType<P> {
  return function GuardedSlotComponent(props: P): ReactElement {
    return <SlotErrorBoundary name={name}>{createElement(component, props)}</SlotErrorBoundary>
  }
}

/** “导出对话”头部按钮：自行管理 ExportDialog 的 open 状态。 */
function HeaderExportButton(props: HeaderButtonProps): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" size="sm" title="导出当前对话" onClick={() => setOpen(true)}>
        导出对话
      </Button>
      <ExportDialog sessionId={props.sessionId} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/** “交接摘要”头部按钮：自行管理 HandoffDialog 的 open 状态。 */
function HeaderHandoffButton(props: HeaderButtonProps): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" size="sm" title="生成并交接当前会话摘要" onClick={() => setOpen(true)}>
        交接摘要
      </Button>
      <HandoffDialog sessionId={props.sessionId} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/**
 * “对话内搜索”头部按钮：切换浮动查找栏（Ctrl+F 亦可）。
 * 外层 span 携带 data-companion-search-action，供控制器以纯 DOM 旁路
 * 镜像 aria-pressed 打开态（React 按钮不为此重渲染）。
 */
function HeaderSearchButton(_props: HeaderButtonProps): ReactElement {
  return (
    <span data-companion-search-action="">
      <Button
        variant="secondary"
        size="sm"
        title="在当前对话中查找（Ctrl+F）"
        onClick={() => convSearchController.toggle()}
      >
        对话内搜索
      </Button>
    </span>
  )
}

/**
 * 客户端插件 apply：按 slots 纪律注册全部 UI 贡献。
 * 组件经 `inject: (sessionId) => ({ sessionId })` 注入当前会话 id；
 * 每个组件统一经 withErrorBoundary 包裹，单个组件渲染错误只降级自身，不波及宿主。
 */
export function apply(ctx: ClientContext): void {
  // 会话头部操作区：导出（order 10）+ 交接摘要（order 11）
  ctx.effect(
    () =>
      ctx.slots.inject(SLOT_HEADER_ACTIONS, () => {
        const disposeExport = ctx.slots.register(
          {
            name: SLOT_HEADER_ACTIONS,
            id: 'companion-export',
            order: 10,
            inject: (sessionId) => ({ sessionId }),
          },
          withErrorBoundary('导出对话', HeaderExportButton),
        )
        const disposeHandoff = ctx.slots.register(
          {
            name: SLOT_HEADER_ACTIONS,
            id: 'companion-handoff',
            order: 11,
            inject: (sessionId) => ({ sessionId }),
          },
          withErrorBoundary('交接摘要', HeaderHandoffButton),
        )
        const disposeSearch = ctx.slots.register(
          {
            name: SLOT_HEADER_ACTIONS,
            id: 'companion-conv-search',
            order: 12,
            inject: (sessionId) => ({ sessionId }),
          },
          withErrorBoundary('对话内搜索', HeaderSearchButton),
        )
        return () => {
          disposeExport()
          disposeHandoff()
          disposeSearch()
        }
      }),
    'companion-client/header-actions',
  )

  // 对话内搜索控制器：document 级按键捕获（Ctrl+F/Esc/F3）+ 浮动搜索栏，
  // 随插件生命周期安装/卸载（卸载时清除全部高亮绘制）。
  ctx.effect(() => {
    convSearchController.install()
    return () => convSearchController.uninstall()
  }, 'companion-client/conv-search')

  // 输入区 dock：导入历史摘要入口（order 90）
  ctx.effect(
    () =>
      ctx.slots.inject(
        SLOT_INPUT_DOCK,
        () =>
          ctx.slots.register(
            {
              name: SLOT_INPUT_DOCK,
              id: 'companion-import-summary',
              order: 90,
              inject: (sessionId) => ({ sessionId }),
            },
            withErrorBoundary('上下文交接', ImportSummaryDock),
          ),
      ),
    'companion-client/input-dock',
  )

  // 视图页：全局检索（order 50）+ 成本报表（order 51）
  ctx.effect(
    () =>
      ctx.slots.inject(SLOT_VIEW, () => {
        const disposeSearch = ctx.slots.register(
          {
            name: SLOT_VIEW,
            id: 'companion-search',
            order: 50,
            inject: (sessionId) => ({ sessionId }),
          },
          withErrorBoundary('全局检索', SearchView),
        )
        const disposeCost = ctx.slots.register(
          {
            name: SLOT_VIEW,
            id: 'companion-cost-report',
            order: 51,
            inject: (sessionId) => ({ sessionId }),
          },
          withErrorBoundary('成本报表', CostReportView),
        )
        return () => {
          disposeSearch()
          disposeCost()
        }
      }),
    'companion-client/views',
  )
}
