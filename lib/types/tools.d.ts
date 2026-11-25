import { type OrchestratorState } from './handoff.js';
import type { OrchestratorConfig } from './config.js';
import type { CtxLike, ToolDefinitionShape } from './types.js';
export interface ToolDeps {
    ctx: CtxLike;
    config: OrchestratorConfig;
    state: OrchestratorState;
    root: string;
}
export declare function createTools(deps: ToolDeps): Array<ToolDefinitionShape<any, any>>;
