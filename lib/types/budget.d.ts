/**
 * 上下文占用测量。
 *
 * 三条证据路径，按可信度排序（与 dsh-context-relay 的 readPressure 同口径）：
 *   1. `sessionProjections.stateOf(session,'contextPressure')` —— 线上可见的
 *      `{ contextWindow, pressureTokens, projectedTokens }`，是 relay 判档的同一份数据；
 *   2. `ctx.tokenMeter.measure(session).totalTokens` —— 本地重放计量（启发式）；
 *   3. 窗口未知时用 `ctx.llm.resolveModelInfo(provider, model)` 补窗口大小。
 *
 * 为什么一定要拿到窗口：百分比阈值只有在「窗口已知」时才有意义；
 * 拿不到窗口就退回 token 绝对值判断（并在状态里注明 basis:'tokens'）。
 */
import type { AgentLike, CtxLike, SessionLike } from './types.js';
export interface Occupancy {
    usedTokens?: number;
    windowTokens?: number;
    /** used / window × 100，保留一位小数。 */
    percent?: number;
    source: 'pressure' | 'meter' | 'unavailable';
    basis: 'ratio' | 'tokens' | 'unavailable';
    /** 窗口大小从哪来：DSH 投影 / 模型声明 / 用户自定值。 */
    windowSource?: 'pressure' | 'model' | 'config' | 'unknown';
    /** DSH 自己读到的窗口（自定值生效时用来对照展示）。 */
    dshWindowTokens?: number;
    /** 自定窗口从哪命中：逐模型 / 全局 / 未命中。 */
    windowOverrideBy?: WindowOverrideSource;
    /** 拿不到占用/窗口时的具体原因（排查用；不参与判档）。 */
    note?: string;
}
/** 把插件 Config 映射成窗口覆盖配置（调用方共用，避免各处重复拼对象）。 */
export declare function windowConfigOf(config: {
    contextWindowByModel?: Record<string, number>;
}): WindowOverrideConfig;
/**
 * 读出「这个会话当前用哪个 provider / 模型」。
 *
 * 唯一可信来源是 `session.requestHeader()` —— 它就是 DSH 下一次请求要用的头，
 * 由 DSH 自己维护（用户在 UI 里换模型后，下一次 pre-step 读到的就是新值）。
 * 新会话还没发过请求时可能为空，此时返回空对象，调用方按「无覆盖」处理。
 */
export declare function sessionModelOf(session: SessionLike | undefined): {
    provider?: string;
    model?: string;
};
/** 窗口覆盖配置（来自插件 Config）。 */
export interface WindowOverrideConfig {
    /** 全局自定窗口（0 = 用 DSH 值）。 */
    override?: number;
    /** 全局自定窗口的模型关键字（空 = 所有模型）。 */
    overrideFor?: string;
    /** 逐模型覆盖：键 `provider/model` 或 `model`。 */
    byModel?: Record<string, number>;
}
export type WindowOverrideSource = 'model-map' | 'global' | 'none';
/**
 * 决定「用哪个窗口大小」。
 *
 * 优先级（从高到低）：
 * 1. `contextWindowByModel['provider/model']` —— 最精确，用户在设置页按模型填的；
 * 2. `contextWindowByModel['model']` —— 同一模型跨 provider 的兜底；
 * 3. 全局 `contextWindowOverride`（配合 `contextWindowOverrideFor` 关键字）；
 * 4. 不覆盖，用 DSH 读到的值。
 *
 * @returns value=0 表示不覆盖；source 说明命中哪一档（状态工具据此解释）。
 */
export declare function decideWindow(config: WindowOverrideConfig, provider: string | undefined, model: string | undefined): {
    value: number;
    source: WindowOverrideSource;
};
/** 测一次占用（带 4s 缓存：pre-step 每个 step 都会问，不能每次都全量 measure）。 */
export declare function measureOccupancy(ctx: CtxLike, agent: AgentLike, windowConfig?: WindowOverrideConfig): Promise<Occupancy>;
/**
 * 判定是否越过阈值。两条线**取先到**：
 * - 百分比线：`thresholdPercent`，只有窗口已知时才有意义；
 * - 绝对 token 线：`thresholdTokens`（0 = 不启用），不依赖窗口大小。
 *
 * 为什么要有 token 线：本地推理服务（llama.cpp 等）常把实际上下文压得比模型声明的窗口小
 * （例如实际 64K、模型声明 200K），此时百分比永远失准；按 token 数判才靠谱。
 */
export declare function crossedThreshold(occupancy: Occupancy, thresholdPercent: number, thresholdTokens?: number): {
    crossed: boolean;
    reason: string;
    by: 'tokens' | 'percent' | 'none';
};
/** 距离阈值还差多少（给状态工具用，便于判断"还要聊多久才会触发"）。 */
export declare function thresholdGap(occupancy: Occupancy, thresholdPercent: number, thresholdTokens?: number): {
    text: string;
};
/** 某个模型是否被"纳入管理"以及它自己的窗口/阈值。 */
export interface ModelPolicy {
    /** 生效窗口（0 = 用 DSH 读到的值）。 */
    window: number;
    windowSource: WindowOverrideSource;
    /** 生效的百分比阈值（0 = 该模型不启用百分比线）。 */
    thresholdPercent: number;
    /**
     * 是否纳入管理：
     * 在 `contextWindowByModel` / `thresholdByModel` 里出现过，或命中了全局 override 关键字。
     * **未纳入管理的模型，插件完全不介入**（不提醒、不换窗）——避免 1M 云端会话被误触发。
     */
    managed: boolean;
}
/**
 * 解析「这个会话当前模型」的窗口与阈值。
 *
 * 优先级：逐模型（provider/model → model）> 全局 override / thresholdPercent。
 * 只出现在全局配置里的模型也算"未按模型配置"，但窗口 override 命中的仍视为纳入管理。
 */
export declare function resolvePolicy(config: {
    contextWindowOverride?: number;
    contextWindowOverrideFor?: string;
    contextWindowByModel?: Record<string, number>;
    thresholdByModel?: Record<string, number>;
    thresholdPercent?: number;
}, session: SessionLike | undefined): ModelPolicy;
export declare function clearOccupancyCache(): void;
/**
 * 让某个会话的占用缓存立刻失效。
 *
 * 为什么必须做：4 秒缓存是为了「每个 step 都测一次」不浪费，但**一步之内也能暴涨**——
 * 实测一个 step 里连读三个文件（合计约 82KB 代码 ≈ 3.5 万 tokens），上下文从 1.4 万跳到约 5 万。
 * 如果下一个 pre-step 仍读到缓存里的 1.4 万，插件就以为只有 22%，不会换窗，
 * 紧接着的请求直接 `400 prompt + max_tokens exceeds n_ctx`。
 * 所以在 step 结束 / 工具结果写入后主动失效，让下一次测量看到真实值。
 */
export declare function invalidateOccupancy(sessionId: string): void;
/** 人读的占用描述（拿不到时带上具体原因）。 */
export declare function formatOccupancy(occupancy: Occupancy): string;
