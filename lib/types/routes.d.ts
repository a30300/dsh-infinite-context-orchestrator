/**
 * Host 侧的设置 HTTP 面（给本插件的设置页读写配置）。
 *
 * 为什么不用 `ctx.configForms`：本机这版 DSH 的客户端服务目录里**没有** configForms
 * （只有 layout/locale/sessions/slots/theme/timer/uiWorkspace/workspaces），沙箱插件的
 * 设置页也因此没注册上。用自建 exact 路由 + 同源 fetch 是这套环境里**已验证**的路径
 * （dsh-context-relay 的客户端就是这么读写的）。
 *
 * 认证走连接层 `connection.requestRejection`：未认证一律 401（fail-closed）。
 * 写回走 `configEditor`：宿主自己的「校验 → 持久化 → reconcile」路径，原子且会触发
 * 插件重载；绝不自己改 YAML。
 */
import type { OrchestratorConfig } from './config.js';
import type { OrchestratorState } from './handoff.js';
import type { CtxLike } from './types.js';
export declare const SETTINGS_ROUTE = "/infinite-context/settings";
export declare function isSettingsRouteMounted(): boolean;
export interface RouteDeps {
    ctx: CtxLike;
    config: OrchestratorConfig;
    state: OrchestratorState;
    root: string;
}
export declare function registerSettingsRoutes(deps: RouteDeps): void;
