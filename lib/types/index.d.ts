import type { OrchestratorState } from './handoff.js';
import type { CtxLike } from './types.js';
/** 稳定插件名（与 package.json 的 name 一致；cordis.patch.yml 的 name 也必须一致）。 */
export declare const name = "dsh-infinite-context-orchestrator";
/** 必需的宿主服务：注册工具与提示词段。其余服务（sessionController/tokenMeter/…）走可选获取。 */
export declare const inject: string[];
export { Config } from './config.js';
/** 仅给离线冒烟测试用（不是插件 API）。 */
export { withTimeout as __testingWithTimeout } from './timeout.js';
export declare function apply(ctx: CtxLike, rawConfig?: unknown): void;
/** 供测试/诊断：把当前状态快照成纯 JSON。 */
export declare function snapshotState(state: OrchestratorState): Record<string, unknown>;
