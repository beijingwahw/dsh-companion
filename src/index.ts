/**
 * DeepSeek Companion — DeepSeek Harness 官方伴侣插件（宿主入口）。
 *
 * 一切皆插件：本入口只做两件事——
 * 1. 挂载 CompanionCore 根服务（存储域 / 保险库 / 记账 / HTTP 路由）；
 * 2. 按配置分别挂载十个功能模块（A 导出 / B 交接摘要 / C 成本优化 / D 检索 /
 *    E 轨迹分析 / F Prompt 工作台 / G 多模型竞技场 / H 任务编排 / I 协作与知识管理 /
 *    J 安全审计），每个模块是独立子插件，可单独启停、互不影响。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import type { Config as ConfigShape } from './config.js'
import { CompanionCoreService } from './core/service.js'
import * as exportModule from './modules/export/index.js'
import * as handoffModule from './modules/handoff/index.js'
import * as costModule from './modules/cost/index.js'
import * as searchModule from './modules/search/index.js'
import * as traceModule from './modules/trace/index.js'
import * as promptModule from './modules/prompt/index.js'
import * as arenaModule from './modules/arena/index.js'
import * as orchestratorModule from './modules/orchestrator/index.js'
import * as teamModule from './modules/team/index.js'
import * as securityModule from './modules/security/index.js'

export const name = 'deepseek-companion'

export { Config }
export type { ConfigShape }

export function apply(ctx: Context, config: ConfigShape): void {
  ctx.plugin(CompanionCoreService, config)

  if (config.enableExport) {
    ctx.plugin(exportModule)
  }
  if (config.enableHandoff) {
    ctx.plugin(handoffModule)
  }
  if (config.enableCost) {
    ctx.plugin(costModule)
  }
  if (config.enableSearch) {
    ctx.plugin(searchModule)
  }
  if (config.enableTrace) {
    ctx.plugin(traceModule)
  }
  if (config.enablePrompt) {
    ctx.plugin(promptModule)
  }
  if (config.enableArena) {
    ctx.plugin(arenaModule)
  }
  if (config.enableOrchestrator) {
    ctx.plugin(orchestratorModule)
  }
  if (config.enableTeam) {
    ctx.plugin(teamModule)
  }
  if (config.enableSecurity) {
    ctx.plugin(securityModule)
  }
}
