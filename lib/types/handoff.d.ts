import { type Occupancy } from './budget.js';
import type { PendingBrief } from './checkpoint.js';
import type { OrchestratorConfig } from './config.js';
import type { AgentLike, CtxLike, SessionLike } from './types.js';
/** 插件自有消息 kind：DSH v4 行准入要求「生产者自有 kind」，不能再用已退役的 kind:'plugin'。 */
export declare const PLUGIN_KIND = "dsh-infinite-context-orchestrator";
export interface OrchestratorState {
    /** 单飞锁：一次只允许一个 handoff 在跑。 */
    inFlight: boolean;
    /** 本次 apply 已完成的自动 handoff 次数。 */
    autoHandoffs: number;
    /** 已发过 notice 的会话（升线只提醒一次，避免每 step 刷屏）。 */
    fired: Map<string, {
        at: number;
        percent?: number;
    }>;
    /** 已武装（正在被哨兵监视）的会话。 */
    armed: Set<string>;
    /** 内存里的待注入简报（与磁盘双写：磁盘是为了跨进程/热重载后仍然生效）。 */
    pendingBriefs: Map<string, PendingBrief>;
    /**
     * 换窗后盯新会话的第一条 assistant 消息：
     * 如果它只说话不动手（没有工具调用、且回复很短或只是个问句），补发一次纠正消息。
     * 每个会话只纠正一次。
     */
    firstStepWatch: Map<string, {
        todo: string;
        at: number;
        corrected: boolean;
    }>;
    lastHandoff?: {
        at: number;
        origin: 'auto' | 'manual';
        sessionId: string;
        newSessionId?: string;
        checkpointPath: string;
        briefChars: number;
        /** 交接锚点通过哪种方式送达（developer 消息 / 简报前缀兜底）。 */
        anchorVia?: 'developer' | 'brief-prefix' | 'none';
    };
    lastNotice?: {
        at: number;
        text: string;
    };
}
export declare function createState(): OrchestratorState;
/** 插件 notice（非用户发言）。summary ≤120 字符，UI 单行展示。 */
export declare function noticeMessage(text: string, summary: string): unknown;
export declare function isSubagentSession(session: SessionLike | undefined): boolean;
export declare function setWorkspaceRegistryAccessor(accessor: (() => unknown) | undefined): void;
export type HandoffCode = 'ok' | 'disabled' | 'busy' | 'rate-limited' | 'checkpoint-write-failed' | 'session-create-failed' | 'session-not-live' | 'followup-failed';
export interface HandoffOutcome {
    ok: boolean;
    code: HandoffCode;
    message: string;
    checkpointPath?: string;
    newSessionId?: string;
    briefChars?: number;
    /** 简报实际由谁写：模板或模型（模型失败时是 plugin + briefFallbackReason）。 */
    briefAuthoredBy?: 'plugin' | 'model';
    /** 选了模型撰写但失败时的原因（已回退模板）。 */
    briefFallbackReason?: string;
    /** 交接锚点的送达方式：developer 消息（首选）或简报前缀（兜底）。 */
    anchorVia?: 'developer' | 'brief-prefix' | 'none';
    /** 旧窗口那句「任务已转移」是用 followup（立刻可见）还是 inject（不唤醒）发的。 */
    transferVia?: 'followup' | 'inject';
    /** 是否把旧会话里未完成的待办标成了已完成。 */
    todosMarked?: boolean;
    occupancy?: Occupancy;
    summary: string;
}
export interface HandoffDeps {
    ctx: CtxLike;
    config: OrchestratorConfig;
    state: OrchestratorState;
    root: string;
}
/**
 * 执行完整闭环。调用方负责：origin='auto' 时先确认 enabled / autoHandoff。
 * 任何一步失败都保持当前会话，并把可操作的路径/原因写进返回值与 notice。
 */
export declare function performHandoff(deps: HandoffDeps, caller: AgentLike, origin: 'auto' | 'manual', 
/** 手动触发时可附一句「为什么现在换窗」，会写进检查点 notes。 */
extraNote?: string): Promise<HandoffOutcome>;
/** 向当前会话注入插件 notice；失败不抛（notice 不是关键路径）。 */
export declare function notifyCaller(ctx: CtxLike, caller: AgentLike, text: string, summary: string): void;
/** 解析本次生效的检查点根目录（工具与 notice 共用一个真源）。 */
export declare function checkpointRootOf(config: OrchestratorConfig): string;
