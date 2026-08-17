import { Config } from './config.js';
import { CompanionCoreService } from './core/service.js';
import * as exportModule from './modules/export/index.js';
import * as handoffModule from './modules/handoff/index.js';
import * as costModule from './modules/cost/index.js';
import * as searchModule from './modules/search/index.js';
export const name = 'deepseek-companion';
export { Config };
export function apply(ctx, config) {
    ctx.plugin(CompanionCoreService, config);
    if (config.enableExport) {
        ctx.plugin(exportModule);
    }
    if (config.enableHandoff) {
        ctx.plugin(handoffModule);
    }
    if (config.enableCost) {
        ctx.plugin(costModule);
    }
    if (config.enableSearch) {
        ctx.plugin(searchModule);
    }
}
